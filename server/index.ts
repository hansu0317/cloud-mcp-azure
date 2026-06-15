import 'dotenv/config'
import express              from 'express'
import rateLimit            from 'express-rate-limit'
import { spawn }            from 'child_process'
import { randomUUID }       from 'crypto'
import path                 from 'path'
import fs                   from 'fs'
import http                 from 'http'
import log                  from './logger'
import type { Instructions, LogEntry, ServerStats } from '../shared/types'
import { groqChat }         from './groq'

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
const PORT                = parseInt(process.env.PORT                 ?? '3000')
const CHAT_TIMEOUT_MS     = parseInt(process.env.CHAT_TIMEOUT_MS      ?? '120000')
const DESCRIBE_TIMEOUT_MS = parseInt(process.env.DESCRIBE_TIMEOUT_MS  ?? '60000')
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS  ?? '30000')
const RL_WINDOW_MS        = parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000')
const RL_MAX              = parseInt(process.env.RATE_LIMIT_MAX       ?? '20')
const MAX_CONCURRENT      = parseInt(process.env.MAX_CONCURRENT_CLAUDE ?? '5')
const MAX_SESSIONS        = parseInt(process.env.MAX_SESSIONS          ?? '200')
const API_KEY             = process.env.API_KEY ?? ''  // 비어 있으면 인증 미적용

const CWD         = process.cwd()  // npm start / PM2 모두 프로젝트 루트에서 실행
const INST_FILE   = path.join(CWD, 'data', 'instructions.json')
const SCHEMA_FILE = path.join(CWD, 'data', 'schema.json')
const DIST_DIR    = path.join(CWD, 'dist')
const DOCS_DIR    = path.join(CWD, 'docs')

const CLAUDE_BIN = process.platform === 'win32'
  ? path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
  : 'claude'

// ─── 동시 접속 세마포어 (M2) ──────────────────────────────────────────────────
let activeClaudeProcs = 0
const concurrentQueue: Array<() => void> = []

function acquireSemaphore(): Promise<void> {
  return new Promise(resolve => {
    if (activeClaudeProcs < MAX_CONCURRENT) { activeClaudeProcs++; resolve() }
    else concurrentQueue.push(resolve)
  })
}

function releaseSemaphore() {
  const next = concurrentQueue.shift()
  if (next) { next() }
  else { activeClaudeProcs-- }
}

// ─── 상태 ─────────────────────────────────────────────────────────────────────
const stats: ServerStats & { startTime: number } = {
  startTime: Date.now(), sessions: 0, queries: 0, toolCalls: 0,
  securityBlocks: 0, uptime: 0, activeSessions: 0,
}
interface SchemaEntry { label?: string; domain?: string; schema?: string; updatedAt?: string }
const schemaCache    = new Map<string, string>()
const schemaMeta     = new Map<string, { label: string; domain: string }>()
const pendingDescribe = new Map<string, Promise<string>>()  // 중복 describe 방지

interface SessionEntry { claudeSessionId: string; lastUsed: number }
const sessionMap     = new Map<string, SessionEntry>()  // 웹UUID → { claudeSessionId, lastUsed }
const SESSION_TTL_MS = 24 * 60 * 60 * 1000  // 24시간

// 만료 세션 + 초과 세션 정리 (매 1시간)
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS
  let removed = 0
  for (const [id, entry] of sessionMap) {
    if (entry.lastUsed < cutoff) { sessionMap.delete(id); removed++ }
  }
  // 세션 맵이 MAX_SESSIONS 초과 시 가장 오래된 것부터 정리
  if (sessionMap.size > MAX_SESSIONS) {
    const sorted = [...sessionMap.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    const excess = sessionMap.size - MAX_SESSIONS
    for (let i = 0; i < excess; i++) { sessionMap.delete(sorted[i][0]); removed++ }
  }
  if (removed) log.info('SESSION', `세션 정리: ${removed}개 삭제 (현재: ${sessionMap.size})`)
}, 60 * 60 * 1000).unref()

// 스키마 캐시 파일 로드
;(function loadSchemaCache() {
  try {
    const data = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8')) as Record<string, SchemaEntry>
    for (const [table, info] of Object.entries(data)) {
      if (info?.schema) schemaCache.set(table, info.schema)
      if (info?.label || info?.domain) schemaMeta.set(table, { label: info.label ?? table, domain: info.domain ?? '기타' })
    }
    if (schemaCache.size) log.info('SCHEMA', `파일 캐시 로드: ${schemaCache.size}개 테이블`)
  } catch { /* 파일 없으면 무시 */ }
})()

// 채팅 첫 메시지에 주입할 스키마 컨텍스트 생성
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
app.set('trust proxy', 1)  // nginx 리버스 프록시 뒤에서 실제 클라이언트 IP 추출
app.use(express.json())

