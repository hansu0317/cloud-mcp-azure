import { useEffect, useRef, useState } from 'react'
import { getUsage } from '../api'
import type { UsageRow, UsageSummary } from '../types'

interface Props {
  projectId: string | null
}

const fmtNum = (n: number) => n.toLocaleString('ko-KR')
const fmtUsd = (n: number) => (n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`)

function UsageRowView({ title, row }: { title: string; row: UsageRow }) {
  return (
    <div className="usage-row">
      <div className="usage-row-title">{title}</div>
      <div className="usage-row-body">
        <span>질문 {fmtNum(row.questions)}회</span>
        <span>토큰 in {fmtNum(row.inputTokens)} · out {fmtNum(row.outputTokens)}</span>
        {(row.cacheReadTokens > 0 || row.cacheWriteTokens > 0) && (
          <span>캐시 read {fmtNum(row.cacheReadTokens)} · write {fmtNum(row.cacheWriteTokens)}</span>
        )}
      </div>
      <div className="usage-row-cost">
        {fmtUsd(row.costUsd)}
        {!row.costKnown && <span className="usage-row-cost-note"> (로컬 모델 요청 포함 — 실제는 더 적음)</span>}
      </div>
    </div>
  )
}

// 헤더의 "💰 사용량" 버튼 — 눌렀을 때만 GET /api/usage를 불러와 오늘/이 프로젝트/전체
// 누적 토큰·예상 비용을 보여준다. 로그 파일에만 있던 수치를 화면에서 볼 수 있게
// 해달라는 피드백(2026-08-24)으로 추가 — 집계는 전부 서버(backend/usage.py)가 하고
// 여기선 숫자만 그린다.
export default function UsagePanel({ projectId }: Props) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<UsageSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(false)
    getUsage(projectId ?? undefined)
      .then(setData)
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [open, projectId])

  // 팝오버 바깥을 누르면 닫는다 — 전체화면 배경 오버레이 대신 바깥 클릭 감지만 쓴다
  // (버튼 바로 아래 작은 팝오버라 화면을 덮는 배경까진 필요 없음).
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div className="usage-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`btn${open ? ' active' : ''}`}
        onClick={() => setOpen(o => !o)}
        title="토큰 사용량·예상 비용"
      >
        💰 사용량
      </button>
      {open && (
        <div className="usage-popover">
          <div className="usage-popover-hdr">
            사용량 · 예상 비용
            <span className="usage-popover-note">Claude API 요금표 기준 추정치 — 실제 청구액과 다를 수 있습니다</span>
          </div>
          {loading && <div className="usage-loading">불러오는 중…</div>}
          {error && <div className="usage-loading">불러오지 못했습니다</div>}
          {!loading && !error && data && (
            <>
              <UsageRowView title="오늘" row={data.today} />
              {data.project && <UsageRowView title="이 프로젝트 전체" row={data.project.allTime} />}
              <UsageRowView title="전체 누적" row={data.allTime} />
            </>
          )}
        </div>
      )}
    </div>
  )
}
