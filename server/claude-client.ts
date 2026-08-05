// ─────────────────────────────────────────────────────────────────────────────
// Claude API 직접 호출 클라이언트 (2026-08 재구성 — hsagent 게이트웨이 제거)
//
// crm-ai-chat은 이제 hsagent와 완전히 분리된 text-to-SQL 전용 프로젝트다.
// LLM 호출은 @anthropic-ai/sdk로 Claude API를 직접 부른다. 도구는 두 갈래다:
//
//   1) search / describe — Dataverse가 네이티브로 제공하는 MCP 엔드포인트
//      (`${DATAVERSE_URL}/api/mcp`)를 Anthropic의 MCP 커넥터(mcp_servers +
//      mcp_toolset)로 직접 연결한다. 이 두 도구의 실행은 Anthropic 인프라
//      쪽에서 일어난다 — 우리 서버는 실행 루프를 돌 필요가 없다(응답에
//      mcp_tool_use/mcp_tool_result가 이미 포함되어 돌아온다).
//      쓰기 도구(create_record/update_record/delete_record 등)는 mcp_toolset의
//      default_config.enabled=false + configs 화이트리스트로 도구 목록에서
//      원천 제외한다 — 모델이 존재조차 알 수 없다(하드 차단).
//
//   2) 실제 데이터 조회(SELECT류) — 우리가 정의하는 커스텀 도구 dataverse_query.
//      MCP read_query로 넘기면 실행이 Anthropic 쪽에서 일어나 화이트리스트·
//      $top 상한을 가로챌 훅 포인트가 없어진다. 그래서 이 도구만은 기존처럼
//      우리 서버가 직접 실행하고 가드를 적용한다 — claudeapi/chat-api.ts 참고.
//
// 인증: Dataverse MCP 엔드포인트는 기존 client_credentials 토큰(server/dataverse.ts의
// getDataverseToken, scope `${DATAVERSE_URL}/.default`)을 그대로 authorization_token으로
// 받아들인다 — 스파이크로 실측 확인 완료(2026-08).
//
// 필요 환경변수:
//   ANTHROPIC_API_KEY   Claude API 키 (필수 — 없으면 채팅 비활성)
//   LLM_MODEL           기본값 claude-haiku-4-5 (데모 응답 속도 우선)
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config'
import Anthropic from '@anthropic-ai/sdk'
import { getDataverseToken } from './dataverse'

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? ''
const LLM_MODEL = process.env.LLM_MODEL ?? 'claude-haiku-4-5'
const MAX_TOKENS = 8000
const MCP_BETA = 'mcp-client-2025-11-20'
const MCP_SERVER_NAME = 'dataverse'

export function anthropicConfigured(): boolean {
  return ANTHROPIC_API_KEY.length > 0
}

export function currentModel(): string {
  return LLM_MODEL
}

let clientSingleton: Anthropic | null = null
function client(): Anthropic {
  if (!clientSingleton) clientSingleton = new Anthropic({ apiKey: ANTHROPIC_API_KEY })
  return clientSingleton
}

// ─── 메시지/도구 타입 (Anthropic Messages API 콘텐츠 블록 — chat-api.ts가 그대로 씀) ──
export type ChatMessage  = Anthropic.Beta.BetaMessageParam
export type ContentBlock = Anthropic.Beta.BetaContentBlock
// 히스토리에 다시 넣을 때 쓰는 "요청" 쪽 블록 타입. 응답 블록(ContentBlock)과 필드가
// 미묘하게 달라(citations 필수 여부 등) 그대로 재사용할 수 없다 — toParamBlock()로 변환.
export type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam

export interface ToolDef {
  name:         string
  description:  string
  input_schema: Record<string, unknown>
}

export interface Usage {
  prompt_tokens:     number
  completion_tokens: number
  cached_tokens:     number
  cacheWriteTokens:  number
}

// 우리 쪽 코드가 소비하는 이벤트. 커스텀 도구(dataverse_query)는 'tool_start'로
// 알리고 chat-api.ts가 직접 실행한다. MCP 도구(search/describe)는 이미 Anthropic
// 쪽에서 실행이 끝난 채로 오므로 'mcp_call'로 표시만 한다 — 실행할 필요 없음.
export type GatewayEvent =
  | { type: 'text';     text: string }
  | { type: 'tool_start'; name: string }
  | { type: 'mcp_call';   name: string; input: Record<string, unknown>; resultPreview: string; isError: boolean }
  | { type: 'done';       content: ContentBlockParam[]; stopReason: string | null; usage: Usage }

