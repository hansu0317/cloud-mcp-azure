import { useState } from 'react'
import type { QueryLog } from '../types'

interface Props {
  queries: QueryLog[]
}

function formatInput(input: Record<string, unknown>): string {
  // OData query string
  if (typeof input.query === 'string')    return input.query
  // FetchXML
  if (typeof input.fetchXml === 'string') return input.fetchXml
  // search
  if (typeof input.searchQuery === 'string') return input.searchQuery
  // table name for describe
  if (typeof input.entityName === 'string') return `entity: ${input.entityName}`
  // fallback: pretty JSON
  return JSON.stringify(input, null, 2)
}

function toolLabel(tool: string): string {
  const map: Record<string, string> = {
    'read_query':   'OData 쿼리',
    'search':       '전체 텍스트 검색',
    'search_data':  '구조화 검색',
    'describe':     '스키마 조회',
    'file_download':'파일 다운로드',
  }
  return map[tool] ?? tool
}

export default function QueryPanel({ queries }: Props) {
  const [open, setOpen] = useState(false)

  return (
    <div className="query-panel">
      <button
        className="query-panel-toggle"
        onClick={() => setOpen(o => !o)}
        title="사용된 쿼리 보기"
      >
        <span className="query-panel-icon">📋</span>
        <span>사용된 쿼리 ({queries.length}개)</span>
        <span className="query-panel-arrow">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="query-panel-body">
          {queries.map((q, i) => (
            <div key={`${q.tool}-${i}`} className="query-entry">
              <div className="query-entry-header">
                <span className="query-tool-badge">{toolLabel(q.tool)}</span>
              </div>
              <pre className="query-code">{formatInput(q.input)}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
