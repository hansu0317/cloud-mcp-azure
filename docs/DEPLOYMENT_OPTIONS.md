# 배포 결정표 · 설치 가이드

고객이 "어떤 환경에 무엇을 어떻게 쓸지"를 고르기 위한 표다. **아직 구현되지 않은 것(SSO/RBAC/멀티테넌트 등)은 되는 것처럼 쓰지 않는다** — 지금 실제로 배포 가능한 조합만 다룬다. 현재 제약(단일 인스턴스, 사용자 인증 없음, `data/`가 상태의 원본)은 [HANDOVER.md §9~10](HANDOVER.md#9-보안권한)을 먼저 읽는다.

## 1. 어떤 제품이 필요한가

| 상황 | 제품 | 비고 |
|---|---|---|
| 사내 여러 명이 브라우저로 CRM을 자연어로 조회 | `crm-ai-chat` | 지금 실제로 사내에서 쓰고 있는 제품. UI 있음 |
| Claude Desktop/Code 같은 MCP client에서 Dataverse·PostgreSQL을 직접 조회하고 싶은 개발자 | `crm-ai-chat-mcp` | UI 없음. 웹 챗과 무관하게 동작하는 별도 저장소 |
| 둘 다 필요 | 두 저장소를 각각 배포 | 서로 호출하지 않는 독립 제품이므로 별개로 설치·운영한다 |

## 2. `crm-ai-chat` 안에서의 선택

| 축 | 선택지 | 언제 |
|---|---|---|
| LLM | **Cloud**(`LLM_PROVIDER=anthropic`) | 응답 속도 우선, 외부 LLM 전송 승인됨, `ANTHROPIC_API_KEY` 보유 |
| | **Local**(`LLM_PROVIDER=ollama`) | 데이터를 한 바이트도 외부로 보내면 안 됨(폐쇄망), 토큰 과금 회피. RAM 32GB급 서버 필요(모델 상주 약 19GB) |
| OS | **Windows** | `scripts\server.ps1 start\|status\|logs\|stop` |
| | **Linux** | `scripts/server.sh`, 상시 서비스는 `scripts/ecosystem.config.js`(PM2) |

두 축은 독립적이다(Windows+Cloud, Linux+Local 등 4가지 조합 모두 가능). 설치·실행·검증 명령 전체는 [HANDOVER.md §8](HANDOVER.md#8-설치실행검증)에 있다 — 여기서 중복하지 않는다.

## 3. 인도 방식 — git으로 묶기 vs tar로 묶기

원격 저장소를 새로 만들거나 push하지 않고, 로컬에서 바로 만들 수 있는 세 가지 방법. 무엇을 쓰든 받는 쪽 설치 절차는 동일하다(§2의 HANDOVER.md 링크).

| 방식 | 명령 | 언제 |
|---|---|---|
| **git bundle** | `git bundle create crm-ai-chat.bundle --all` | 오프라인 인도이면서 전체 커밋 히스토리도 필요할 때. 받는 쪽은 `git clone crm-ai-chat.bundle crm-ai-chat` |
| **git archive (tar.gz)** | `git archive --format=tar.gz -o crm-ai-chat_$(git rev-parse --short HEAD).tar.gz HEAD` | 가장 단순한 스냅샷. `.gitignore` 대상은 자동 제외(추적 파일만 포함 — `.env`, `data/`, `logs/`, `node_modules/`, `.venv/`, `defineview/`가 안 들어간다는 뜻이기도 하다) |
| **원격 git clone** | 고객이 접근 가능한 git 호스트에 push 후 `git clone <url>` | 온라인 환경이고, 이후에도 지속적으로 업데이트를 배포할 계획일 때 |

`crm-ai-chat-mcp`도 같은 저장소 루트에서 같은 명령을 그대로 쓰면 된다(파일명만 `crm-ai-chat-mcp...`로 바꾼다).

인도 전 반드시 확인:
- `.env`는 애초에 git에 없으므로 tar/bundle/clone 어디에도 포함되지 않는다 — 별도 채널(비밀 저장소)로 전달하고 `.env.example`을 기준으로 고객이 직접 채우게 한다.
- `data/`, `logs/`도 gitignore 대상이라 포함되지 않는다 — 새 checkout은 `data/schema/catalog.json`이 비어 있으므로, 조회 가능한 테이블이 없다(HANDOVER.md §6 참고). 실제 운영 데이터를 옮기는 게 아니라면 고객사 자체 Dataverse 서비스 주체로 새로 시딩해야 한다.
- git 이력째로 넘기는 방식(bundle/원격 clone)은 과거 커밋에 남아있을 수 있는 민감정보까지 함께 넘어간다 — HANDOVER.md §9의 "출력에 노출된 키 폐기·재발급 완료, git 이력 검색으로 커밋 이력엔 없음을 확인" 기록을 인도 전 재확인한다.

## 4. 설치 후 확인

제품별 스모크 체크리스트:

| 제품 | 확인 절차 |
|---|---|
| `crm-ai-chat` | [HANDOVER.md §8.2 시작 후 확인](HANDOVER.md#82-시작-후-확인) 6단계 |
| `crm-ai-chat-mcp` | 저장소 README의 "테스트" 절 — `pytest tests_python/ -v` + `python scripts/mcp_datasource_smoke.py` |

## 5. 판매/제안 문구 관련 주의

Notion의 "완성형 패키지 제품화 로드맵" 문서(§3 P0)에 따르면 사용자 인증, RBAC, Secret Store 이관 등은 아직 착수 전이다. **P0가 끝나기 전에는 "고객별 권한이 완전히 분리된다" 같은 문구를 계약·제안서에 확정적으로 쓰지 않는다.** 현재 실제로 있는 방어는 프로젝트별 테이블 스코프(서버 강제)와 선택적 공유 `API_KEY` 하나뿐이다.
