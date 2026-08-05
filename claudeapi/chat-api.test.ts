import { describe, it, expect } from 'vitest'
import { trimHistory, compactDescribeResults, DESCRIBE_PLACEHOLDER, MAX_TURNS } from './chat-api'
import type { ChatMessage, ContentBlockParam } from '../server/claude-client'

// ─── 테스트 헬퍼 (Anthropic Messages API 포맷) ─────────────────────────────────
const user          = (text: string): ChatMessage => ({ role: 'user', content: text })
const assistantText = (text: string): ChatMessage => ({ role: 'assistant', content: [{ type: 'text', text }] })

const assistantToolUse = (id: string): ChatMessage => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id, name: 'dataverse_query', input: {} }],
})
const toolResultMsg = (id: string, content = '결과'): ChatMessage => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content }],
})

const mcpToolUse = (id: string, name: string): ContentBlockParam =>
  ({ type: 'mcp_tool_use', id, name, input: {}, server_name: 'dataverse' })
const mcpToolResult = (id: string, content: string, isError = false): ContentBlockParam =>
  ({ type: 'mcp_tool_result', tool_use_id: id, is_error: isError, content })
const assistantBlocks = (...blocks: ContentBlockParam[]): ChatMessage => ({ role: 'assistant', content: blocks })

describe('trimHistory', () => {
  it('상한 이내면 그대로 반환한다', () => {
    const msgs = Array.from({ length: 5 }, (_, i) => user(`q${i}`))
    expect(trimHistory(msgs)).toBe(msgs)
  })

  it('상한을 넘으면 "진짜 사용자 질문"(순수 텍스트 user) 경계에서만 자른다', () => {
    // length 25, MAX_TURNS 20 → 스캔 시작 인덱스 5. 인덱스 5에 user 를 둬서
    // "윈도우 안 첫 질문"이 바로 시작점임을 확인한다.
    const msgs: ChatMessage[] = []
    for (let i = 0; i < 5; i++) msgs.push(assistantText(`old${i}`))   // 0-4: 잘려나갈 부분
    msgs.push(user('boundary'))                                      // 5: 여기서부터 유지돼야 함
    msgs.push(assistantText('a1'))                                   // 6
    msgs.push(user('later'))                                         // 7: 이후에 나오는 질문 (첫 번째가 아님)
    for (let i = msgs.length; i < 25; i++) msgs.push(assistantText(`pad${i}`))

    expect(msgs.length).toBe(25)
    const trimmed = trimHistory(msgs)
    expect(trimmed.length).toBe(20)
    expect(trimmed[0]).toEqual(user('boundary'))
  })

  it('경계가 tool_use/tool_result 쌍 중간이면 다음 진짜 질문까지 건너뛴다 (반쪽 히스토리 방지)', () => {
    const msgs: ChatMessage[] = []
    for (let i = 0; i < 5; i++) msgs.push(assistantText(`old${i}`))  // 0-4
    msgs.push(assistantToolUse('call-1'))                            // 5: 스캔 시작점이지만 진짜 질문 아님
    msgs.push(toolResultMsg('call-1'))                               // 6: role은 user지만 tool_result 전달용 — 경계 아님
    msgs.push(user('real question'))                                 // 7: 진짜 경계
    for (let i = msgs.length; i < 25; i++) msgs.push(assistantText(`pad${i}`))

    const trimmed = trimHistory(msgs)
    expect(trimmed[0]).toEqual(user('real question'))
    // tool_use 만 있고 그 결과가 없는 조각, 또는 tool_result 만 남은 조각이 섞여 있으면 안 된다
    expect(trimmed.some(m => m.role === 'assistant' && Array.isArray(m.content)
      && m.content.some(b => b.type === 'tool_use'))).toBe(false)
    expect(trimmed.some(m => m.role === 'user' && Array.isArray(m.content)
      && m.content.some(b => b.type === 'tool_result'))).toBe(false)
  })

  it('윈도우 안에 질문 경계가 없으면(한 턴이 비정상적으로 긴 경우) 가장 최근 질문부터 유지한다', () => {
    const msgs: ChatMessage[] = [user('the only question')]
    for (let i = 1; i < 25; i++) msgs.push(assistantText(`long-turn-${i}`))  // 나머지 24개는 전부 비-질문

    const trimmed = trimHistory(msgs)
    expect(trimmed).toEqual(msgs)  // fallback: 처음(유일한) 질문부터 — 즉 전체 유지
  })

  it('진짜 사용자 질문이 아예 없으면 원본을 그대로 반환한다', () => {
    const msgs = Array.from({ length: 25 }, (_, i) => assistantText(`a${i}`))
    expect(trimHistory(msgs)).toBe(msgs)
  })

  it('MAX_TURNS 상수는 20이다 (회귀 확인용)', () => {
    expect(MAX_TURNS).toBe(20)
  })
})

describe('compactDescribeResults', () => {
  it('같은 assistant 메시지 안에서 describe 도구 결과만 placeholder로 치환한다', () => {
    const msgs: ChatMessage[] = [
      user('질문'),
      assistantBlocks(
        mcpToolUse('describe-1', 'describe'),
        mcpToolResult('describe-1', '## account\n| 컬럼 | 타입 |\n...'),
      ),
    ]
    const compacted = compactDescribeResults(msgs)
    expect(compacted).toBe(1)
    const block = (msgs[1] as { content: ContentBlockParam[] }).content[1]
    expect(block.type === 'mcp_tool_result' && block.content).toBe(DESCRIBE_PLACEHOLDER)
  })

  it('search 결과는 건드리지 않는다 (describe만 대상)', () => {
    const msgs: ChatMessage[] = [
      assistantBlocks(mcpToolUse('search-1', 'search'), mcpToolResult('search-1', '검색 결과 원문')),
    ]
    const compacted = compactDescribeResults(msgs)
    expect(compacted).toBe(0)
    const block = (msgs[0] as { content: ContentBlockParam[] }).content[1]
    expect(block.type === 'mcp_tool_result' && block.content).toBe('검색 결과 원문')
  })

  it('describe 도구 호출이 없으면 아무것도 건드리지 않는다', () => {
    const msgs: ChatMessage[] = [assistantBlocks(mcpToolResult('orphan-1', '스키마 원문'))]
    expect(compactDescribeResults(msgs)).toBe(0)
    const block = (msgs[0] as { content: ContentBlockParam[] }).content[0]
    expect(block.type === 'mcp_tool_result' && block.content).toBe('스키마 원문')
  })

  it('이미 placeholder인 메시지는 다시 세지 않는다 (멱등성)', () => {
    const msgs: ChatMessage[] = [
      assistantBlocks(mcpToolUse('describe-1', 'describe'), mcpToolResult('describe-1', '스키마 원문')),
    ]
    expect(compactDescribeResults(msgs)).toBe(1)
    expect(compactDescribeResults(msgs)).toBe(0)  // 두 번째 호출은 추가로 압축할 게 없다
  })

  it('assistant가 아닌 메시지나 문자열 content는 건드리지 않는다', () => {
    const msgs: ChatMessage[] = [
      user('질문'),
      assistantText('설명 텍스트'),
      toolResultMsg('other-call', '관련 없는 결과'),
    ]
    const compacted = compactDescribeResults(msgs)
    expect(compacted).toBe(0)
    const block = (msgs[2] as { content: ContentBlockParam[] }).content[0]
    expect(block.type === 'tool_result' && block.content).toBe('관련 없는 결과')
  })
})
