# claudeapi — 채팅 백엔드 (Claude API Messages)

프로세스 spawn 없이 `api.anthropic.com`에 직접 호출하고, Dataverse는
`server/dataverse.ts`(서비스 주체 client_credentials + OData GET)로 직접 조회합니다.

> 2026-07: 초기의 Claude Code CLI spawn 경로와 비교 운영 후 이 경로로 단일화.
> CLI 관련 코드(server/claude.ts, /api/chat CLI 라우트, 웹 모드 토글)는 제거됨.

## 엔드포인트

- `POST /api/chat`
  - 요청: `{ message, sessionId }`
  - 응답(SSE): `text` / `tool` / `query` / `error` / `done`

## 특징

- **속도**: 상주 HTTP + 시스템 프롬프트(카탈로그) prompt caching — 반복 질문 지연·비용↓
- **보안(조회 전용)**: 커스텀 도구 2종(`dataverse_query`, `dataverse_describe_table`)만
  정의 — 쓰기 도구는 애초에 존재하지 않음. OData 가드(엔티티집합명 화이트리스트 +
  `$top=100` 강제)로 환각 경로·무제한 조회 차단
- **오류 내성**: 요청 실패 시 히스토리 롤백(세션 파손 방지), describe 결과는 답변 후
  히스토리에서 컴팩션(토큰 급증 방지)

## 필요 환경변수 (루트 `.env`)

| 변수 | 필수 | 설명 |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | Anthropic API 키. 미설정 시 채팅 라우트 미등록 |
| `DATAVERSE_TENANT_ID` `DATAVERSE_CLIENT_ID` `DATAVERSE_CLIENT_SECRET` `DATAVERSE_URL` | ✅ | 서비스 주체 자격 증명 |
| `ANTHROPIC_MODEL` | — | 기본값 `claude-haiku-4-5` (데모 속도 우선) |
| `ANTHROPIC_MAX_TOKENS` | — | 기본값 `4096` |
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
- 히스토리 트리밍은 "일반 텍스트 user 메시지" 경계에서만 자른다 —
  tool_use/tool_result 쌍이 깨지면 그 세션의 모든 후속 요청이 400으로 실패하기 때문.
