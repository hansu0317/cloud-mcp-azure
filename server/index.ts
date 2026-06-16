import 'dotenv/config'
import express              from 'express'
import rateLimit            from 'express-rate-limit'
import { spawn }            from 'child_process'
import { randomUUID }       from 'crypto'
import path                 from 'path'
import fs                   from 'fs'
import log                  from './logger'
import { setupSse, HttpStatus } from './sse'
import { CLAUDE_BIN, buildClaudeArgs } from './claude'
import type { Instructions, LogEntry, ServerStats } from '../shared/types'

// ─── 보안: Azure Dataverse 쓰기 도구 차단 목록 ────────────────────────────────
const WRITE_TOOLS = new Set([
  'mcp__dataverse__create_record',
  'mcp__dataverse__update_record',
  'mcp__dataverse__delete_record',
  'mcp__dataverse__create_table',
  'mcp__dataverse__update_table',
  'mcp__dataverse__delete_table',
  'mcp__dataverse__upsert_skill',
  'mcp__dataverse__delete_skill',
  'mcp__dataverse__create_skill_resource',
  'mcp__dataverse__init_file_upload',
  'mcp__dataverse__commit_file_upload',
])

// ─── 환경변수 ─────────────────────────────────────────────────────────────────
const PORT                = parseInt(process.env.PORT                  ?? '3000')
const CHAT_TIMEOUT_MS     = parseInt(process.env.CHAT_TIMEOUT_MS       ?? '120000')
const DESCRIBE_TIMEOUT_MS = parseInt(process.env.DESCRIBE_TIMEOUT_MS   ?? '60000')
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS   ?? '30000')
const RL_WINDOW_MS        = parseInt(process.env.RATE_LIMIT_WINDOW_MS  ?? '60000')
const RL_MAX              = parseInt(process.env.RATE_LIMIT_MAX        ?? '20')
const MAX_CONCURRENT      = parseInt(process.env.MAX_CONCURRENT_CLAUDE ?? '5')
const MAX_SESSIONS        = parseInt(process.env.MAX_SESSIONS          ?? '200')
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

// ─── 동시 접속 세마포어 ───────────────────────────────────────────────────────
class Semaphore {
  private active  = 0
  private queue: Array<() => void> = []

  constructor(private max: number) {}

  acquire(): Promise<void> {
    return new Promise(resolve => {
      if (this.active < this.max) { this.active++; resolve() }
      else this.queue.push(resolve)
    })
  }

  release(): void {
    const next = this.queue.shift()
    if (next) next()
    else this.active--
  }

  get size()    { return this.active }
  get pending() { return this.queue.length }

  // 활성 + 대기가 모두 꽉 찬 경우 (즉시 거절 기준)
  isOverloaded(): boolean {
    return this.active >= this.max && this.queue.length >= this.max * 2
  }
}

const claudeSemaphore  = new Semaphore(MAX_CONCURRENT)
let   schemaRefreshing = false

// ─── 상태 ─────────────────────────────────────────────────────────────────────
const stats: ServerStats & { startTime: number } = {
  startTime: Date.now(), sessions: 0, queries: 0, toolCalls: 0,
  securityBlocks: 0, uptime: 0, activeSessions: 0,
}

interface SchemaEntry { label?: string; domain?: string; schema?: string; updatedAt?: string }
const schemaCache     = new Map<string, string>()
const schemaMeta      = new Map<string, { label: string; domain: string }>()
const pendingDescribe = new Map<string, Promise<string>>()

interface SessionEntry { claudeSessionId: string; lastUsed: number }
const sessionMap     = new Map<string, SessionEntry>()
const SESSION_TTL_MS = 24 * 60 * 60 * 1000

// 만료·초과 세션 정리 (매 1시간)
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS
  let removed  = 0
  for (const [id, entry] of sessionMap) {
    if (entry.lastUsed < cutoff) { sessionMap.delete(id); removed++ }
  }
  if (sessionMap.size > MAX_SESSIONS) {
    const sorted = [...sessionMap.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    const excess = sessionMap.size - MAX_SESSIONS
    for (let i = 0; i < excess; i++) { sessionMap.delete(sorted[i][0]); removed++ }
  }
  if (removed) log.info('SESSION', `세션 정리: ${removed}개 삭제 (현재: ${sessionMap.size})`)
}, 60 * 60 * 1000).unref()

