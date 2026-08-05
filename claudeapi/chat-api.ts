// ─────────────────────────────────────────────────────────────────────────────
// 채팅 엔드포인트 (POST /api/chat) — Claude API 직접 호출 + Dataverse 네이티브 MCP
//
// 구조 (2026-08 재구성 — hsagent 게이트웨이 제거, text-to-SQL 전용 프로젝트로 단일화):
//   - search / describe: Dataverse 네이티브 MCP 엔드포인트(${DATAVERSE_URL}/api/mcp)를
//     Anthropic MCP 커넥터로 직접 연결(server/claude-client.ts). 실행은 Anthropic
//     인프라 쪽에서 일어난다 — 이 파일은 결과를 SSE로 표시만 한다.
//   - 실제 데이터 조회(SELECT): 이 파일이 정의하는 커스텀 도구 dataverse_query.
//     Dataverse Web API(OData GET, server/dataverse.ts)로 우리가 직접 실행하고,
//     엔티티집합명 화이트리스트 + $top 상한 가드를 그대로 적용한다 — MCP read_query로
//     넘기면 이 가드를 걸 훅 포인트가 없어지므로 의도적으로 MCP 쪽 read_query는
//     도구 목록에서 뺐다(claude-client.ts의 mcp_toolset configs 참고).
//
// 컨텍스트 절약: 매 세션 첫 메시지엔 테이블 "카탈로그"(이름/라벨/엔티티집합명 한 줄)만
// 시스템 프롬프트에 넣는다. 컬럼 목록이 필요하면 모델이 MCP describe 도구를 직접 호출한다.
//
// 필요 환경변수 (루트 .env):
//   ANTHROPIC_API_KEY        — Claude API 키 (필수)
//   DATAVERSE_TENANT_ID / DATAVERSE_CLIENT_ID / DATAVERSE_CLIENT_SECRET / DATAVERSE_URL
//   MAX_CONCURRENT_API       — 기본값 10 (동시 Claude API 스트림 수)
//   CHAT_TIMEOUT_MS          — 기본값 120000
//   MAX_SESSIONS             — 기본값 200 (세션 정리 상한)
//   LLM_MODEL                — 기본값 claude-haiku-4-5 (데모 응답 속도 우선)
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config'
import type { Express, Request, Response } from 'express'
import fs from 'fs'
import path from 'path'
import { setupSse, HttpStatus } from '../server/sse'
import log from '../server/logger'
import { dataverseGet, dataverseEnvMissing, buildCompactCatalog, type SchemaEntry } from '../server/dataverse'
import { Semaphore } from '../server/semaphore'
import {
  streamChat, anthropicConfigured, currentModel,
  type ChatMessage, type ContentBlockParam, type ToolDef,
} from '../server/claude-client'

// ─── 설정 ─────────────────────────────────────────────────────────────────────
const MAX_CONCURRENT_API = parseInt(process.env.MAX_CONCURRENT_API ?? '10')
const CHAT_TIMEOUT_MS    = parseInt(process.env.CHAT_TIMEOUT_MS    ?? '120000')
const MAX_SESSIONS       = parseInt(process.env.MAX_SESSIONS       ?? '200')
const MAX_TOOL_LOOPS = 6
const SESSION_TTL_MS = 24 * 60 * 60 * 1000

const CWD         = process.cwd()
const SCHEMA_FILE = path.join(CWD, 'data', 'schema.json')

const apiSemaphore = new Semaphore(MAX_CONCURRENT_API)

// 헬스체크(/api/health)용 동시성 상태
export function apiStatus(): { active: number; queued: number; max: number } {
  return { active: apiSemaphore.size, queued: apiSemaphore.pending, max: MAX_CONCURRENT_API }
}

