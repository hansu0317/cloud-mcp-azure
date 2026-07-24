import 'dotenv/config'
import express              from 'express'
import rateLimit            from 'express-rate-limit'
import path                 from 'path'
import fs                   from 'fs'
import log                  from './logger'
import { HttpStatus }       from './sse'
import { fetchEntitySchema, dataverseEnvMissing, type SchemaEntry } from './dataverse'
import { registerChatApi, apiStatus } from '../claudeapi/chat-api'
import type { Instructions, LogEntry } from '../shared/types'

// ─── 환경변수 ─────────────────────────────────────────────────────────────────
const PORT                = parseInt(process.env.PORT                  ?? '3000')
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS   ?? '30000')
const RL_WINDOW_MS        = parseInt(process.env.RATE_LIMIT_WINDOW_MS  ?? '60000')
const RL_MAX              = parseInt(process.env.RATE_LIMIT_MAX        ?? '20')
const API_KEY             = process.env.API_KEY ?? ''

const CWD         = process.cwd()
const INST_FILE   = path.join(CWD, 'data', 'instructions.json')
const SCHEMA_FILE = path.join(CWD, 'data', 'schema.json')
const DIST_DIR    = path.join(CWD, 'dist')
const DOCS_DIR    = path.join(CWD, 'docs')

// ─── 유틸 ────────────────────────────────────────────────────────────────────
function readJsonFile<T>(filepath: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(filepath, 'utf8')) as T }
  catch { return fallback }
}

function elapsed(startMs: number): string {
  return ((Date.now() - startMs) / 1000).toFixed(1)
}

const startTime = Date.now()
let schemaRefreshing = false

const schemaCache     = new Map<string, string>()                              // 스키마 텍스트
const schemaMeta      = new Map<string, { label: string; domain: string }>()   // 등록 테이블 전체
const pendingDescribe = new Map<string, Promise<string>>()

// schema.json → 인메모리 카탈로그 동기화 (기동 시 + 갱신 완료 후 공통 호출)
function reloadFromSchemaFile(): void {
  const data = readJsonFile<Record<string, SchemaEntry>>(SCHEMA_FILE, {})
  schemaCache.clear()
  schemaMeta.clear()
  for (const [table, info] of Object.entries(data)) {
    schemaMeta.set(table, { label: info.label ?? table, domain: info.domain ?? '기타' })
    if (info.schema) schemaCache.set(table, info.schema)
  }
  log.info('SCHEMA', `카탈로그 동기화: ${schemaMeta.size}개 테이블 (스키마 로드: ${schemaCache.size}개)`)
}

reloadFromSchemaFile()

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express()
app.set('trust proxy', 1)
app.use(express.json())

// API 키 인증 미들웨어 (API_KEY 설정 시 활성화)
if (API_KEY) {
  app.use('/api', (req, res, next) => {
    const provided = req.headers['x-api-key'] ?? req.query['api_key']
    if (provided !== API_KEY) {
      log.error('AUTH', '인증 실패', { ip: req.ip, path: req.path })
      res.status(HttpStatus.UNAUTHORIZED).json({ error: '인증이 필요합니다. X-API-Key 헤더를 확인하세요.' })
      return
    }
    next()
  })
  log.info('SERVER', 'API 키 인증 활성화됨')
}

const chatLimiter = rateLimit({
  windowMs:        RL_WINDOW_MS,
  max:             RL_MAX,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' },
})
app.use('/api/chat',     chatLimiter)
app.use('/api/describe', chatLimiter)

if (fs.existsSync(DIST_DIR)) app.use(express.static(DIST_DIR))
if (fs.existsSync(DOCS_DIR)) app.use('/docs', express.static(DOCS_DIR))