// ─── API 키 인증 미들웨어 (M1) ── API_KEY 설정 시 활성화 ────────────────────
if (API_KEY) {
  app.use('/api', (req, res, next) => {
    const provided = req.headers['x-api-key'] ?? req.query['api_key']
    if (provided !== API_KEY) {
      log.error('AUTH', '인증 실패', { ip: req.ip, path: req.path })
      res.status(401).json({ error: '인증이 필요합니다. X-API-Key 헤더를 확인하세요.' })
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
app.use('/api/describe', chatLimiter)  // describe도 Claude 프로세스를 spawn하므로 제한 필요

if (fs.existsSync(DIST_DIR)) app.use(express.static(DIST_DIR))
if (fs.existsSync(DOCS_DIR)) app.use('/docs', express.static(DOCS_DIR))

// ─── fastmcp 프록시 (PostgreSQL 모드) ────────────────────────────────────────
const FASTMCP_PORT = parseInt(process.env.FASTMCP_PORT ?? '8000')

const FASTMCP_TIMEOUT_MS = parseInt(process.env.FASTMCP_TIMEOUT_MS ?? '120000')

function proxyToFastmcp(path: string, req: express.Request, res: express.Response) {
  const body = JSON.stringify(req.body)
  const proxyReq = http.request(
    { hostname: 'localhost', port: FASTMCP_PORT, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: FASTMCP_TIMEOUT_MS },
    (proxyRes) => {
      proxyRes.headers['content-type'] && res.setHeader('Content-Type', proxyRes.headers['content-type'])
      proxyRes.headers['cache-control'] && res.setHeader('Cache-Control', proxyRes.headers['cache-control'])
      proxyRes.headers['x-accel-buffering'] && res.setHeader('X-Accel-Buffering', proxyRes.headers['x-accel-buffering'] as string)
      res.status(proxyRes.statusCode ?? 200)
      if ((proxyRes.headers['content-type'] ?? '').includes('event-stream')) res.flushHeaders()
      proxyRes.pipe(res)
    }
  )
  proxyReq.on('timeout', () => {
    proxyReq.destroy()
    if (!res.writableEnded) {
      res.setHeader('Content-Type', 'text/event-stream')
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'PostgreSQL 서버 응답 시간 초과' })}\n\n`)
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
      res.end()
    }
  })
  proxyReq.on('error', (err) => {
    if (!res.writableEnded) {
      res.setHeader('Content-Type', 'text/event-stream')
      res.write(`data: ${JSON.stringify({ type: 'error', message: `PostgreSQL 서버 연결 실패: ${err.message}` })}\n\n`)
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
      res.end()
    }
  })
  proxyReq.write(body)
  proxyReq.end()
}

app.post('/api/sql/chat',        (req, res) => proxyToFastmcp('/api/sql/chat', req, res))
app.post('/api/sql/session/new', (req, res) => proxyToFastmcp('/api/session/new', req, res))

// ─── API: 스키마 갱신 (schema.json의 모든 테이블 재조회) ─────────────────────
app.post('/api/schemas/refresh', async (_req, res) => {
  let data: Record<string, SchemaEntry> = {}
  try { data = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8')) } catch { /* 없으면 빈 객체 */ }

  const tables = Object.keys(data)
  if (tables.length === 0) { res.json({ updated: 0, tables: [] }); return }

  log.info('SCHEMA', `갱신 시작 — ${tables.length}개 테이블: ${tables.join(', ')}`)

  // schemaCache 초기화 후 순차 재조회
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
      const sec = ((Date.now() - t0) / 1000).toFixed(1)
      log.info('SCHEMA', `[${i + 1}/${tables.length}] ${table} 완료 (${sec}초)`)
      // label/domain 보존하며 schema만 교체
      data[table] = { ...data[table], schema, updatedAt: new Date().toISOString() }
    } catch (e) {
      const sec = ((Date.now() - t0) / 1000).toFixed(1)
      log.error('SCHEMA', `[${i + 1}/${tables.length}] ${table} 실패 (${sec}초)`, { error: String(e) })
    }
  }

  const totalSec = ((Date.now() - totalStart) / 1000).toFixed(1)
  log.info('SCHEMA', `갱신 완료 — ${results.length}/${tables.length}개 성공 (총 ${totalSec}초)`)

  try { fs.writeFileSync(SCHEMA_FILE, JSON.stringify(data, null, 2)) } catch { /* 무시 */ }
  res.json({ updated: results.length, tables: results })
})

// ─── API: 테이블 목록 (동적 — schema.json 기반) ───────────────────────────────
app.get('/api/tables', (_req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8')) as Record<string, SchemaEntry>
    const tables = Object.entries(data)
      .filter(([, v]) => v.schema)
      .map(([name, v]) => ({ name, label: v.label ?? name, domain: v.domain ?? '기타' }))
    res.json({ tables })
  } catch {
    res.json({ tables: [] })
  }
})

// ─── API: 세션 발급 ───────────────────────────────────────────────────────────
app.post('/api/session/new', (_req, res) => {
  const sessionId = randomUUID()
  stats.sessions++
  log.info('SESSION', '새 세션 생성', { sessionId })
  res.json({ sessionId })
})

// ─── API: 채팅 (SSE 스트리밍) ─────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { message, sessionId, cellType = 'chat' } = req.body as {
    message: string; sessionId: string; cellType?: string
  }

  if (!message || !sessionId) {
    res.status(400).json({ error: 'message와 sessionId가 필요합니다.' })
    return
  }

  if (cellType === 'sql_cell') {
    res.status(501).json({ error: 'SQL 직접 실행은 아직 미구현입니다.' })
    return
  }

  // 동시 접속 제한 (M2)
  if (activeClaudeProcs >= MAX_CONCURRENT && concurrentQueue.length >= MAX_CONCURRENT * 2) {
    res.status(429).json({ error: '현재 요청이 많습니다. 잠시 후 다시 시도하세요.' })
    return
  }

  stats.queries++
  const rawQ     = message.includes('\n\n') ? message.split('\n\n').slice(1).join('\n\n').trim() : message
  const startMs  = Date.now()
  const queryLog: { tool: string; input: Record<string, unknown> }[] = []

  log.info('질문', rawQ.slice(0, 300))

  // 새 세션 첫 메시지에 스키마 컨텍스트 주입
  const isNewSession = !sessionMap.has(sessionId)
  const finalMessage = isNewSession && schemaCache.size > 0
    ? `${buildSchemaContext()}\n\n${message}`
    : message

  res.setHeader('Content-Type',       'text/event-stream')
  res.setHeader('Cache-Control',      'no-cache')
  res.setHeader('Connection',         'keep-alive')
  res.setHeader('X-Accel-Buffering',  'no')
  res.flushHeaders()

  await acquireSemaphore()

  const args = [
    '-p', finalMessage,
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
  ]

  const entry = sessionMap.get(sessionId)
  if (entry) {
    args.push('--resume', entry.claudeSessionId)
    entry.lastUsed = Date.now()
  }

  const claude = spawn(CLAUDE_BIN, args, {
    cwd: CWD, shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })

  claude.stdout.setEncoding('utf8')
  claude.stderr.setEncoding('utf8')

  let buffer        = ''
  let lastText      = ''
  let newSessionId  = ''
  let finished      = false
  let toolCallCount = 0

  const send = (data: object) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`)
  }

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
          const content = (event.message as Record<string, unknown>)?.content as Array<Record<string, unknown>> ?? []
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
              const toolName  = name.replace('mcp__dataverse__', '')
              const toolInput = (block.input ?? {}) as Record<string, unknown>
              queryLog.push({ tool: toolName, input: toolInput })
              const queryPreview = (toolInput.querytext ?? toolInput.fetchXml ?? JSON.stringify(toolInput)) as string
              log.info('쿼리', `[${toolName}] ${String(queryPreview).slice(0, 200)}`)
              send({ type: 'tool', name: toolName })
              if (Object.keys(toolInput).length > 0) {
                send({ type: 'query', tool: toolName, input: toolInput })
              }
            }
          }
        }

        if (event.type === 'result') {
          if (newSessionId) sessionMap.set(sessionId, { claudeSessionId: newSessionId, lastUsed: Date.now() })
          if (!finished) {
            finished = true; cleanup()
            const durationSec = ((Date.now() - startMs) / 1000).toFixed(1)
            log.info('답변', `${lastText.slice(0, 300)} (${durationSec}초, 쿼리 ${queryLog.length}회)`)
            send({ type: 'done' })
          }
        }
      } catch { /* JSON 파싱 불가 줄 무시 */ }
    }
  })

  claude.stderr.on('data', (data: string) => {
    const text = data.trim()
    if (!text) return
    const isBenign = /warning|deprecat|experimental|^\(use\s|^node:/i.test(text)
    if (!isBenign) log.error('오류', text.slice(0, 300), { sessionId })
  })

  claude.on('close', (code: number | null) => {
    releaseSemaphore()
    cleanup()
    if (!finished) send({ type: 'done' })
    if (!res.writableEnded) res.end()
  })

  claude.on('error', (err: Error) => {
    releaseSemaphore()
    cleanup()
    log.error('오류', `Claude 실행 실패: ${err.message}`, { sessionId })
    send({ type: 'error', message: `Claude 실행 오류: ${err.message}` })
    if (!res.writableEnded) res.end()
  })

  res.on('close', () => {
    cleanup()
    if (!claude.killed) claude.kill()
  })
})