function readSchemaFile(): Record<string, SchemaEntry> {
  try { return JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8')) as Record<string, SchemaEntry> }
  catch { return {} }
}

// ─── OData 쿼리 가드 — 모델이 생성한 경로를 무검증 실행하지 않는다 ────────────
// 1) 엔티티집합명 화이트리스트: schema.json에 등록된 테이블만 조회 허용
//    (환각으로 만든 경로·등록 외 테이블 접근을 원천 차단, 위반 시 tool_result
//     오류로 돌려보내 모델이 카탈로그 기준으로 자가 수정하게 한다)
// 2) $top 상한: 목록 조회에 $top이 없으면 100을 강제해 무제한 전체 조회로 인한
//    Dataverse 부하·응답 비대를 방지 (집계 $apply/$count·단건 조회는 제외)
//
// MCP 커넥터의 search/describe는 Anthropic 쪽에서 실행되어 이 가드를 거치지 않는다 —
// 그래서 실제 데이터 조회(SELECT류)는 의도적으로 MCP로 넘기지 않고 이 가드가 있는
// 커스텀 도구(dataverse_query)로만 하도록 설계했다(server/claude-client.ts 참고).
function allowedEntitySets(): Set<string> {
  const sets = new Set<string>()
  for (const info of Object.values(readSchemaFile())) {
    if (info.entitySetName) sets.add(info.entitySetName)
  }
  return sets
}

function guardODataPath(relPath: string): string {
  const clean = relPath.replace(/^\/+/, '')
  const entitySet = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(clean)?.[1] ?? ''
  const allowed = allowedEntitySets()
  if (allowed.size > 0 && !allowed.has(entitySet)) {
    throw new Error(`허용되지 않은 엔티티 집합명 "${entitySet}"입니다. 카탈로그에 표시된 엔티티집합명을 그대로 사용하세요.`)
  }

  const qIdx = clean.indexOf('?')
  const resource = qIdx === -1 ? clean : clean.slice(0, qIdx)
  const query    = qIdx === -1 ? ''    : clean.slice(qIdx + 1)
  const isCollection = !resource.includes('(') && !resource.includes('$count')
  if (isCollection && !/(^|&)\$top=/.test(query) && !/(^|&)\$apply=/.test(query) && !/(^|&)\$count=/.test(query)) {
    const withTop = query ? `${query}&$top=100` : '$top=100'
    return `${resource}?${withTop}`
  }
  return clean
}

// 데이터 조회용 GET — 가드 통과 후 공용 dataverseGet(원문 텍스트) + 컨텍스트 절약용 truncate
async function dataverseQuery(relPath: string): Promise<string> {
  const text = await dataverseGet(guardODataPath(relPath))
  try {
    const json = JSON.parse(text) as { value?: unknown[] }
    if (Array.isArray(json.value)) return JSON.stringify(json.value.slice(0, 100))
  } catch { /* 원문 반환 */ }
  return text.slice(0, 8000)
}

// ─── 시스템 프롬프트(카탈로그 + 규칙) — 요청마다 새로 빌드 ────────────────────
// schema.json은 스키마 갱신 버튼으로 언제든 바뀔 수 있다. 서버 기동 시 1회만 빌드해
// 캐싱하면 갱신 후에도 재시작 전까지 낡은 카탈로그를 계속 보내는 문제가 생기므로,
// 매 요청 로컬 파일을 다시 읽어 빌드한다(카탈로그가 작아 비용은 무시할 수준).
function buildSystemPrompt(): string {
  const catalog = buildCompactCatalog(readSchemaFile())
  return [
    '당신은 Quali CRM 데이터 조회 전용 어시스턴트입니다.',
    '항상 한국어로 답하고, 데이터는 마크다운 표로, 숫자/금액은 천 단위 콤마로 표시하세요.',
    '데이터가 없으면 "해당 조건에 맞는 데이터가 없습니다"라고 명확히 알리세요.',
    '조회 전용입니다. 데이터 변경(생성·수정·삭제) 요청은 거절하세요.',
    '',
    '작업 순서:',
    '1) 아래 [테이블 카탈로그]에서 질문에 필요한 테이블을 고르세요. 카탈로그에 없는',
    '   테이블이 필요하면 search 도구로 먼저 찾아보되, 실제 데이터 조회는 반드시',
    '   dataverse_query로만 하세요(카탈로그 등록 테이블만 조회 가능합니다).',
    '2) 정확한 컬럼명을 모르면 describe 도구로 먼저 스키마를 확인하세요.',
    '3) dataverse_query로 실제 데이터를 조회하세요. path는 "엔티티 집합명"으로 시작합니다',
    '   (카탈로그 또는 describe 결과의 엔티티집합명을 그대로 사용 — 추측 금지).',
    '   예) "new_q3s?$select=new_name,new_d_maechul&$top=5&$orderby=new_d_maechul desc"',
    '상태 필터가 필요하면 $filter=statecode eq 0 (활성) 을 사용하세요.',
    'Choice(선택) 컬럼은 라벨로 필터링할 수 없습니다. describe 결과의 옵션 목록에서',
    '라벨에 대응하는 숫자 코드를 찾아 필터링하세요.',
    '',
    '[테이블 카탈로그]',
    catalog,
  ].join('\n')
}

// ─── 커스텀 도구 정의 (읽기 전용, Anthropic tool 스키마) ──────────────────────
// dataverse_describe_table은 여기 없다 — MCP describe 도구가 대체한다(claude-client.ts).
const DATAVERSE_QUERY_TOOL: ToolDef = {
  name: 'dataverse_query',
  description: 'Dataverse Web API(OData)를 GET으로 조회한다(읽기 전용, schema.json에 등록된 테이블만 허용). '
    + 'path는 엔티티 집합명으로 시작하는 상대 경로. 예: "new_q3s?$select=new_name&$top=5&$filter=statecode eq 0"',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'OData 상대 경로 (엔티티 집합명 + $select/$filter/$top/$orderby 등)' },
    },
    required: ['path'],
  },
}