// ─── API: 스키마 갱신 ─────────────────────────────────────────────────────────
app.post('/api/schemas/refresh', async (_req, res) => {
  if (schemaRefreshing) { res.json({ updated: 0, tables: [], message: '갱신이 이미 진행 중입니다.' }); return }

  const data   = readJsonFile<Record<string, SchemaEntry>>(SCHEMA_FILE, {})
  const tables = Object.keys(data)
  if (tables.length === 0) { res.json({ updated: 0, tables: [] }); return }

  schemaRefreshing = true
  log.info('SCHEMA', `갱신 시작 — ${tables.length}개 테이블 배치 병렬 조회(Dataverse REST, LLM 미사용): ${tables.join(', ')}`)

  const totalStart = Date.now()
  const REFRESH_BATCH_SIZE = 6   // 한꺼번에 전체 병렬 호출 시 커넥션 과부하로 간헐적 fetch 실패 발생 → 배치로 제한
  const outcomes: PromiseSettledResult<void>[] = []
  // describeTable()이 테이블별로 schema.json에 직접 저장하므로 여기서 별도 파일 쓰기는 하지 않음
  // (하지 않으면 이 시점의 낡은 스냅샷으로 entitySetName 등이 덮어써질 수 있음).
  for (let i = 0; i < tables.length; i += REFRESH_BATCH_SIZE) {
    const batch = tables.slice(i, i + REFRESH_BATCH_SIZE)
    const batchOutcomes = await Promise.allSettled(batch.map(async table => {
      const t0 = Date.now()
      await describeTable(table)
      log.info('SCHEMA', `${table} 완료 (${elapsed(t0)}초)`)
    }))
    outcomes.push(...batchOutcomes)
  }

  const results = tables.filter((_, i) => outcomes[i].status === 'fulfilled')
  outcomes.forEach((o, i) => {
    if (o.status === 'rejected') log.error('SCHEMA', `${tables[i]} 실패`, { error: String(o.reason) })
  })

  log.info('SCHEMA', `갱신 완료 — ${results.length}/${tables.length}개 성공 (총 ${elapsed(totalStart)}초)`)
  reloadFromSchemaFile()   // schema.json → 인메모리 카탈로그 전체 재동기화
  schemaRefreshing = false
  res.json({ updated: results.length, tables: results })
})

// ─── API: 테이블 목록 ─────────────────────────────────────────────────────────
app.get('/api/tables', (_req, res) => {
  const tables = [...schemaMeta.entries()].map(([name, meta]) => ({
    name, label: meta.label, domain: meta.domain,
  }))
  res.json({ tables })
})

// ─── 테이블 스키마 조회 (Dataverse Web API EntityDefinitions 직접 호출 — LLM 미사용) ──
async function describeTable(table: string): Promise<string> {
  const missing = dataverseEnvMissing()
  if (missing) throw new Error(`${missing} 환경변수가 설정되지 않았습니다. (.env 확인)`)

  const { entitySetName, markdown } = await fetchEntitySchema(table)

  schemaCache.set(table, markdown)
  const existing = readJsonFile<Record<string, SchemaEntry>>(SCHEMA_FILE, {})
  existing[table] = { ...existing[table], schema: markdown, entitySetName, updatedAt: new Date().toISOString() }
  try { fs.writeFileSync(SCHEMA_FILE, JSON.stringify(existing, null, 2)) } catch { /* 무시 */ }
  if (!schemaMeta.has(table)) {
    schemaMeta.set(table, { label: existing[table].label ?? table, domain: existing[table].domain ?? '기타' })
  }
  return markdown
}

// ─── API: 테이블 스키마 describe ─────────────────────────────────────────────
app.get('/api/describe', (req, res) => {
  const table = req.query.table as string | undefined
  if (!table) { res.status(HttpStatus.BAD_REQUEST).json({ error: 'table 파라미터 필요' }); return }
  if (schemaCache.has(table)) { res.json({ schema: schemaCache.get(table), cached: true }); return }

  // 동일 테이블 동시 요청은 하나의 조회에 합류
  const pending = pendingDescribe.get(table)
  const p = pending ?? describeTable(table)
  if (!pending) {
    pendingDescribe.set(table, p)
    p.finally(() => pendingDescribe.delete(table))
  }

  p.then(schema => { if (!res.writableEnded) res.json({ schema, cached: false }) })
   .catch(err   => { if (!res.writableEnded) res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: (err as Error).message }) })
})

// ─── API: 지침 ────────────────────────────────────────────────────────────────
function readInstructions(): Instructions {
  return readJsonFile<Instructions>(INST_FILE, { joins: [], terms: [], examples: [] })
}

