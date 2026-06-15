// Groq Text-to-SQL 핸들러
// 자연어 질문 → OData 쿼리 자동 생성·실행 → 결과 요약
// 기존 Claude(/api/chat)와 동일한 SSE 포맷으로 응답

import Groq from 'groq-sdk'
import type { Request, Response } from 'express'
import fs   from 'fs'
import path from 'path'
import log  from './logger.js'
import { dvReadQuery, dvSearch, isDataverseConfigured } from './dataverse.js'

const GROQ_MODEL      = process.env.GROQ_MODEL      ?? 'llama-3.3-70b-versatile'
const GROQ_TIMEOUT_MS = parseInt(process.env.GROQ_TIMEOUT_MS ?? '60000')
const CWD             = process.cwd()
const SCHEMA_FILE     = path.join(CWD, 'data', 'schema.json')

// ─── 세션 이력 (Groq는 stateless — 서버에서 대화 이력 보관) ─────────────────
interface GroqMsg { role: 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string; name?: string }
const groqSessions = new Map<string, { msgs: GroqMsg[]; lastUsed: number }>()
setInterval(() => {
  const cut = Date.now() - 24 * 60 * 60 * 1000
  for (const [id, s] of groqSessions) if (s.lastUsed < cut) groqSessions.delete(id)
}, 60 * 60 * 1000).unref()

// ─── 스키마 컨텍스트 (schema.json 기반) ─────────────────────────────────────
function loadSchema(): string {
  try {
    const data = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8')) as
      Record<string, { schema?: string; label?: string }>
    const lines = ['=== Dataverse 테이블 스키마 ===']
    for (const [table, info] of Object.entries(data)) {
      if (!info.schema) continue
      lines.push(`\n[${table}${info.label ? ` / ${info.label}` : ''}]`)
      lines.push(info.schema)
    }
    return lines.join('\n')
  } catch { return '(스키마 없음)' }
}

// ─── Groq 도구 정의 ──────────────────────────────────────────────────────────
const TOOLS: Groq.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'execute_odata',
      description:
        'Dataverse OData API를 호출해 데이터를 조회합니다. ' +
        '반드시 스키마에 있는 컬럼명을 사용하세요. ' +
        '예시: "new_q1?$select=new_name,new_d_machul&$top=10&$filter=statecode eq 0&$orderby=new_d_machul desc"',
      parameters: {
        type: 'object',
        properties: {
          odata: {
            type: 'string',
            description: 'OData URL 경로 + 쿼리 옵션. 엔티티명부터 시작. 예: "new_q1?$select=new_name&$top=5"',
          },
          reason: {
            type: 'string',
            description: '이 쿼리로 무엇을 조회하는지 한 줄 설명',
          },
        },
        required: ['odata'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_keyword',
      description:
        '키워드 전체 텍스트 검색. 회사명·사람 이름 등 특정 값을 찾을 때 사용합니다.',
      parameters: {
        type: 'object',
        properties: {
          keyword:  { type: 'string', description: '검색 키워드' },
          entities: {
            type: 'array', items: { type: 'string' },
            description: '검색할 테이블 목록 (비우면 전체)',
          },
        },
        required: ['keyword'],
      },
    },
  },
]

// ─── 시스템 프롬프트 ─────────────────────────────────────────────────────────
function systemPrompt(): string {
  return `당신은 Quali CRM Dataverse 전문 Text-to-SQL 어시스턴트입니다.
사용자의 자연어 질문을 받아 OData 쿼리를 생성·실행해 결과를 보여줍니다.

규칙:
1. 데이터 관련 질문이면 반드시 execute_odata 또는 search_keyword 도구를 먼저 호출하세요.
2. 스키마에 있는 컬럼명을 정확히 사용하세요 (오타 금지).
3. 결과는 한국어 마크다운 표로 정리하세요.
4. 숫자/금액은 천 단위 콤마 포함 (예: 1,500,000).
5. 데이터가 없으면 "조건에 맞는 데이터가 없습니다"라고 안내하세요.
6. 데이터 변경(생성·수정·삭제)은 절대 하지 마세요. 조회 전용입니다.
7. $top 기본값은 20, 명시적 요청 없으면 최대 50.
8. statecode eq 0 필터를 기본으로 적용해 활성 레코드만 조회하세요.

응답 형식: 핵심 요약 1줄 → 표 → 인사이트 (필요 시)

${loadSchema()}`
}

