// Dataverse의 모든 커스텀 테이블에 자동으로 붙는 시스템 감사·소유권·통화 컬럼 —
// 업무 용어의 대상도, 테이블-테이블 연결 다이어그램에 보여줄 대상도 아니다(전자는
// InstructionsPanel의 용어 탭, 후자는 RelationshipDiagram이 같은 기준으로 걸러낸다).
// Lookup 타입(예: ownerid, transactioncurrencyid)도 포함한다 — 값 자체는 다른
// 테이블을 가리키지만 systemuser/team/transactioncurrency처럼 프로젝트 업무 테이블이
// 아닌 Dataverse 플랫폼 엔터티를 가리켜서, 다이어그램에 그대로 두면 실제 업무
// 관계(new_l_* 등)보다 시스템 컬럼이 더 많아 보이는 원인이 된다.
export const NOISE_COLUMN_RE =
  /^(createdby|createdon|createdonbehalfby|modifiedby|modifiedon|modifiedonbehalfby|ownerid|owningbusinessunit|owningteam|owninguser|transactioncurrencyid|versionnumber|importsequencenumber|timezoneruleversionnumber|utcconversiontimezonecode|overriddencreatedon)/i

// Lookup/Owner/Customer 컬럼은 모두 "이 컬럼이 다른 엔티티를 가리킨다"는 같은 의미다 —
// 조인 시작점(수동 추가 드롭다운, 연결 다이어그램)을 고를 때 공용으로 쓴다.
export const LOOKUP_TYPES = new Set(['Lookup', 'Owner', 'Customer'])

// 조인 하나를 식별하는 키 — 중복 방지(추가 시)와 "이미 있는 걸 후보 목록에서
// 숨기기"(자동 후보) 양쪽에서 InstructionsPanel과 RelationshipDiagram이 같이 쓴다.
export const joinKey = (j: { fromTable: string; fromCol: string; toTable: string; toCol: string }) =>
  `${j.fromTable}.${j.fromCol}>${j.toTable}.${j.toCol}`