// ─── 세션별 대화 히스토리 (인메모리, TTL/상한 정리) ──────────────────────────
// 형식은 Anthropic Messages API: user / assistant, content는 문자열 또는 콘텐츠 블록 배열.
// system은 매 요청 새로 빌드해 별도 파라미터로 보내므로 히스토리에 저장하지 않는다.
type Msg = ChatMessage
interface HistorySession { messages: Msg[]; lastUsed: number }
const historyMap = new Map<string, HistorySession>()
export const MAX_TURNS = 20

// 순수 텍스트로만 이루어진 "진짜 사용자 질문" 여부. tool_result를 담은 user 메시지와
// 구분해야 한다 — 안 그러면 트리밍이 tool_use/tool_result 쌍을 끊어 다음 요청이 400 난다.
function isUserQuestion(m: Msg): boolean {
  if (m.role !== 'user') return false
  if (typeof m.content === 'string') return true
  return m.content.every(b => b.type === 'text')
}

// 히스토리 상한 트리밍 — 단순 slice(-N)은 assistant(tool_use) ↔ user(tool_result) 쌍의
// 중간을 자를 수 있고, 그러면 이후 모든 요청이 API 400으로 실패한다(세션 영구 파손).
// 반드시 "진짜 사용자 질문"(순수 텍스트 user 메시지, 새 질문 시작점) 경계에서만 자른다.
export function trimHistory(msgs: Msg[]): Msg[] {
  if (msgs.length <= MAX_TURNS) return msgs
  for (let i = msgs.length - MAX_TURNS; i < msgs.length; i++) {
    if (isUserQuestion(msgs[i])) return msgs.slice(i)
  }
  // 상한 범위 안에 질문 경계가 없으면(한 턴이 비정상적으로 긴 경우) 마지막 질문부터 유지
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (isUserQuestion(msgs[i])) return msgs.slice(i)
  }
  return msgs
}

// describe 결과 히스토리 컴팩션 — MCP describe 도구 결과(테이블 하나당 수 KB인 스키마
// 마크다운)가 대화 기록(assistant 메시지의 mcp_tool_result 블록)에 그대로 쌓이면 매 요청
// 입력 토�큰이 턴마다 급증한다. 답변 생성에 쓰인 직후에는 원문이 더 필요 없고, 다시
// 필요하면 모델이 describe를 재호출해도 비용이 낮으므로, 저장 시점에 placeholder로 치환한다.
export const DESCRIBE_PLACEHOLDER = '(스키마 조회 결과 생략 — 필요하면 describe를 다시 호출하세요)'