// 스키마 파일 캐시 초기 로드
;(function loadSchemaCache() {
  const data = readJsonFile<Record<string, SchemaEntry>>(SCHEMA_FILE, {})
  for (const [table, info] of Object.entries(data)) {
    if (info?.schema) schemaCache.set(table, info.schema)
    if (info?.label || info?.domain)
      schemaMeta.set(table, { label: info.label ?? table, domain: info.domain ?? '기타' })
  }
  if (schemaCache.size) log.info('SCHEMA', `파일 캐시 로드: ${schemaCache.size}개 테이블`)
})()

// 채팅 첫 메시지에 주입할 스키마 컨텍스트
function buildSchemaContext(): string {
  if (schemaCache.size === 0) return ''
  const lines = ['[Dataverse 테이블 스키마 — 아래 정보를 기반으로 OData 쿼리를 작성하세요]']
  for (const [table, schema] of schemaCache) {
    const meta = schemaMeta.get(table)
    lines.push(`\n## ${table}${meta ? ` (${meta.label})` : ''}`)
    lines.push(schema)
  }
  return lines.join('\n')
}

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

  log.info('SCHEMA', `갱신 시작 — ${tables.length}개 테이블: ${tables.join(', ')}`)
  schemaCache.clear()
  schemaMeta.clear()

  const results: string[] = []
  const totalStart = Date.now()
  for (const [i, table] of tables.entries()) {
    log.info('SCHEMA', `[${i + 1}/${tables.length}] ${table} 조회 중…`)
    const t0 = Date.now()
    try {
      const schema = await spawnDescribe(table)
      const meta   = data[table]
      if (meta?.label || meta?.domain) schemaMeta.set(table, { label: meta.label ?? table, domain: meta.domain ?? '기타' })
      results.push(table)
      log.info('SCHEMA', `[${i + 1}/${tables.length}] ${table} 완료 (${elapsed(t0)}초)`)
      data[table] = { ...data[table], schema, updatedAt: new Date().toISOString() }
    } catch (e) {
      log.error('SCHEMA', `[${i + 1}/${tables.length}] ${table} 실패 (${elapsed(t0)}초)`, { error: String(e) })
    }
  }

  log.info('SCHEMA', `갱신 완료 — ${results.length}/${tables.length}개 성공 (총 ${elapsed(totalStart)}초)`)
  schemaRefreshing = false
  try { fs.writeFileSync(SCHEMA_FILE, JSON.stringify(data, null, 2)) } catch { /* 무시 */ }
  res.json({ updated: results.length, tables: results })
})

// ─── API: 테이블 목록 ─────────────────────────────────────────────────────────
app.get('/api/tables', (_req, res) => {
  const tables = [...schemaMeta.entries()]
    .filter(([name]) => schemaCache.has(name))
    .map(([name, meta]) => ({ name, label: meta.label, domain: meta.domain }))
  res.json({ tables })
})

// ─── API: 세션 발급 ───────────────────────────────────────────────────────────
app.post('/api/session/new', (_req, res) => {
  const sessionId = randomUUID()
  stats.sessions++
  log.info('SESSION', '새 세션 생성', { sessionId })
  res.json({ sessionId })
})