// ─── API: 테이블 스키마 describe ─────────────────────────────────────────────
function spawnDescribe(table: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const prompt = `Dataverse 테이블 "${table}"을 describe 도구로 조회한 뒤, 주요 컬럼명·타입·한국어 설명을 마크다운 표로 간결하게 정리해줘. 표만 출력해.`
    const args   = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions']
    const claude = spawn(CLAUDE_BIN, args, { cwd: CWD, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: process.env })

    let lastText = '', buf = ''
    claude.stdout.setEncoding('utf8')
    claude.stdout.on('data', (chunk: string) => {
      buf += chunk
      const lines = buf.split('\n'); buf = lines.pop() ?? ''
      for (const line of lines) {
        try {
          const ev = JSON.parse(line.trim()) as Record<string, unknown>
          if (ev.type === 'assistant') {
            for (const block of (ev.message as Record<string, unknown[]>)?.content ?? []) {
              const b = block as Record<string, unknown>
              if (b.type === 'text' && (b.text as string).length > lastText.length) lastText = b.text as string
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
      try {
        const existing = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8') || '{}') as Record<string, SchemaEntry>
        // label/domain 기존 메타데이터 보존, schema만 교체
        existing[table] = { ...existing[table], schema: lastText, updatedAt: new Date().toISOString() }
        fs.writeFileSync(SCHEMA_FILE, JSON.stringify(existing, null, 2))
      } catch { /* 무시 */ }
      resolve(lastText)
    })
    claude.on('error', (err: Error) => { clearTimeout(timer); reject(err) })
  })
}

app.get('/api/describe', (req, res) => {
  const table = req.query.table as string | undefined
  if (!table) { res.status(400).json({ error: 'table 파라미터 필요' }); return }
  if (schemaCache.has(table)) { res.json({ schema: schemaCache.get(table), cached: true }); return }

  // 동일 테이블 동시 요청은 하나의 Claude 프로세스에 합류
  const pending = pendingDescribe.get(table)
  const p = pending ?? spawnDescribe(table)
  if (!pending) {
    pendingDescribe.set(table, p)
    p.finally(() => pendingDescribe.delete(table))
  }

  p.then(schema  => { if (!res.writableEnded) res.json({ schema, cached: false }) })
   .catch(err    => { if (!res.writableEnded) res.status(500).json({ error: (err as Error).message }) })
})

// ─── API: 지침 ────────────────────────────────────────────────────────────────
function readInst(): Instructions {
  try { return JSON.parse(fs.readFileSync(INST_FILE, 'utf8')) as Instructions }
  catch { return { joins: [], terms: [], examples: [] } }
}

app.get('/api/instructions',  (_req, res) => res.json(readInst()))
app.post('/api/instructions', (req, res) => {
  try {
    fs.writeFileSync(INST_FILE, JSON.stringify(req.body, null, 2))
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

// ─── API: 서버 통계 ───────────────────────────────────────────────────────────
app.get('/api/stats', (_req, res) => {
  res.json({
    uptime:         Math.floor((Date.now() - stats.startTime) / 1000),
    sessions:        stats.sessions,
    queries:         stats.queries,
    toolCalls:       stats.toolCalls,
    securityBlocks:  stats.securityBlocks,
    activeSessions:  sessionMap.size,
    activeProcs:     activeClaudeProcs,
    maxProcs:        MAX_CONCURRENT,
    queuedRequests:  concurrentQueue.length,
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
    res.status(500).json({ error: (err as Error).message })
  }
})

// ─── Groq 라우트 (Claude CLI spawn 없이 Groq API 직접 호출) ──────────────────
app.use('/api/groq/chat', chatLimiter)
app.post('/api/groq/chat', groqChat)

// ─── SPA 폴백 ─────────────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  const indexPath = path.join(DIST_DIR, 'index.html')
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath)
  } else {
    res.status(503).send('프론트엔드 빌드가 없습니다. npm run build 를 실행하세요.')
  }
})

// ─── 서버 기동 ────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  log.info('SERVER', `Quali CRM Chat 서버 기동 — http://localhost:${PORT}`)
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  Quali CRM Chat 서버 실행 중')
  console.log(`  http://localhost:${PORT}`)
  console.log(`  타임아웃: ${CHAT_TIMEOUT_MS / 1000}s  Rate-limit: ${RL_MAX}req/${RL_WINDOW_MS / 1000}s`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
})

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
function shutdown(signal: string) {
  log.info('SERVER', `${signal} 수신 — graceful shutdown 시작`)
  server.close(() => {
    log.info('SERVER', '모든 연결 종료 — 프로세스 정상 종료')
    process.exit(0)
  })
  setTimeout(() => {
    log.error('SERVER', 'Graceful shutdown 타임아웃 — 강제 종료')
    process.exit(1)
  }, SHUTDOWN_TIMEOUT_MS).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))
