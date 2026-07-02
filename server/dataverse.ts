// ─────────────────────────────────────────────────────────────────────────────
// Dataverse Web API 직접 연결 (Claude Code/API 불필요 — 순수 REST)
//
// 서비스 주체(client_credentials)로 토큰을 받아 Dataverse Web API/메타데이터를
// 직접 호출한다. 스키마 갱신(EntityDefinitions)과 데이터 조회(OData GET) 양쪽에서
// 공용으로 쓰는 인증·fetch 로직만 여기 둔다. LLM 호출은 이 파일에 전혀 없음.
//
// 필요 환경변수: DATAVERSE_TENANT_ID / DATAVERSE_CLIENT_ID /
//               DATAVERSE_CLIENT_SECRET / DATAVERSE_URL
// ─────────────────────────────────────────────────────────────────────────────

const TENANT_ID  = process.env.DATAVERSE_TENANT_ID     ?? ''
const CLIENT_ID  = process.env.DATAVERSE_CLIENT_ID     ?? ''
const CLIENT_SEC = process.env.DATAVERSE_CLIENT_SECRET ?? ''
const DV_URL     = (process.env.DATAVERSE_URL ?? '').replace(/\/$/, '')
const API_VERSION = 'v9.2'
const REQUEST_TIMEOUT_MS = parseInt(process.env.DESCRIBE_TIMEOUT_MS ?? '60000')

export function dataverseEnvMissing(): string | null {
  if (!TENANT_ID)  return 'DATAVERSE_TENANT_ID'
  if (!CLIENT_ID)  return 'DATAVERSE_CLIENT_ID'
  if (!CLIENT_SEC) return 'DATAVERSE_CLIENT_SECRET'
  if (!DV_URL)     return 'DATAVERSE_URL'
  return null
}

// ─── 액세스 토큰 (client_credentials, 캐시) ──────────────────────────────────
let tokenCache: { value: string; expMs: number } | null = null

export async function getDataverseToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expMs - 60_000) return tokenCache.value

  const tokenUrl = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`
  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SEC,
    scope:         `${DV_URL}/.default`,
  })
  const resp = await fetch(tokenUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!resp.ok) throw new Error(`토큰 발급 실패 (${resp.status}): ${(await resp.text()).slice(0, 200)}`)
  const data = await resp.json() as { access_token: string; expires_in: number }
  tokenCache = { value: data.access_token, expMs: Date.now() + data.expires_in * 1000 }
  return data.access_token
}

// ─── Dataverse Web API 인증된 GET (원문 Response 반환) ──────────────────────
export async function dataverseFetch(relPath: string): Promise<Response> {
  const token = await getDataverseToken()
  const clean = relPath.replace(/^\/+/, '')
  const url   = `${DV_URL}/api/data/${API_VERSION}/${clean}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(url, {
      method:  'GET',
      signal:  controller.signal,
      headers: {
        Authorization:      `Bearer ${token}`,
        Accept:             'application/json',
        'OData-MaxVersion': '4.0',
        'OData-Version':    '4.0',
        Prefer:             'odata.include-annotations="OData.Community.Display.V1.FormattedValue"',
      },
    })
  } finally {
    clearTimeout(timer)
  }
}

// ─── 데이터 조회용 GET (텍스트 반환, 호출측에서 truncate 등 가공) ────────────
// 자가 복구 2종:
//  - 네트워크 레벨(TypeError: fetch failed 등) 순간 오류 → 300ms 후 1회 재시도
//  - 401 Unauthorized(시크릿 로테이션·토큰 조기 폐기 등) → 토큰 캐시 무효화 후 1회 재발급 재시도
// 그 외 HTTP 오류(404/400/5xx)는 그대로 던져 호출측(모델의 tool_result)에 전달한다.
export async function dataverseGet(relPath: string): Promise<string> {
  const attempt = async () => {
    const resp = await dataverseFetch(relPath)
    return { resp, text: await resp.text() }
  }

  let r: { resp: Response; text: string }
  try {
    r = await attempt()
  } catch (e) {
    if (!(e instanceof TypeError)) throw e   // 네트워크 레벨 실패만 재시도
    await new Promise(res => setTimeout(res, 300))
    r = await attempt()
  }

  if (r.resp.status === 401) {
    tokenCache = null   // 캐시된 토큰이 서버측에서 무효화된 경우 — 새로 발급받아 재시도
    r = await attempt()
  }

  if (!r.resp.ok) throw new Error(`OData ${r.resp.status}: ${r.text.slice(0, 300)}`)
  return r.text
}

