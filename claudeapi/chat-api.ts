// ─────────────────────────────────────────────────────────────────────────────
// Claude API(Messages) + Dataverse Web API(OData) 직접 연결 채팅 엔드포인트
//
// 기존 Claude Code(CLI) 경로(server/index.ts /api/chat)와 완전히 분리된 추가 백엔드.
// 구조: QualiSoft Azure 앱(서비스 주체) → client_credentials 토큰(server/dataverse.ts) →
//        Dataverse Web API로 직접 조회(GET, 읽기 전용)
//        → Claude가 schema.json(엔티티 집합명 포함) 기반으로 OData 쿼리를 작성/해석해 답변
//
// 스키마(schema.json)는 Claude 없이 순수 REST로 갱신된다 — server/dataverse.ts +
// server/index.ts의 /api/schemas/refresh 참고. 이 파일은 "질문에 답하는" 역할만 한다.
//
// 컨텍스트 절약: 매 세션 첫 메시지엔 테이블 "카탈로그"(이름/라벨/엔티티집합명 한 줄)만
// 넣는다. 실제 컬럼 목록이 필요한 테이블은 dataverse_describe_table 도구로 Claude가
// 직접 골라서 조회한다(schema.json 캐시 조회 — 네트워크 호출 없음, 즉시 응답).
//
// 동시성/타임아웃/세션 정리는 CLI 모드(server/index.ts)와 같은 정책·같은 환경변수를
// 공유한다 — 운영자가 두 모드를 서로 다르게 튜닝할 필요가 없도록 하기 위함.
//
// 필요 환경변수 (루트 .env):
//   ANTHROPIC_API_KEY        — Anthropic API 키 (필수)
//   DATAVERSE_TENANT_ID / DATAVERSE_CLIENT_ID / DATAVERSE_CLIENT_SECRET / DATAVERSE_URL
//   ANTHROPIC_MODEL          — 기본값 claude-haiku-4-5 (데모 속도 우선)
//   MAX_CONCURRENT_API       — 기본값 10 (동시 Claude API 스트림 수. CLI보다 높은 이유는
//                              OS 프로세스가 아니라 HTTP 연결이라 자원 비용이 훨씬 낮기 때문)
//   CHAT_TIMEOUT_MS          — 기본값 120000. CLI 모드와 동일 변수를 공유
//   MAX_SESSIONS             — 기본값 200. CLI 모드와 동일 변수를 공유(세션 정리 상한)
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config'
import type { Express, Request, Response } from 'express'
import fs from 'fs'
import path from 'path'
import Anthropic from '@anthropic-ai/sdk'
import { setupSse, HttpStatus } from '../server/sse'
import log from '../server/logger'
import { dataverseGet, dataverseEnvMissing, buildCompactCatalog, type SchemaEntry } from '../server/dataverse'
import { Semaphore } from '../server/semaphore'

// ─── 설정 ─────────────────────────────────────────────────────────────────────
const MODEL         = process.env.ANTHROPIC_MODEL         ?? 'claude-haiku-4-5'
const MAX_TOKENS    = parseInt(process.env.ANTHROPIC_MAX_TOKENS ?? '4096')
const MAX_CONCURRENT_API = parseInt(process.env.MAX_CONCURRENT_API ?? '10')
const CHAT_TIMEOUT_MS    = parseInt(process.env.CHAT_TIMEOUT_MS    ?? '120000')   // CLI와 공유
const MAX_SESSIONS       = parseInt(process.env.MAX_SESSIONS       ?? '200')      // CLI와 공유
const MAX_TOOL_LOOPS = 6
const SESSION_TTL_MS = 24 * 60 * 60 * 1000   // CLI 모드와 동일 정책

const CWD         = process.cwd()
const SCHEMA_FILE = path.join(CWD, 'data', 'schema.json')

const apiSemaphore = new Semaphore(MAX_CONCURRENT_API)

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
    '1) 아래 [테이블 카탈로그]에서 질문에 필요한 테이블을 고르세요.',
    '2) 그 테이블의 정확한 컬럼명을 모르면 dataverse_describe_table로 먼저 조회하세요.',
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

