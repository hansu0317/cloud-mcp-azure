# claudeapi — Claude API(Messages) 전용 백엔드

기존 Claude Code(CLI) 경로(`server/`, `POST /api/chat`)는 **그대로 두고**, 별도로 추가한
Claude API 경로입니다. 프로세스 spawn 없이 `api.anthropic.com`에 직접 호출하고,
Dataverse는 **원격 MCP 커넥터**로 연결합니다.

## 엔드포인트

- `POST /api/chat-api` — CLI 경로(`/api/chat`)와 **동일한 SSE 이벤트 포맷** 사용
  - 요청: `{ message, sessionId }`
  - 응답(SSE): `text` / `tool` / `query` / `error` / `done`

프론트엔드 노트북 셀 헤더의 **`⌨ Code` / `⚡ API` 토글**로 셀마다 실행 엔진을 선택합니다.
(`Code` = 기존 CLI `/api/chat`, `API` = 이 모듈 `/api/chat-api`)

## 특징

- **속도**: 상주 HTTP + 스키마/규칙 프롬프트 캐싱(반복 질문 지연·비용↓)
- **보안(조회 전용 유지)**: MCP 커넥터 `tool_configuration.allowed_tools`에
  읽기 5종(`read_query`, `search`, `search_data`, `describe`, `file_download`)만 허용
  → 쓰기 도구는 애초에 노출되지 않음
- **격리**: `@anthropic-ai/sdk` 미설치·오류 시 `server/index.ts`가 이 모듈을
  조용히 건너뜀 → 기존 CLI 경로는 영향 없음

## 필요 환경변수 (루트 `.env`)

| 변수 | 필수 | 설명 |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | Anthropic API 키 |
| `DATAVERSE_MCP_TOKEN` | ✅ | Dataverse MCP 접근용 Bearer 토큰 |
| `DATAVERSE_MCP_URL` | — | 기본값 `https://quali.crm5.dynamics.com/api/mcp` |
| `ANTHROPIC_MODEL` | — | 기본값 `claude-haiku-4-5` (데모 속도 우선) |
| `ANTHROPIC_MAX_TOKENS` | — | 기본값 `4096` |

## 실행

```bash
npm install          # @anthropic-ai/sdk 포함
npm run dev          # 서버 + 프론트 동시 실행
```

`.env`에 위 변수 설정 후 서버를 켜면 기동 로그에
`Claude API 엔드포인트 등록됨 — POST /api/chat-api` 가 출력됩니다.

## 구현 메모

- SDK 0.70.x 기준 MCP 커넥터 형식(beta `mcp-client-2025-04-04`,
  `mcp_servers[].tool_configuration.allowed_tools`)에 맞춰 작성됨.
- 세션별 대화 히스토리는 인메모리(`historyMap`, 최근 20메시지) — 데모용.
  다중 인스턴스/영속화가 필요하면 외부 스토어로 교체.