app.get('/api/instructions',  (_req, res) => res.json(readInstructions()))
app.post('/api/instructions', (req, res) => {
  try {
    fs.writeFileSync(INST_FILE, JSON.stringify(req.body, null, 2))
    res.json({ ok: true })
  } catch (err) {
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: (err as Error).message })
  }
})

// ─── API: 로그 조회 ───────────────────────────────────────────────────────────
app.get('/api/logs', (req, res) => {
  const n       = Math.min(parseInt(req.query.n as string) || 100, 200)
  const logPath = path.join(CWD, 'logs', 'app.log')
  if (!fs.existsSync(logPath)) { res.json([]); return }
  try {
    const entries = fs.readFileSync(logPath, 'utf8')
      .trim().split('\n').filter(Boolean).slice(-n).reverse()
      .map(line => { try { return JSON.parse(line) as LogEntry } catch { return null } })
      .filter(Boolean)
    res.json(entries)
  } catch (err) {
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: (err as Error).message })
  }
})

// ─── API: 헬스체크 (모니터링·기동 확인용) ────────────────────────────────────
// curl http://localhost:3000/api/health 한 줄로 가용 상태를 확인한다.
app.get('/api/health', (_req, res) => {
  const dvMissing = dataverseEnvMissing()
  res.json({
    ok:           true,
    uptime:       Math.floor((Date.now() - startTime) / 1000),
    schemaTables: schemaMeta.size,
    chat: {
      enabled: Boolean(process.env.ANTHROPIC_API_KEY) && !dvMissing,
      ...(dvMissing ? { missingEnv: dvMissing } : {}),
      ...apiStatus(),
    },
  })
})

// ─── 채팅 엔드포인트 (Claude API + Dataverse Web API) ─────────────────────────
if (process.env.ANTHROPIC_API_KEY) {
  registerChatApi(app)
} else {
  log.error('SERVER', 'ANTHROPIC_API_KEY 미설정 — 채팅(/api/chat) 비활성. .env를 확인하세요.')
}

// ─── SPA 폴백 ─────────────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  const indexPath = path.join(DIST_DIR, 'index.html')
  if (fs.existsSync(indexPath)) res.sendFile(indexPath)
  else res.status(HttpStatus.SERVICE_UNAVAILABLE).send('프론트엔드 빌드가 없습니다. npm run build 를 실행하세요.')
})

// ─── 서버 기동 ────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  log.info('SERVER', `Quali CRM Chat 서버 기동 — http://localhost:${PORT}`)
  console.log(`\n${'━'.repeat(40)}`)
  console.log(`  Quali CRM Chat 서버 실행 중`)
  console.log(`  http://localhost:${PORT}`)
  console.log(`  Rate-limit: ${RL_MAX}req/${RL_WINDOW_MS / 1000}s`)
  console.log(`${'━'.repeat(40)}\n`)
})

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
function gracefulShutdown(signal: string) {
  log.info('SERVER', `${signal} 수신 — graceful shutdown 시작`)
  server.close(() => {
    log.info('SERVER', '모든 연결 종료 — 프로세스 정상 종료')
    process.exit(0)
  })
  setTimeout(() => { log.error('SERVER', '강제 종료'); process.exit(1) }, SHUTDOWN_TIMEOUT_MS)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT',  () => gracefulShutdown('SIGINT'))

// ─── 프로세스 레벨 안전망 ─────────────────────────────────────────────────────
// 처리되지 않은 예외/거부로 서버가 소리 없이 죽는 것을 방지한다.
// - unhandledRejection: 로그만 남기고 계속 동작 (요청 단위 오류는 각 라우트에서 이미 처리)
// - uncaughtException: 상태를 신뢰할 수 없으므로 로그 후 graceful shutdown
//   (server.sh/pm2가 재기동 담당 — 좀비 상태로 계속 도는 것보다 안전)
process.on('unhandledRejection', (reason) => {
  log.error('SERVER', 'Unhandled rejection', { error: String(reason) })
})
process.on('uncaughtException', (err) => {
  log.error('SERVER', 'Uncaught exception — 서버를 안전 종료합니다', { error: err.stack ?? String(err) })
  gracefulShutdown('uncaughtException')
})