const EMPTY_USAGE: Usage = { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, cacheWriteTokens: 0 }

function dataverseMcpUrl(): string {
  const base = (process.env.DATAVERSE_URL ?? '').replace(/\/$/, '')
  return `${base}/api/mcp`
}

// 응답 콘텐츠 블록(ContentBlock) → 다음 요청에 되돌려 보낼 파라미터 블록(ContentBlockParam).
// 이 프로젝트가 실제로 다루는 4가지 타입만 명시적으로 변환하고, 그 외(thinking 등 안 쓰는
// 타입)는 구조가 거의 같아 그대로 통과시킨다 — 매 턴 히스토리에 원문 그대로 되돌려 보내야
// Anthropic 쪽에서 mcp_tool_use/mcp_tool_result 쌍이 끊기지 않는다.
function toParamBlock(block: ContentBlock): ContentBlockParam {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
    case 'mcp_tool_use':
      return { type: 'mcp_tool_use', id: block.id, name: block.name, input: block.input, server_name: block.server_name }
    case 'mcp_tool_result':
      return { type: 'mcp_tool_result', tool_use_id: block.tool_use_id, is_error: block.is_error, content: block.content }
    default:
      return block as unknown as ContentBlockParam
  }
}

/**
 * Claude API에 스트리밍 요청을 보내고 이벤트를 순서대로 yield 한다.
 * 마지막은 반드시 type='done' (최종 콘텐츠 블록 전체 + stop_reason + 토큰 사용량).
 *
 * mcp_servers/mcp_toolset을 매 요청 함께 보낸다 — search/describe는 Anthropic이
 * 직접 Dataverse MCP 엔드포인트를 호출해 결과까지 포함한 채로 돌아온다.
 */