// ─── 엔티티 메타데이터 → 마크다운 스키마 표 (describe 대체, LLM 미사용) ──────
interface Label { UserLocalizedLabel?: { Label?: string } | null; LocalizedLabels?: { Label?: string }[] }
interface AttrMeta {
  LogicalName:    string
  AttributeType?: string
  DisplayName?:   Label
  RequiredLevel?: { Value?: string }
}
interface EntityMeta {
  EntitySetName?: string
  DisplayName?:   Label
  Attributes?:    AttrMeta[]
}
interface PicklistOption { Value: number; Label?: Label }
interface PicklistMeta { OptionSet?: { Options?: PicklistOption[] }; GlobalOptionSet?: { Options?: PicklistOption[] } }

function labelOf(l: Label | undefined, fallback: string): string {
  return l?.UserLocalizedLabel?.Label ?? l?.LocalizedLabels?.[0]?.Label ?? fallback
}

async function fetchPicklistOptions(logicalName: string, attrLogicalName: string): Promise<string | null> {
  try {
    const path = `EntityDefinitions(LogicalName='${logicalName}')/Attributes(LogicalName='${attrLogicalName}')`
      + `/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName`
      + `&$expand=OptionSet($select=Options),GlobalOptionSet($select=Options)`
    const text = await dataverseGet(path)
    const meta = JSON.parse(text) as PicklistMeta
    const options = meta.OptionSet?.Options ?? meta.GlobalOptionSet?.Options ?? []
    if (options.length === 0) return null
    return options.map(o => labelOf(o.Label, String(o.Value))).join(' / ')
  } catch {
    return null   // 옵션 라벨은 부가 정보 — 실패해도 전체 갱신은 막지 않음
  }
}

export interface EntitySchemaResult {
  entitySetName: string
  markdown:      string
}

export async function fetchEntitySchema(logicalName: string): Promise<EntitySchemaResult> {
  const path = `EntityDefinitions(LogicalName='${logicalName}')`
    + `?$select=EntitySetName,DisplayName`
    + `&$expand=Attributes($select=LogicalName,AttributeType,DisplayName,RequiredLevel)`
  const text = await dataverseGet(path)
  const meta = JSON.parse(text) as EntityMeta
  const attrs = meta.Attributes ?? []
  if (attrs.length === 0) throw new Error('속성 정보를 가져오지 못했습니다.')

  // Choice(Picklist) 컬럼만 옵션 라벨을 병렬로 추가 조회 (그 외 타입은 REST 1회로 충분)
  const picklistAttrs = attrs.filter(a => a.AttributeType === 'Picklist')
  const optionEntries = await Promise.all(
    picklistAttrs.map(async a => [a.LogicalName, await fetchPicklistOptions(logicalName, a.LogicalName)] as const)
  )
  const optionMap = new Map(optionEntries)

  const rows = attrs.map(a => {
    const label    = labelOf(a.DisplayName, a.LogicalName)
    const required = a.RequiredLevel?.Value === 'ApplicationRequired' || a.RequiredLevel?.Value === 'SystemRequired'
    const options  = optionMap.get(a.LogicalName)
    const desc     = `${label}${options ? ` (${options})` : ''}${required ? ' (필수)' : ''}`
    return `| ${a.LogicalName} | ${a.AttributeType ?? '?'} | ${desc} |`
  })

  const markdown = ['| 컬럼명 | 타입 | 한국어 설명 |', '|---|---|---|', ...rows].join('\n')
  return { entitySetName: meta.EntitySetName ?? `${logicalName}s`, markdown }
}

// ─── schema.json 공용 타입 + 얇은 카탈로그 (컨텍스트 절약, LLM 진행형 조회용) ──
// 매 세션 첫 메시지에 23개 테이블 전체 컬럼(수만 자)을 다 넣으면 비용·속도가
// 나빠진다. 대신 "카탈로그"(테이블명·라벨·엔티티집합명 한 줄)만 넣고, 모델이
// 실제로 필요한 테이블에 한해 describe 도구를 호출해 전체 컬럼을 가져오게 한다.
export interface SchemaEntry {
  label?:         string
  domain?:        string
  schema?:        string
  updatedAt?:     string
  entitySetName?: string
}

export function buildCompactCatalog(data: Record<string, SchemaEntry>): string {
  return Object.entries(data)
    .filter(([, info]) => info.schema)
    .map(([table, info]) => {
      const label  = info.label ? ` (${info.label})` : ''
      const domain = info.domain ? ` [${info.domain}]` : ''
      const setName = info.entitySetName ? ` — 엔티티집합명: ${info.entitySetName}` : ''
      return `- ${table}${label}${domain}${setName}`
    })
    .join('\n')
}