// ─── 핸들러 ──────────────────────────────────────────────────────────────────
export async function groqChat(req: Request, res: Response): Promise<void> {
  const { message, sessionId } = req.body as { message: string; sessionId: string }

  if (!message || !sessionId) {
    res.status(400).json({ error: 'message와 sessionId가 필요합니다.' })
    return
  }
  if (!process.env.GROQ_API_KEY) {
    res.status(503).json({ error: '.env에 GROQ_API_KEY가 설정되지 않았습니다.' })
    return
  }
  if (!isDataverseConfigured()) {
    res.status(503).json({ error: '.env에 DATAVERSE_TENANT_ID / CLIENT_ID / CLIENT_SECRET 설정이 필요합니다.' })
    return
  }

  res.setHeader('Content-Type',      'text/event-stream')
  res.setHeader('Cache-Control',     'no-cache')
  res.setHeader('Connection',        'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const send = (data: object) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`) }

  // 세션 이력
  let session = groqSessions.get(sessionId)
  if (!session) { session = { msgs: [], lastUsed: Date.now() }; groqSessions.set(sessionId, session) }
  session.lastUsed = Date.now()
  session.msgs.push({ role: 'user', content: message })

  log.info('GROQ TEXT-TO-SQL', message.slice(0, 200))
  const startMs = Date.now()

  const timer = setTimeout(() => {
    send({ type: 'error', message: '응답 시간 초과' })
    if (!res.writableEnded) res.end()
  }, GROQ_TIMEOUT_MS)

  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
    let finalText = ''

    // 도구 호출 루프 (최대 5라운드)
    for (let round = 0; round < 5; round++) {
      const completion = await groq.chat.completions.create({
        model:       GROQ_MODEL,
        messages:    [
          { role: 'system', content: systemPrompt() },
          ...session.msgs,
        ] as Groq.Chat.ChatCompletionMessageParam[],
        tools:       TOOLS,
        tool_choice: round === 0 ? 'required' : 'auto', // 첫 라운드는 반드시 도구 사용
        temperature: 0.05, // SQL 생성은 낮은 temperature
        max_tokens:  4096,
        stream:      false,
      })

      const choice    = completion.choices[0]
      const msg       = choice.message
      const toolCalls = msg.tool_calls ?? []

      // assistant 메시지 이력 추가
      session.msgs.push({ role: 'assistant', content: msg.content ?? '' })

      // 도구 호출 없음 = 최종 답변
      if (toolCalls.length === 0) {
        finalText = msg.content ?? ''
        if (finalText) send({ type: 'text', text: finalText })
        break
      }

      // 도구 실행
      for (const tc of toolCalls) {
        const fn   = tc.function.name
        const args = JSON.parse(tc.function.arguments ?? '{}') as Record<string, unknown>

        send({ type: 'tool', name: fn })
        send({ type: 'query', tool: fn, input: args })
        log.info('GROQ 쿼리', `[${fn}] ${JSON.stringify(args).slice(0, 150)}`)

        let result: unknown
        try {
          if      (fn === 'execute_odata')   result = await dvReadQuery(args.odata as string)
          else if (fn === 'search_keyword')  result = await dvSearch(args.keyword as string, args.entities as string[] | undefined)
          else                               result = { error: `알 수 없는 도구: ${fn}` }
        } catch (err) {
          result = { error: String(err) }
          log.error('GROQ 도구 오류', String(err))
        }

        session.msgs.push({
          role:         'tool',
          tool_call_id: tc.id,
          name:         fn,
          content:      JSON.stringify(result),
        })
      }
    }

    clearTimeout(timer)
    const sec = ((Date.now() - startMs) / 1000).toFixed(1)
    log.info('GROQ 완료', `${finalText.slice(0, 80)} (${sec}초)`)
    send({ type: 'done' })
  } catch (err) {
    clearTimeout(timer)
    log.error('GROQ 오류', String(err))
    send({ type: 'error', message: `Groq 오류: ${String(err)}` })
  } finally {
    if (!res.writableEnded) res.end()
  }
}