// ─── API: 채팅 (SSE 스트리밍 — Claude Code + MCP) ────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { message, sessionId } = req.body as { message: string; sessionId: string }

  if (!message || !sessionId) {
    res.status(HttpStatus.BAD_REQUEST).json({ error: 'message와 sessionId가 필요합니다.' })
    return
  }

  if (claudeSemaphore.isOverloaded()) {
    res.status(HttpStatus.TOO_MANY_REQUESTS).json({ error: '현재 요청이 많습니다. 잠시 후 다시 시도하세요.' })
    return
  }

  stats.queries++
  const rawQ    = message.includes('\n\n') ? message.split('\n\n').slice(1).join('\n\n').trim() : message
  const startMs = Date.now()
  const queryLog: { tool: string; input: Record<string, unknown> }[] = []
  log.info('질문', rawQ.slice(0, 300))

  // 새 세션 첫 메시지에만 스키마 컨텍스트 주입
  const isNewSession   = !sessionMap.has(sessionId)
  const finalMessage   = isNewSession && schemaCache.size > 0
    ? `${buildSchemaContext()}\n\n${message}`
    : message

  const send = setupSse(res)

  await claudeSemaphore.acquire()

  const entry = sessionMap.get(sessionId)
  if (entry) entry.lastUsed = Date.now()

  const claude = spawn(CLAUDE_BIN, buildClaudeArgs(finalMessage, { resume: entry?.claudeSessionId }), {
    cwd: CWD, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
  })

  let semReleased = false
  const releaseSem = () => { if (!semReleased) { semReleased = true; claudeSemaphore.release() } }

  claude.stdout.setEncoding('utf8')
  claude.stderr.setEncoding('utf8')

  let buffer       = ''
  let lastText     = ''
  let newSessionId = ''
  let finished     = false
  let toolCallCount = 0

  const timeoutId = setTimeout(() => {
    if (!finished) {
      log.error('타임아웃', `응답 초과 (${CHAT_TIMEOUT_MS / 1000}초)`, { sessionId })
      finished = true
      send({ type: 'error', message: '응답 시간이 초과되었습니다. 다시 시도해주세요.' })
      claude.kill()
      if (!res.writableEnded) res.end()
    }
  }, CHAT_TIMEOUT_MS)

  const cleanup = () => clearTimeout(timeoutId)

  claude.stdout.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>

        if (event.type === 'system' && event.subtype === 'init') {
          newSessionId = event.session_id as string
        }

        if (event.type === 'assistant') {
          const content = ((event.message as Record<string, unknown>)?.content ?? []) as Array<Record<string, unknown>>
          for (const block of content) {
            if (block.type === 'text') {
              const text = block.text as string
              if (text.length > lastText.length) {
                send({ type: 'text', text: text.slice(lastText.length) })
                lastText = text
              }
            } else if (block.type === 'tool_use') {
              const name = block.name as string
              if (WRITE_TOOLS.has(name)) {
                stats.securityBlocks++
                log.error('SECURITY', `쓰기 도구 차단: ${name}`, { sessionId })
                send({ type: 'error', message: `⛔ Azure 데이터 변경 작업은 허용되지 않습니다. (${name})` })
                finished = true; cleanup(); claude.kill()
                if (!res.writableEnded) res.end()
                return
              }
              stats.toolCalls++
              toolCallCount++
              const toolName   = name.replace('mcp__dataverse__', '')
              const toolInput  = (block.input ?? {}) as Record<string, unknown>
              queryLog.push({ tool: toolName, input: toolInput })
              const queryPreview = String(toolInput.querytext ?? toolInput.fetchXml ?? JSON.stringify(toolInput))
              log.info('쿼리', `[${toolName}] ${queryPreview.slice(0, 200)}`)
              send({ type: 'tool', name: toolName })
              if (Object.keys(toolInput).length > 0) send({ type: 'query', tool: toolName, input: toolInput })
            }
          }
        }

        if (event.type === 'result') {
          if (newSessionId) sessionMap.set(sessionId, { claudeSessionId: newSessionId, lastUsed: Date.now() })
          if (!finished) {
            finished = true; cleanup()
            log.info('답변', `${lastText.slice(0, 300)} (${elapsed(startMs)}초, 쿼리 ${queryLog.length}회)`)
            send({ type: 'done' })
          }
        }
      } catch { /* JSON 파싱 불가 줄 무시 */ }
    }
  })

  claude.stderr.on('data', (data: string) => {
    const text    = data.trim()
    const benign  = /warning|deprecat|experimental|^\(use\s|^node:/i.test(text)
    if (text && !benign) log.error('오류', text.slice(0, 300), { sessionId })
  })

  claude.on('close', () => {
    releaseSem()
    cleanup()
    if (!finished) send({ type: 'done' })
    if (!res.writableEnded) res.end()
  })

  claude.on('error', (err: Error) => {
    releaseSem()
    cleanup()
    log.error('오류', `Claude 실행 실패: ${err.message}`, { sessionId })
    send({ type: 'error', message: `Claude 실행 오류: ${err.message}` })
    if (!res.writableEnded) res.end()
  })

  res.on('close', () => { cleanup(); if (!claude.killed) claude.kill() })
})

