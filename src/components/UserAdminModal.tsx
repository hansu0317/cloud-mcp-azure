import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { listAdminUsers, upsertAdminUser, deleteAdminUser, type AdminUser } from '../api'

interface Props {
  onClose: () => void
}

// 2026-08-25: 처음엔 .env의 ADMIN_EMAILS 한 줄이 전부였는데, "서버 파일을 직접
// 고쳐야 하고 재시작까지 해야 한다"는 피드백으로 이 화면을 만들었다(data/users.json
// + /api/admin/users, backend/auth/users.py 참고). 여기 있는 이메일만 로그인할 수
// 있다(화이트리스트) — 관리자만 Header에서 열 수 있고, 여기서 바꾸면 재시작 없이
// 다음 로그인부터 바로 반영된다(이미 로그인된 세션의 관리자 여부는 그 세션이
// 끝날 때까지는 안 바뀐다 — "계정 전환"으로 다시 로그인해야 새 값이 보인다).
export default function UserAdminModal({ onClose }: Props) {
  const [users,   setUsers]   = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  const [newEmail, setNewEmail] = useState('')
  const [newAdmin, setNewAdmin] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    listAdminUsers()
      .then(setUsers)
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = async (user: AdminUser) => {
    setError(null)
    try {
      const saved = await upsertAdminUser(user)
      setUsers(prev => {
        const i = prev.findIndex(u => u.email === saved.email)
        if (i === -1) return [...prev, saved]
        const next = [...prev]
        next[i] = saved
        return next
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const remove = async (email: string) => {
    if (!window.confirm(`"${email}"을(를) 목록에서 지울까요?\n이 사람은 더 이상 로그인할 수 없게 됩니다.`)) return
    setError(null)
    try {
      await deleteAdminUser(email)
      setUsers(prev => prev.filter(u => u.email !== email))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const addNew = async () => {
    const email = newEmail.trim()
    if (!email) return
    await save({ email, isAdmin: newAdmin })
    setNewEmail(''); setNewAdmin(false)
  }

  return createPortal(
    <div className="ts-modal" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="ts-modal-inner user-admin-modal">
        <div className="ts-modal-hdr">
          <div>
            <div className="ts-modal-title">👥 사용자 관리</div>
            <div className="ts-modal-sub">여기 등록된 이메일만 로그인할 수 있습니다 — 바꾸면 재시작 없이 바로 반영됩니다</div>
          </div>
          <button className="btn btn-xs" onClick={onClose}>✕</button>
        </div>

        <div className="ts-modal-body">
          {error && <div className="login-gate-error user-admin-error">{error}</div>}
          {loading && <div className="sb-empty">불러오는 중…</div>}
          {!loading && users.length === 0 && <div className="sb-empty">등록된 사용자가 없습니다</div>}

          {!loading && users.length > 0 && (
            <div className="user-admin-table">
              <div className="user-admin-row user-admin-row-hdr">
                <span>이메일</span>
                <span>관리자</span>
                <span />
              </div>
              {users.map(u => (
                <div className="user-admin-row" key={u.email}>
                  <span className="user-admin-email" title={u.email}>{u.email}</span>
                  <input
                    type="checkbox"
                    checked={u.isAdmin}
                    onChange={e => save({ ...u, isAdmin: e.target.checked })}
                  />
                  <button className="btn-xs proj-act-btn danger" title="삭제" onClick={() => remove(u.email)}>🗑</button>
                </div>
              ))}
            </div>
          )}

          <div className="user-admin-add">
            <input
              className="proj-new-input"
              placeholder="새 사용자 이메일"
              value={newEmail}
              onChange={e => setNewEmail(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addNew() }}
            />
            <label className="user-admin-add-admin" title="관리자로 추가">
              <input type="checkbox" checked={newAdmin} onChange={e => setNewAdmin(e.target.checked)} />
              관리자
            </label>
            <button className="btn btn-sm primary" onClick={addNew} disabled={!newEmail.trim()}>추가</button>
          </div>
        </div>

        <div className="ts-modal-ftr">
          <div className="h-spacer" />
          <button className="btn" onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>,
    document.body
  )
}
