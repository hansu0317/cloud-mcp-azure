# 문서 인덱스

`crm-ai-chat` 관련 문서는 모두 이 폴더에 있다. 루트 `README.md`는 빠른 시작만 다루고, 나머지는 여기서 시작한다.

| 문서 | 내용 |
|---|---|
| [HANDOVER.md](HANDOVER.md) | 통합 인수인계서 — 제품 범위, 아키텍처, API, 데이터·백업, 환경변수, 운영 스크립트, 보안·권한, 알려진 제약, 장애 대응 |
| [DEPLOYMENT_OPTIONS.md](DEPLOYMENT_OPTIONS.md) | 고객 배포 결정표 — 어떤 환경에 무엇을 어떻게 설치할지, 인도 방식(git/tar)별 명령 |
| [NOTION.md](NOTION.md) | Notion 인수인계 허브 링크와, 실제 코드 대비 정확성 검증 결과 |
| [LOCAL_GPU_NOTES.md](LOCAL_GPU_NOTES.md) | Local 프로필 GPU 가속 시도 기록 — 왜 안 되는지, 왜 CPU로 확정했는지 |
| [../backend/README.md](../backend/README.md) | `backend/` 코드를 직접 수정할 때 보는 모듈 단위 문서 |

## 다른 프로젝트 — `crm-ai-chat-mcp`

`crm-ai-chat`(이 저장소, Dataverse 조회 웹 챗봇)과 `crm-ai-chat-mcp`(Dataverse+PostgreSQL을 MCP 프로토콜로 노출하는 독립 서버)는 **완전히 분리된 별도 git 저장소**다. 웹 챗은 `crm-ai-chat-mcp`를 호출하지 않고 자체 Dataverse REST 경로만 쓴다. 두 프로젝트를 같이 다룰 때는 그 저장소의 `docs/README.md`도 함께 보라(로컬 개발 환경에서는 보통 `../../crm-ai-chat-mcp`에 나란히 checkout돼 있다). 어떤 상황에 어느 저장소가 필요한지는 [DEPLOYMENT_OPTIONS.md](DEPLOYMENT_OPTIONS.md)의 결정표를 참고.

## Notion

인수인계 허브(아키텍처 비교·인프라·제품화 로드맵): https://app.notion.com/p/CRM-AI-Chat-3b5bcaaf1f52814f8843e4bcab4e1791

정확성 검증 결과와 "무엇을 Notion에서, 무엇을 이 문서에서 봐야 하는지"는 [NOTION.md](NOTION.md) 참고.