// ─── Claude 커스텀 도구 정의 (읽기 전용) ─────────────────────────────────────
const DATAVERSE_QUERY_TOOL: Anthropic.Tool = {
  name: 'dataverse_query',
  description: 'Dataverse Web API(OData)를 GET으로 조회한다(읽기 전용). '
    + 'path는 엔티티 집합명으로 시작하는 상대 경로. 예: "new_q3s?$select=new_name&$top=5&$filter=statecode eq 0"',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'OData 상대 경로 (엔티티 집합명 + $select/$filter/$top/$orderby 등)' },
    },
    required: ['path'],
  },
}

const DESCRIBE_TABLE_TOOL: Anthropic.Tool = {
  name: 'dataverse_describe_table',
  description: '테이블의 전체 컬럼명·타입·한국어 설명·엔티티집합명을 조회한다(캐시 조회, 즉시 응답, 네트워크 호출 없음). '
    + 'dataverse_query를 쓰기 전에 정확한 컬럼명이 필요하면 먼저 이 도구를 호출하세요.',
  input_schema: {
    type: 'object',
    properties: {
      table: { type: 'string', description: '테이블 논리명 (카탈로그에 있는 이름 그대로, 예: new_q3)' },
    },
    required: ['table'],
  },
}

// 캐시된 schema.json에서 특정 테이블의 전체 스키마를 즉시 반환 (네트워크 호출 없음)
function describeTableFromCache(table: string): string {
  const data = readSchemaFile()
  const entry = data[table]
  if (!entry?.schema) return `테이블 "${table}"의 스키마 정보가 없습니다. 카탈로그의 정확한 테이블명을 사용하세요.`
  const setName = entry.entitySetName ? `\n엔티티집합명: ${entry.entitySetName}` : ''
  return `## ${table}${entry.label ? ` (${entry.label})` : ''}${setName}\n${entry.schema}`
}

// ─── 세션별 대화 히스토리 (인메모리, TTL/상한 정리 — CLI 모드 sessionMap과 동일 정책) ──
type Msg = Anthropic.MessageParam
interface HistorySession { messages: Msg[]; lastUsed: number }
const historyMap = new Map<string, HistorySession>()
const MAX_TURNS  = 20

// 히스토리 상한 트리밍 — 단순 slice(-N)은 assistant(tool_use) ↔ user(tool_result) 쌍의
// 중간을 자를 수 있고, 그러면 이후 모든 요청이 API 400으로 실패한다(세션 영구 파손).
// 반드시 "일반 텍스트 user 메시지"(새 질문 시작점) 경계에서만 자른다.
function trimHistory(msgs: Msg[]): Msg[] {
  if (msgs.length <= MAX_TURNS) return msgs
  for (let i = msgs.length - MAX_TURNS; i < msgs.length; i++) {
    const m = msgs[i]
    if (m.role === 'user' && typeof m.content === 'string') return msgs.slice(i)
  }
  // 상한 범위 안에 질문 경계가 없으면(한 턴이 비정상적으로 긴 경우) 마지막 질문부터 유지
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role === 'user' && typeof m.content === 'string') return msgs.slice(i)
  }
  return msgs
}

// describe 결과 히스토리 컴팩션 — 테이블 하나당 수 KB인 스키마 조회 결과가 대화
// 기록에 그대로 쌓이면 매 요청 입력 토큰이 턴마다 급증한다(실측: 2턴 만에 2배+).
// 답변 생성에 쓰인 직후에는 더 이상 원문이 필요 없고, schema.json 로컬 캐시 조회라
// 다시 필요하면 모델이 재호출해도 비용이 0이므로, 저장 시점에 placeholder로 치환한다.
const DESCRIBE_PLACEHOLDER = '(스키마 조회 결과 생략 — 필요하면 dataverse_describe_table을 다시 호출하세요)'

