// Dataverse OData 클라이언트 — Groq 핸들러에서 직접 API 호출할 때 사용
// 인증: Client Credentials (서비스 주체 필요)
// .env 필수: DATAVERSE_URL, DATAVERSE_TENANT_ID, DATAVERSE_CLIENT_ID, DATAVERSE_CLIENT_SECRET

const DATAVERSE_URL    = process.env.DATAVERSE_URL    ?? ''
const TENANT_ID        = process.env.DATAVERSE_TENANT_ID  ?? ''
const CLIENT_ID        = process.env.DATAVERSE_CLIENT_ID  ?? ''
const CLIENT_SECRET    = process.env.DATAVERSE_CLIENT_SECRET ?? ''

interface TokenCache { token: string; expires: number }
let tokenCache: TokenCache | null = null

export async function getDataverseToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expires) return tokenCache.token

  const resp = await fetch(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        scope:         `${DATAVERSE_URL}/.default`,
      }),
    }
  )
  if (!resp.ok) {
    const err = await resp.text()
    throw new Error(`Dataverse 토큰 발급 실패: ${err}`)
  }
  const data = await resp.json() as { access_token: string; expires_in: number }
  tokenCache = { token: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 }
  return tokenCache.token
}

// OData 쿼리 실행 — querytext 예: "new_q1?$select=new_name,new_d_machul&$top=10&$filter=..."
export async function dvReadQuery(querytext: string): Promise<unknown> {
  const token = await getDataverseToken()
  const url   = `${DATAVERSE_URL}/api/data/v9.2/${querytext}`
  const resp  = await fetch(url, {
    headers: {
      Authorization:    `Bearer ${token}`,
      Accept:           'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version':    '4.0',
      Prefer:           'odata.maxpagesize=50',
    },
  })
  return resp.json()
}

// 전체 텍스트 검색
export async function dvSearch(search: string, entities?: string[]): Promise<unknown> {
  const token = await getDataverseToken()
  const resp  = await fetch(`${DATAVERSE_URL}/api/search/v1.0/query`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ search, entities: entities ?? [], top: 20 }),
  })
  return resp.json()
}

export function isDataverseConfigured(): boolean {
  return Boolean(TENANT_ID && CLIENT_ID && CLIENT_SECRET)
}
