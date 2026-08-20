# Notion 인수인계 문서 — 링크와 검증 결과

`defineview/`(로컬 전용, git 미포함)에 있던 화면정의서·화면설계서·메뉴정의서·플로우차트·정책정의서·권한정의서·인프라아키텍처정의서·API정의서 8종 예시를 참고해, Notion에 이 프로젝트군의 인수인계 문서를 작성해 두었다. 2026-08-18 기준으로 실제 코드와 대조 검증한 결과를 아래에 남긴다. **Notion 페이지 자체는 이번에 수정하지 않았다** — 아래 표는 "무엇이 최신이고 무엇을 이 저장소 문서(HANDOVER.md)로 대신 봐야 하는지"를 위한 참고용이다.

## 링크

- **허브(시작점)**: [CRM AI Chat](https://app.notion.com/p/CRM-AI-Chat-3b5bcaaf1f52814f8843e4bcab4e1791) — 여기서 "처음 보시는 분은 여기부터" 콜아웃을 따라가면 마스터 인수인계 문서로 연결된다.
- [CRM AI Chat — 인수인계 마스터 문서 (3종 완전정리)](https://app.notion.com/p/3babcaaf1f5281c39db5c5c3dbbfb04c) — 프로젝트 비교, 아키텍처, 인프라, Azure 서비스 주체 생성 절차
- [CRM AI Chat — 완성형 패키지 제품화 로드맵](https://app.notion.com/p/3b9bcaaf1f528190b891dbdedb475099) — 상용화 전 P0 체크리스트, 에디션 구분, 단계별 로드맵
- [⑤ crm-ai-chat-mcp (Python 재작성)](https://app.notion.com/p/3bcbcaaf1f528175bd87ef6b5dcd5e49) — MCP 서버 전용 상세 문서

## ✅ 실제 코드와 일치 확인된 부분

- 3-프로젝트(①crm-ai-chat ②Dataverse MCP ③Local LLM) 비교표와 mermaid 아키텍처 다이어그램의 개념적 구조.
- Dataverse 서비스 주체(Azure 앱 등록) 생성 6단계 절차 — 코드/설정 근거와 일치.
- `crm-ai-chat-mcp` 전용 페이지: 도구 4종(`datasource_list/catalog/describe/query` + `health`), `dataverse_query`/`dataverse_describe_table` 호환 별칭, sqlglot AST 기반 PostgreSQL 검증, stdio+streamable-http 두 transport, 새 데이터소스 추가 절차(`DataSource` 추상 클래스 + `registry.py`) — 전부 실제 저장소 구조와 일치.

## ⚠️ 오래된 내용 — Notion 쪽 업데이트가 필요한 부분

| 항목 | Notion 현재 설명 | 실제 코드 (2026-08-13 이후) |
|---|---|---|
| `crm-ai-chat-local-llm` | 별도 저장소, Express/TypeScript 백엔드, 포트 3002, 응답 60.3초 실측치 등으로 지금도 존재하는 것처럼 서술 | **폐기됨.** `crm-ai-chat` 저장소 하나에 흡수되어 `.env`의 `LLM_PROVIDER=ollama`로 전환하는 프로필일 뿐. 백엔드도 Cloud와 동일한 Python/FastAPI. 별도 포트·별도 저장소 아님 |
| 루트 README가 링크하던 구 Notion 페이지("CRM AI Notebook[Local,Cloud]", `.../3babcaaf1f5281eca0c6c6dc049945de`) | 허브의 "시작점" 지정을 받지 못한 페이지 | 이번에 저장소 문서의 링크는 위 허브 URL로 교체했다(아래 "이번에 반영한 것" 참고) |

## ❌ Notion에 없는 내용 (defineview 예시 유형 기준)

| defineview 예시 유형 | Notion 커버리지 | 대신 볼 곳 |
|---|---|---|
| API정의서 | 없음 — 12개 REST 엔드포인트, SSE 이벤트 계약, HTTP 상태 코드표가 어느 페이지에도 없다 | [HANDOVER.md §5](HANDOVER.md#5-http-api) |
| 권한정의서 | 없음 — "제품화 로드맵"의 §4 인증 권고(미래 계획)만 있고, "지금은 인증이 전혀 없다"는 현재 상태를 먼저 못박는 서술이 없어 오해 소지 | [HANDOVER.md §9.1](HANDOVER.md#91-현재-모델) |
| 화면정의서/화면설계서/메뉴정의서 | 없음 (단일 라우트 앱이라 영향은 작음) | [HANDOVER.md §3](HANDOVER.md#3-사용자-화면과-메뉴) |
| 플로우차트, 인프라아키텍처정의서, 정책정의서 | 충실히 커버됨 | — |

## 결론 — 어느 문서를 언제 볼지

- **왜/무엇을(비교, 로드맵, 영업 관점)**: Notion이 더 읽기 쉽고 최신 의사결정 맥락을 담고 있다.
- **정확한 현재 계약(API, 권한, 환경변수, 에러코드)**: `docs/HANDOVER.md`가 코드와 직접 대조해 유지되는 쪽이라 더 정확하다.
- Local LLM 아키텍처처럼 실제로 틀린 내용은 영업/설치 논의에서 그대로 인용하지 않는다.

## 이번에 반영한 것

- 루트 `README.md`와 `docs/README.md`의 Notion 링크를 위 허브 URL로 교체(구 링크는 삭제하지 않고 이 문서 상단 표에 참고용으로 남겨둠).
- Notion 페이지 본문은 수정하지 않았다 — 위 ⚠️/❌ 표를 참고해 사용자가 직접 갱신할 수 있게 남겨둔다.
