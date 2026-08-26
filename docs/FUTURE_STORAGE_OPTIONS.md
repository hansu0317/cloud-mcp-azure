# 저장소 고도화 후보 — 팀 회의용

2026-08-27 아키텍처 논의에서 나온 "지금 당장은 아니지만 2차/3차 고도화 때 검토할
저장소 방향"을 정리한다. **지금 결정은 중앙집중형(고객사당 서버 1대) 유지** —
근거와 기각 이유는 [HANDOVER.md](HANDOVER.md)와 메모리
`crm-ai-chat-storage-architecture-decision`을 참고. 이 문서는 그 결정을 뒤집자는
게 아니라, 나중에 같은 질문이 또 나왔을 때 이미 검토한 내용을 반복하지 않기 위한
기록이다.

## 전제

crm-ai-chat은 Anthropic류 거대 멀티테넌트 SaaS가 아니라, **소·중규모 고객사마다
서버 한 대를 개별 인도**하는 모델이다([DEPLOYMENT_OPTIONS.md](DEPLOYMENT_OPTIONS.md)
§3). "중앙집중형"이라는 표현은 "여러 회사 데이터가 한 서버에 섞인다"가 아니라
"한 회사 안에서 그 회사 서버 한 대에 직원 데이터가 모인다"는 뜻이며, 이건 사내
그룹웨어·Jira 같은 일반적인 사내 도구와 동일한 구조다.

## 검토했던 옵션과 결론

| 옵션 | 내용 | 결론 | 기각/보류 이유 |
|---|---|---|---|
| **로컬 설치형**(Claude Desktop처럼 Electron/Tauri로 앱을 사용자 PC에 설치, 개인 프로젝트를 로컬 디스크에 저장) | 개인 데이터가 물리적으로 사용자 PC에 있음. LLM·Dataverse 호출만 중앙 서버로 나감(Claude Code가 파일은 로컬, 추론만 Anthropic API로 보내는 것과 같은 패턴) | **기각** | 소규모 고객사는 전담 IT가 적어 PC별 버전/환경 파편화, 개별 장애 대응 부담이 오히려 커짐. `chat_api.py`가 프로젝트 컨텍스트를 서버 로컬 디스크에서 직접 읽는 지금 구조(`get_project_history` 등)도 "클라이언트가 매 요청 컨텍스트를 실어 보내는" 방식으로 바꿔야 해서 저장소 교체보다 작업량이 큼 |
| **OneDrive 위임 저장**(로그인 시 `Files.ReadWrite.AppFolder` Graph 스코프 추가 동의받고, 사용자 본인 OneDrive 앱 폴더에 프로젝트 JSON 저장) | 서버는 그대로 1대 유지, 개인 데이터만 그 사람 OneDrive로 | **보류**(특정 고객사 요구 시 옵션으로) | 모든 고객사가 M365를 쓰는 건 아니라 기본 요구사항으로 못 박으면 잠재 고객을 걸러내는 셈. 특정 고객사가 강하게 원하면 그 고객사 배포에서만 `OneDriveStore` 구현체를 켜는 정도는 저비용(`backend/stores/factory.py` 분기 하나) |
| **중앙집중형 유지 + 사람별 논리 격리**(지금 구조) | `data/users/<email>/projects/`, `viewer_email` 없이는 남의 프로젝트 존재 자체를 모름 | **채택** | 소규모 고객사에게 "서버 한 대만 백업하면 끝"이 가장 낮은 운영 부담. 이미 사람별 완전 격리가 돼 있어 "개인 소유"라는 목표 자체는 이미 만족 |

## 오늘 도입한 `DocumentStore` 추상화가 여는 미래 옵션

[backend/stores/](../backend/stores/)의 `DocumentStore` 인터페이스(collection/key
계약, 기본 구현 `LocalFileStore`) 덕분에 아래는 전부 "구현체 하나 추가 + factory
분기"로 끝난다 — `projects.py`/`main.py` 호출부는 무변경:

- 고객사가 자체 온프레미스 DB나 Azure Table Storage를 요구할 때
- 특정 고객사가 OneDrive 위임 저장을 요구할 때(위 표)
- 서버 인스턴스를 여러 대로 늘려야 할 때(지금은 `expected_rev` 낙관적 동시성이
  이미 다중 인스턴스를 전제로 설계됨 — `backend/stores/base.py` 주석 참고)

## `data/projects/`(레거시 최상위 폴더) 재사용 계획

v1 전환(2026-08-25) 이후 코드 어디서도 안 읽는 상태지만 **삭제하지 않는다** —
2차/3차 고도화에서 "부서별로 보이는 공통 프로젝트"(v2,
`v2-department-access-control` 브랜치에 로직 보존)를 다시 얹을 때 그 저장 위치로
재사용할 계획. `users/<email>/projects` 옆에 `departments/<dept>/projects`나
`shared/projects` 같은 collection을 추가하는 형태가 될 가능성이 높다.

## 팀 회의에서 결정할 것 (열린 질문)

- v2(부서 공유) 재도입 시점 — 특정 고객사 요구가 생겼을 때 vs 미리 준비
- OneDrive 옵션을 "제품 기능"으로 노출할지, 아니면 개별 고객사 커스터마이징으로만
  둘지
- 다중 서버 인스턴스가 실제로 필요해지는 고객사 규모 기준