export function compactDescribeResults(msgs: Msg[]): number {
  let compacted = 0
  for (const m of msgs) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue
    const describeIds = new Set(
      m.content
        .filter((b): b is Extract<ContentBlockParam, { type: 'mcp_tool_use' }> =>
          b.type === 'mcp_tool_use' && b.name === 'describe')
        .map(b => b.id),
    )
    if (describeIds.size === 0) continue
    for (const b of m.content) {
      if (b.type === 'mcp_tool_result' && describeIds.has(b.tool_use_id) && b.content !== DESCRIBE_PLACEHOLDER) {
        b.content = DESCRIBE_PLACEHOLDER
        compacted++
      }
    }
  }
  return compacted
}

setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS
  let removed = 0
  for (const [id, entry] of historyMap) {
    if (entry.lastUsed < cutoff) { historyMap.delete(id); removed++ }
  }
  if (historyMap.size > MAX_SESSIONS) {
    const sorted = [...historyMap.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    const excess = historyMap.size - MAX_SESSIONS
    for (let i = 0; i < excess; i++) { historyMap.delete(sorted[i][0]); removed++ }
  }
  if (removed) log.info('API-세션', `세션 정리: ${removed}개 삭제 (현재: ${historyMap.size})`)
}, 60 * 60 * 1000).unref()