// ─── 테이블 스키마 describe (Claude Code → mcp__dataverse__describe) ──────────
function spawnDescribe(table: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const prompt = `Dataverse 테이블 "${table}"을 describe 도구로 조회한 뒤, 주요 컬럼명·타입·한국어 설명을 마크다운 표로 간결하게 정리해줘. 표만 출력해.`
    const claude = spawn(
      CLAUDE_BIN,
      buildClaudeArgs(prompt, { allowedTools: 'mcp__dataverse__describe' }),
      { cwd: CWD, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: process.env }
    )

    let lastText = '', buf = ''
    claude.stdout.setEncoding('utf8')
    claude.stdout.on('data', (chunk: string) => {
      buf += chunk
      const lines = buf.split('\n'); buf = lines.pop() ?? ''
      for (const line of lines) {
        try {
          const ev = JSON.parse(line.trim()) as Record<string, unknown>
          if (ev.type === 'assistant') {
            for (const block of ((ev.message as Record<string, unknown>)?.content as Array<Record<string, unknown>> ?? [])) {
              if (block.type === 'text' && (block.text as string).length > lastText.length)
                lastText = block.text as string
            }
          }
        } catch { /* 무시 */ }
      }
    })

    const timer = setTimeout(() => { if (!claude.killed) claude.kill() }, DESCRIBE_TIMEOUT_MS)
    claude.on('close', () => {
      clearTimeout(timer)
      if (!lastText) { reject(new Error('스키마 조회 결과가 없습니다.')); return }
      schemaCache.set(table, lastText)
      const existing = readJsonFile<Record<string, SchemaEntry>>(SCHEMA_FILE, {})
      existing[table] = { ...existing[table], schema: lastText, updatedAt: new Date().toISOString() }
      try { fs.writeFileSync(SCHEMA_FILE, JSON.stringify(existing, null, 2)) } catch { /* 무시 */ }
      resolve(lastText)
    })
    claude.on('error', (err: Error) => { clearTimeout(timer); reject(err) })
  })
}

// ─── API: 테이블 스키마 describe ─────────────────────────────────────────────
app.get('/api/describe', (req, res) => {
  const table = req.query.table as string | undefined
  if (!table) { res.status(HttpStatus.BAD_REQUEST).json({ error: 'table 파라미터 필요' }); return }
  if (schemaCache.has(table)) { res.json({ schema: schemaCache.get(table), cached: true }); return }

  // 동일 테이블 동시 요청은 하나의 프로세스에 합류
  const pending = pendingDescribe.get(table)
  const p = pending ?? spawnDescribe(table)
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

// ─── API: 서버 통계 ───────────────────────────────────────────────────────────
app.get('/api/stats', (_req, res) => {
  res.json({
    uptime:          Math.floor((Date.now() - stats.startTime) / 1000),
    sessions:        stats.sessions,
    queries:         stats.queries,
    toolCalls:       stats.toolCalls,
    securityBlocks:  stats.securityBlocks,
    activeSessions:  sessionMap.size,
    activeProcs:     claudeSemaphore.size,
    maxProcs:        MAX_CONCURRENT,
    queuedRequests:  claudeSemaphore.pending,
  } satisfies ServerStats)
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

// ─── 유틸: 경과 시간(초) 문자열 ──────────────────────────────────────────────
function elapsed(startMs: number): string {
  return ((Date.now() - startMs) / 1000).toFixed(1)
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
  console.log(`  타임아웃: ${CHAT_TIMEOUT_MS / 1000}s  Rate-limit: ${RL_MAX}req/${RL_WINDOW_MS / 1000}s`)
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
