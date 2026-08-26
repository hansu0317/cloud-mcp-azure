// Dataverse의 모든 커스텀 테이블에 자동으로 붙는 시스템 감사·소유권·통화 컬럼 —
// 업무 용어의 대상이 아니다(InstructionsPanel의 용어 탭이 이 기준으로 걸러낸다).
export const NOISE_COLUMN_RE =
  /^(createdby|createdon|createdonbehalfby|modifiedby|modifiedon|modifiedonbehalfby|ownerid|owningbusinessunit|owningteam|owninguser|transactioncurrencyid|versionnumber|importsequencenumber|timezoneruleversionnumber|utcconversiontimezonecode|overriddencreatedon)/i

// 조인 하나를 식별하는 키 — 중복 방지(추가 시)와 "이미 있는 걸 후보 목록에서
// 숨기기"(자동 후보) 양쪽에서 InstructionsPanel이 쓴다.
export const joinKey = (j: { fromTable: string; fromCol: string; toTable: string; toCol: string }) =>
  `${j.fromTable}.${j.fromCol}>${j.toTable}.${j.toCol}`