// ─── 라우트 등록 ──────────────────────────────────────────────────────────────
export function registerChatApi(app: Express): void {
  app.post('/api/chat', async (req: Request, res: Response) => {
    const { message, sessionId } = req.body as { message: string; sessionId: string }
    if (!message || !sessionId) {
      res.status(HttpStatus.BAD_REQUEST).json({ error: 'message와 sessionId가 필요합니다.' })
      return
    }

    if (apiSemaphore.isOverloaded()) {
      res.status(HttpStatus.TOO_MANY_REQUESTS).json({ error: '현재 요청이 많습니다. 잠시 후 다시 시도하세요.' })
      return
    }

    const send = setupSse(res)

    const missing = dataverseEnvMissing()
    if (missing) {
      send({ type: 'error', message: `${missing} 환경변수가 설정되지 않았습니다. (.env 확인)` })
      if (!res.writableEnded) res.end()
      return
    }
    if (!anthropicConfigured()) {
      send({ type: 'error', message: 'ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다. (.env 확인)' })
      if (!res.writableEnded) res.end()
      return
    }

    await apiSemaphore.acquire()
    let semReleased = false
    const releaseSem = () => { if (!semReleased) { semReleased = true; apiSemaphore.release() } }

    // 브라우저 연결이 끊기면 Claude API 스트림도 즉시 취소
    const abortController = new AbortController()
    res.on('close', () => abortController.abort())

    const session = historyMap.get(sessionId) ?? { messages: [], lastUsed: Date.now() }
    // 에러 시 이 지점으로 롤백 — 반쪽 히스토리(tool_result 없는 tool_use 등)가 저장되면
    // 그 세션의 이후 요청이 전부 400으로 실패하므로, 실패한 요청의 흔적은 통째로 버린다.
    const rollbackLen = session.messages.length
    session.messages.push({ role: 'user', content: message })
    session.lastUsed = Date.now()
    const history = session.messages

    const startMs = Date.now()
    log.info('API-질문', message.slice(0, 200))

    let answerText = ''
    let queryCount = 0
    let inTok = 0, outTok = 0, cacheReadTok = 0, cacheWriteTok = 0

    // Claude API 스트림 1회 소비 — 텍스트는 즉시 클라이언트로 흘리고, MCP 도구 호출은
    // (이미 실행 완료된 상태로) 표시만 하고, 최종 콘텐츠 블록·stop_reason·사용량을 모아 반환한다.
    async function collectStream(messages: ChatMessage[]) {
      let content: ContentBlockParam[] = []
      let stopReason: string | null = null
      let usage = { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, cacheWriteTokens: 0 }

      for await (const ev of streamChat(
        buildSystemPrompt(), messages, [DATAVERSE_QUERY_TOOL],
        { signal: abortController.signal, timeoutMs: CHAT_TIMEOUT_MS },
      )) {
        if (ev.type === 'text') {
          send({ type: 'text', text: ev.text })
          answerText += ev.text
        } else if (ev.type === 'tool_start') {
          send({ type: 'tool', name: ev.name })   // 커스텀 도구 — 인자 완성을 기다리지 않고 즉시 표시
        } else if (ev.type === 'mcp_call') {
          // MCP 도구(search/describe)는 이미 실행 완료 — "사용된 쿼리" 패널에 결과와 함께 표시
          send({ type: 'tool', name: ev.name })
          send({ type: 'query', tool: ev.name, input: ev.input })
          log.info('API-MCP', `[${ev.name}] ${JSON.stringify(ev.input).slice(0, 100)} → ${ev.isError ? '오류' : 'OK'}`)
          queryCount++
        } else {
          content = ev.content
          stopReason = ev.stopReason
          usage = ev.usage
        }
      }
      return { content, stopReason, usage }
    }

    try {
      // ── 도구 사용 루프 (커스텀 도구 dataverse_query만 서버가 직접 실행) ──
      // MCP search/describe는 이미 Anthropic 쪽에서 실행되어 응답에 포함되어 온다 —
      // 이 루프는 우리 커스텀 도구 실행과, MCP의 서버사이드 반복 상한(pause_turn)
      // 이어가기만 처리한다.
      for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
        const collected = await collectStream(history)

        inTok         += collected.usage.prompt_tokens
        outTok        += collected.usage.completion_tokens
        cacheReadTok  += collected.usage.cached_tokens
        cacheWriteTok += collected.usage.cacheWriteTokens

        history.push({ role: 'assistant', content: collected.content })

        const customCalls = collected.content.filter(
          (b): b is Extract<ContentBlockParam, { type: 'tool_use' }> => b.type === 'tool_use',
        )

        if (customCalls.length > 0) {
          const toolResults: ContentBlockParam[] = []
          for (const tc of customCalls) {
            const input = (tc.input ?? {}) as Record<string, unknown>
            send({ type: 'query', tool: tc.name, input })
            log.info('API-쿼리', `[${tc.name}] ${String(input.path ?? '').slice(0, 100)}`)
            queryCount++

            let out: string
            let isError = false
            try {
              out = await dataverseQuery(String(input.path ?? ''))
            } catch (e) {
              out = `오류: ${(e as Error).message}`
              isError = true
            }
            toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: out, is_error: isError })
          }
          history.push({ role: 'user', content: toolResults })
          continue
        }

        // MCP 쪽 서버사이드 도구 반복이 상한(10회)에 걸리면 pause_turn으로 멈춘다.
        // 새 메시지를 추가하지 말고 그대로 재요청하면 이어서 진행된다(공식 문서 권장 패턴).
        if (collected.stopReason === 'pause_turn') continue

        break   // end_turn — 답변 완료
      }

      const compacted = compactDescribeResults(history)   // 답변 완료 후 describe 원문은 히스토리에서 생략 처리
      if (compacted > 0) log.info('API-컴팩션', `스키마 조회 결과 ${compacted}건 히스토리에서 생략 처리`)
      session.messages = trimHistory(history)
      session.lastUsed = Date.now()
      historyMap.set(sessionId, session)

      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1)
      log.info('API-답변', `${answerText.slice(0, 300)} (${elapsed}초, 쿼리 ${queryCount}회, `
        + `토큰 in:${inTok} out:${outTok} cache_read:${cacheReadTok} cache_write:${cacheWriteTok})`)
      send({ type: 'done' })
    } catch (err) {
      // 실패한 요청의 반쪽 히스토리를 제거해 세션을 이전 정상 상태로 복원
      session.messages.length = rollbackLen
      const msg = (err as Error).message
      log.error('API-오류', msg.slice(0, 300), { sessionId })
      send({ type: 'error', message: `Claude API 오류: ${msg}` })
    } finally {
      releaseSem()
      if (!res.writableEnded) res.end()
    }
  })

  log.info('SERVER', `채팅 엔드포인트 등록됨 — POST /api/chat `
    + `(LLM: Claude API 직접 호출 모델=${currentModel()}, 동시 ${MAX_CONCURRENT_API}, 타임아웃 ${CHAT_TIMEOUT_MS / 1000}s)`)
}
