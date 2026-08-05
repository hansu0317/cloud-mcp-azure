# claudeapi — 채팅 백엔드 (Claude API + Dataverse 네이티브 MCP)

프로세스 spawn 없이 `api.anthropic.com`에 직접 호출합니다(`server/claude-client.ts`,
`@anthropic-ai/sdk`). 도구는 두 갈래입니다:

- **`search` / `describe`** — Dataverse가 네이티브로 제공하는 MCP 엔드포인트
  (`${DATAVERSE_URL}/api/mcp`)를 Anthropic의 MCP 커넥터로 직접 연결. 실행은
  Anthropic 인프라 쪽에서 일어난다 — 이 서버는 결과를 받아 SSE로 표시만 한다.
- **`dataverse_query`** — 이 프로젝트가 정의·실행하는 유일한 데이터 조회 도구.
  `server/dataverse.ts`(서비스 주체 client_credentials + OData GET)로 직접 조회하고,
  엔티티집합명 화이트리스트 + `$top=100` 상한 가드를 통과해야 실행된다.

> 2026-07: 초기의 Claude Code CLI spawn 경로와 비교 운영 후 API 모드로 단일화.
> 2026-08: hsagent LLM 게이트웨이 경유를 거쳤다가 다시 걷어내고, Claude API 직접 호출 +
> Dataverse 네이티브 MCP 커넥터 하이브리드로 재구성했다(text-to-SQL 전용 프로젝트로 단일화).

## 엔드포인트

- `POST /api/chat`
  - 요청: `{ message, sessionId }`
  - 응답(SSE): `text` / `tool` / `query` / `error` / `done`

## 특징

- **속도**: 상주 HTTP + 시스템 프롬프트(카탈로그) prompt caching — 반복 질문 지연·비용↓
- **보안(조회 전용, 다중 방어)**:
  - MCP 도구 화이트리스트(`server/claude-client.ts`의 `mcp_toolset`)에서 `search`/`describe`
    외 나머지(쓰기 도구 전부와 `read_query`)는 모델 도구 목록에 애초에 노출되지 않는다 — 하드 차단.
  - `dataverse_query`는 OData 가드(엔티티집합명 화이트리스트 + `$top=100` 강제)를
    통과해야 실행된다 — 환각 경로·무제한 조회 차단. MCP `read_query`를 쓰지 않는 이유가
    이 가드다: MCP 실행은 서버 코드를 거치지 않아 이 훅을 걸 수 없다.
- **오류 내성**: 요청 실패 시 히스토리 롤백(세션 파손 방지), MCP describe 결과는 답변 후
  히스토리에서 컴팩션(토큰 급증 방지)

## 필요 환경변수 (루트 `.env`)

| 변수 | 필수 | 설명 |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | Anthropic API 키. 미설정 시 채팅 라우트 미등록 |
| `DATAVERSE_TENANT_ID` `DATAVERSE_CLIENT_ID` `DATAVERSE_CLIENT_SECRET` `DATAVERSE_URL` | ✅ | 서비스 주체 자격 증명 — Dataverse Web API(OData GET)와 MCP 엔드포인트 양쪽에 같은 토큰이 통한다 |
| `LLM_MODEL` | — | 기본값 `claude-haiku-4-5` (데모 속도 우선) |
| `MAX_CONCURRENT_API` | — | 기본값 `10` (동시 Claude API 스트림 수) |

## 실행

```bash
npm install
npm run dev          # 서버 + 프론트 동시 실행
```

기동 로그에 `채팅 엔드포인트 등록됨 — POST /api/chat` 이 출력됩니다.

## 구현 메모

- 세션별 대화 히스토리는 인메모리(`historyMap`, 최근 20메시지) — 데모용.
  다중 인스턴스/영속화가 필요하면 외부 스토어로 교체.
- 히스토리 트리밍은 "순수 텍스트 user 메시지"(진짜 질문) 경계에서만 자른다 —
  tool_use/tool_result(또는 mcp_tool_use/mcp_tool_result) 쌍이 깨지면 그 세션의
  모든 후속 요청이 400으로 실패하기 때문.