export async function* streamChat(
  system: string,
  messages: ChatMessage[],
  customTools: ToolDef[],
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): AsyncGenerator<GatewayEvent> {
  if (!anthropicConfigured()) {
    throw new Error('ANTHROPIC_API_KEY가 설정되지 않았습니다. (.env 확인)')
  }

  const timer = new AbortController()
  const timeoutMs = opts.timeoutMs ?? 120_000
  const to = setTimeout(() => timer.abort(), timeoutMs)
  const onAbort = () => timer.abort()
  opts.signal?.addEventListener('abort', onAbort)

  try {
    const dvToken = await getDataverseToken()

    const tools: Anthropic.Beta.BetaToolUnion[] = [
      ...customTools.map((t): Anthropic.Beta.BetaTool => ({
        name: t.name, description: t.description,
        input_schema: t.input_schema as Anthropic.Beta.BetaTool.InputSchema,
      })),
      {
        type: 'mcp_toolset',
        mcp_server_name: MCP_SERVER_NAME,
        // 화이트리스트: search/describe만 열고 나머지(특히 read_query, create_record,
        // update_record, delete_record, create_table, delete_table 등 쓰기 도구)는
        // 전부 꺼서 모델의 도구 목록에 애초에 노출되지 않게 한다 (하드 차단).
        default_config: { enabled: false },
        configs: {
          search:   { enabled: true },
          describe: { enabled: true },
        },
      },
    ]

    const mcpServers: Anthropic.Beta.BetaRequestMCPServerURLDefinition[] = [
      { type: 'url', name: MCP_SERVER_NAME, url: dataverseMcpUrl(), authorization_token: dvToken },
    ]

    const stream = client().beta.messages.stream(
      {
        model:       LLM_MODEL,
        max_tokens:  MAX_TOKENS,
        system,
        messages,
        tools,
        mcp_servers: mcpServers,
        betas:       [MCP_BETA],
      },
      { signal: timer.signal },
    )

    // 블록 인덱스별 조립 버퍼 — text_delta/input_json_delta는 스트리밍으로 조각나 온다.
    interface Acc { block: ContentBlock; jsonBuf: string }
    const blocks = new Map<number, Acc>()
    // mcp_tool_use의 이름/입력을 기억해뒀다가, 뒤이어 오는 mcp_tool_result와 짝지어
    // 'mcp_call' 이벤트로 표시한다 (tool_use_id로 상관관계 매칭).
    const mcpCallInfo = new Map<string, { name: string; input: Record<string, unknown> }>()

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        const b = event.content_block
        if (b.type === 'text') {
          blocks.set(event.index, { block: { type: 'text', text: '', citations: null }, jsonBuf: '' })
        } else if (b.type === 'tool_use') {
          blocks.set(event.index, { block: { type: 'tool_use', id: b.id, name: b.name, input: {} }, jsonBuf: '' })
          yield { type: 'tool_start', name: b.name }   // 커스텀 도구 — 인자 완성 전에 즉시 알림
        } else if (b.type === 'mcp_tool_use') {
          blocks.set(event.index, {
            block: { type: 'mcp_tool_use', id: b.id, name: b.name, input: {}, server_name: b.server_name },
            jsonBuf: '',
          })
        } else if (b.type === 'mcp_tool_result') {
          blocks.set(event.index, {
            block: { type: 'mcp_tool_result', tool_use_id: b.tool_use_id, is_error: b.is_error, content: b.content },
            jsonBuf: '',
          })
        } else {
          // thinking/서버도구 등 이 프로젝트에서 안 쓰는 블록 타입 — 그대로 통과만 시킨다
          blocks.set(event.index, { block: b as ContentBlock, jsonBuf: '' })
        }
      } else if (event.type === 'content_block_delta') {
        const acc = blocks.get(event.index)
        if (!acc) continue
        const delta = event.delta
        if (delta.type === 'text_delta' && acc.block.type === 'text') {
          acc.block.text += delta.text
          yield { type: 'text', text: delta.text }
        } else if (delta.type === 'input_json_delta') {
          acc.jsonBuf += delta.partial_json
        }
      } else if (event.type === 'content_block_stop') {
        const acc = blocks.get(event.index)
        if (!acc) continue

        if ((acc.block.type === 'tool_use' || acc.block.type === 'mcp_tool_use') && acc.jsonBuf) {
          try { acc.block.input = JSON.parse(acc.jsonBuf) as Record<string, unknown> } catch { /* 빈 입력 유지 */ }
        }
        if (acc.block.type === 'mcp_tool_use') {
          mcpCallInfo.set(acc.block.id, { name: acc.block.name, input: (acc.block.input ?? {}) as Record<string, unknown> })
        }
        if (acc.block.type === 'mcp_tool_result') {
          const info = mcpCallInfo.get(acc.block.tool_use_id)
          const preview = typeof acc.block.content === 'string'
            ? acc.block.content
            : JSON.stringify(acc.block.content)
          yield {
            type:          'mcp_call',
            name:          info?.name ?? '(mcp)',
            input:         info?.input ?? {},
            resultPreview: preview.slice(0, 500),
            isError:       acc.block.is_error,
          }
        }
      }
    }

    const final = await stream.finalMessage()
    const usage: Usage = {
      prompt_tokens:     final.usage.input_tokens,
      completion_tokens: final.usage.output_tokens,
      cached_tokens:     final.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens:  final.usage.cache_creation_input_tokens ?? 0,
    }

    yield { type: 'done', content: final.content.map(toParamBlock), stopReason: final.stop_reason, usage }
  } catch (e) {
    const err = e as Error
    if (err.name === 'AbortError') {
      throw new Error(opts.signal?.aborted ? '요청이 취소되었습니다.' : `Claude API 응답 타임아웃 (${timeoutMs / 1000}초)`)
    }
    throw new Error(`Claude API 호출 실패: ${err.message}`)
  } finally {
    clearTimeout(to)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

/** Claude API 상태 확인 — /api/health 가 의존성 표시에 쓴다. */
export async function anthropicHealth(timeoutMs = 3000): Promise<Record<string, unknown> | null> {
  if (!anthropicConfigured()) return null
  try {
    await client().models.retrieve(LLM_MODEL, null, { timeout: timeoutMs })
    return { status: 'ok', model: LLM_MODEL }
  } catch (e) {
    return { status: 'unreachable', error: (e as Error).message }
  }
}

export { EMPTY_USAGE }