function compactDescribeResults(msgs: Msg[], describeIds: Set<string>): number {
  if (describeIds.size === 0) return 0
  let compacted = 0
  for (const m of msgs) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue
    for (const block of m.content) {
      if (typeof block === 'object' && block.type === 'tool_result' && describeIds.has(block.tool_use_id)) {
        block.content = DESCRIBE_PLACEHOLDER
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
  const client = new Anthropic()   // ANTHROPIC_API_KEY 환경변수 사용

  app.post('/api/chat-api', async (req: Request, res: Response) => {
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

    await apiSemaphore.acquire()
    let semReleased = false
    const releaseSem = () => { if (!semReleased) { semReleased = true; apiSemaphore.release() } }

    // 브라우저 연결이 끊기면 Anthropic 스트림도 즉시 취소 (CLI 모드의 claude.kill()과 동일 역할)
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
    const describeIds = new Set<string>()   // 이번 요청의 describe 호출 — 저장 시 결과 컴팩션 대상

    try {
      // ── 도구 사용 루프 (커스텀 도구는 서버가 직접 실행) ──
      for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
        const toolAcc = new Map<number, { name: string; json: string }>()

        const stream = client.messages.stream({
          model:      MODEL,
          max_tokens: MAX_TOKENS,
          system: [{ type: 'text', text: buildSystemPrompt(), cache_control: { type: 'ephemeral' } }],
          messages: history,
          tools:    [DATAVERSE_QUERY_TOOL, DESCRIBE_TABLE_TOOL],
        }, { timeout: CHAT_TIMEOUT_MS, signal: abortController.signal })

        for await (const ev of stream) {
          if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
            toolAcc.set(ev.index, { name: ev.content_block.name, json: '' })
            send({ type: 'tool', name: ev.content_block.name })
          } else if (ev.type === 'content_block_delta') {
            if (ev.delta.type === 'text_delta') {
              send({ type: 'text', text: ev.delta.text })
              answerText += ev.delta.text
            } else if (ev.delta.type === 'input_json_delta') {
              const acc = toolAcc.get(ev.index)
              if (acc) acc.json += ev.delta.partial_json
            }
          } else if (ev.type === 'content_block_stop') {
            const acc = toolAcc.get(ev.index)
            if (acc) {
              let input: Record<string, unknown> = {}
              try { input = acc.json ? JSON.parse(acc.json) : {} } catch { /* 무시 */ }
              send({ type: 'query', tool: acc.name, input })
              const preview = String((input as { path?: string; table?: string }).path
                ?? (input as { table?: string }).table ?? JSON.stringify(input))
              log.info('API-쿼리', `[${acc.name}] ${preview.slice(0, 100)}`)
              queryCount++
              toolAcc.delete(ev.index)
            }
          }
        }

        const final = await stream.finalMessage()
        history.push({ role: 'assistant', content: final.content })

        inTok        += final.usage.input_tokens
        outTok       += final.usage.output_tokens
        cacheReadTok  += final.usage.cache_read_input_tokens ?? 0
        cacheWriteTok += final.usage.cache_creation_input_tokens ?? 0

        const toolUses = final.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        )
        if (final.stop_reason !== 'tool_use' || toolUses.length === 0) break

        // 도구 실행 → tool_result 반환 (모두 읽기 전용)
        const results: Anthropic.ToolResultBlockParam[] = []
        for (const tu of toolUses) {
          try {
            if (tu.name === 'dataverse_describe_table') {
              const table = (tu.input as { table?: string }).table ?? ''
              const out = describeTableFromCache(table)   // 캐시 조회 — 네트워크 호출 없음
              describeIds.add(tu.id)
              results.push({ type: 'tool_result', tool_use_id: tu.id, content: out })
            } else {
              const p = (tu.input as { path?: string }).path ?? ''
              const out = await dataverseQuery(p)
              results.push({ type: 'tool_result', tool_use_id: tu.id, content: out })
            }
          } catch (e) {
            results.push({ type: 'tool_result', tool_use_id: tu.id, content: `오류: ${(e as Error).message}`, is_error: true })
          }
        }
        history.push({ role: 'user', content: results })
      }

      const compacted = compactDescribeResults(history, describeIds)   // 답변 완료 후 스키마 원문은 히스토리에서 제거
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

  log.info('SERVER', `Claude API 엔드포인트 등록됨 — POST /api/chat-api `
    + `(model: ${MODEL}, 동시 ${MAX_CONCURRENT_API}, 타임아웃 ${CHAT_TIMEOUT_MS / 1000}s)`)
}
