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
// 필요 환경변수 (루트 .env):
//   ANTHROPIC_API_KEY        — Anthropic API 키 (필수)
//   DATAVERSE_TENANT_ID / DATAVERSE_CLIENT_ID / DATAVERSE_CLIENT_SECRET / DATAVERSE_URL
//   ANTHROPIC_MODEL          — 기본값 claude-haiku-4-5 (데모 속도 우선)
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config'
import type { Express, Request, Response } from 'express'
import fs from 'fs'
import path from 'path'
import Anthropic from '@anthropic-ai/sdk'
import { setupSse, HttpStatus } from '../server/sse'
import log from '../server/logger'
import { dataverseGet, dataverseEnvMissing, buildCompactCatalog, type SchemaEntry } from '../server/dataverse'

// ─── 설정 ─────────────────────────────────────────────────────────────────────
const MODEL      = process.env.ANTHROPIC_MODEL      ?? 'claude-haiku-4-5'
const MAX_TOKENS = parseInt(process.env.ANTHROPIC_MAX_TOKENS ?? '4096')
const MAX_TOOL_LOOPS = 6

const CWD         = process.cwd()
const SCHEMA_FILE = path.join(CWD, 'data', 'schema.json')

function readSchemaFile(): Record<string, SchemaEntry> {
  try { return JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8')) as Record<string, SchemaEntry> }
  catch { return {} }
}

// 데이터 조회용 GET — 공용 dataverseGet(원문 텍스트) 위에 컨텍스트 절약용 truncate만 추가
async function dataverseQuery(relPath: string): Promise<string> {
  const text = await dataverseGet(relPath)
  try {
    const json = JSON.parse(text) as { value?: unknown[] }
    if (Array.isArray(json.value)) return JSON.stringify(json.value.slice(0, 100))
  } catch { /* 원문 반환 */ }
  return text.slice(0, 8000)
}

// ─── 시스템 프롬프트(카탈로그 + 규칙) — prompt caching 대상, 전체 컬럼은 넣지 않음 ──
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

// ─── 세션별 대화 히스토리 (인메모리, 데모용) ─────────────────────────────────
type Msg = Anthropic.MessageParam
const historyMap = new Map<string, Msg[]>()
const MAX_TURNS  = 20

// ─── 라우트 등록 ──────────────────────────────────────────────────────────────
export function registerChatApi(app: Express): void {
  const client = new Anthropic()   // ANTHROPIC_API_KEY 환경변수 사용
  const SYSTEM_PROMPT = buildSystemPrompt()

  app.post('/api/chat-api', async (req: Request, res: Response) => {
    const { message, sessionId } = req.body as { message: string; sessionId: string }
    if (!message || !sessionId) {
      res.status(HttpStatus.BAD_REQUEST).json({ error: 'message와 sessionId가 필요합니다.' })
      return
    }

    const send = setupSse(res)

    const missing = dataverseEnvMissing()
    if (missing) {
      send({ type: 'error', message: `${missing} 환경변수가 설정되지 않았습니다. (.env 확인)` })
      if (!res.writableEnded) res.end()
      return
    }

    const history = historyMap.get(sessionId) ?? []
    history.push({ role: 'user', content: message })

    const startMs = Date.now()
    log.info('API-질문', message.slice(0, 200))

    let answerText = ''
    let queryCount = 0

    try {
      // ── 도구 사용 루프 (커스텀 도구는 서버가 직접 실행) ──
      for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
        const toolAcc = new Map<number, { name: string; json: string }>()

        const stream = client.messages.stream({
          model:      MODEL,
          max_tokens: MAX_TOKENS,
          system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          messages: history,
          tools:    [DATAVERSE_QUERY_TOOL, DESCRIBE_TABLE_TOOL],
        })

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

      historyMap.set(sessionId, history.slice(-MAX_TURNS))
      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1)
      log.info('API-답변', `${answerText.slice(0, 300)} (${elapsed}초, 쿼리 ${queryCount}회)`)
      send({ type: 'done' })
    } catch (err) {
      const msg = (err as Error).message
      log.error('API-오류', msg.slice(0, 300), { sessionId })
      send({ type: 'error', message: `Claude API 오류: ${msg}` })
    } finally {
      if (!res.writableEnded) res.end()
    }
  })

  log.info('SERVER', `Claude API 엔드포인트 등록됨 — POST /api/chat-api (model: ${MODEL}, Dataverse Web API 직접, 컴팩트 카탈로그)`)
}
