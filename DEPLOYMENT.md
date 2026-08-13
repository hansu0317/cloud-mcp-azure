# CRM AI Notebook 배포·운영 안내

> 기준: `3.0` / 2026-08-13<br>
> 활성 런타임: React/Vite + Python 3.11+ / FastAPI<br>
> 배포 원칙: 같은 코드에서 `LLM_PROVIDER`만 `anthropic` 또는 `ollama`로 선택

## 1. 배포 전 필수 확인

- 작업 중 출력에 노출된 기존 Anthropic API 키는 폐기하고 새 키를 비밀 저장소에서 주입한다.
- `.env`, `data/`, `logs/`는 Git에 포함하지 않는다.
- 기존 `data/schema.json`과 `data/projects/`를 보안 위치에 백업한다. 새 checkout은 36개 테이블 카탈로그를 자동 복원하지 않는다.
- Dataverse 서비스 주체에는 최소 읽기 권한만 부여한다.
- Python 3.11+, Node.js/npm, Cloud는 새 Anthropic 키, Local은 Ollama와 선택 모델을 준비한다.

## 2. 설치

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.lock
npm install
npm run build
```

Linux에서는 `.venv/bin/python`을 사용한다. `requirements.lock`은 종료 검증에 사용한 직접 의존성 버전이며, 업그레이드할 때는 전체 테스트와 안전 E2E를 다시 실행한다.

## 3. 프로필 설정

`.env.example`을 참고해 루트 `.env`를 만든다. 비밀값을 터미널·문서·로그에 출력하지 않는다.

| 설정 | Cloud | Local |
|---|---|---|
| `LLM_PROVIDER` | `anthropic` | `ollama` |
| 기본 포트 예시 | `3000` | `3002` |
| 필수 LLM 준비 | 새 `ANTHROPIC_API_KEY` | Ollama 기동 + 모델 설치 |
| 활성 구조화 로그 | `logs/server.cloud.log` | `logs/server.local.log` |

두 프로필 모두 같은 Dataverse `DATAVERSE_TENANT_ID`, `DATAVERSE_CLIENT_ID`, `DATAVERSE_CLIENT_SECRET`, `DATAVERSE_URL` 계약을 사용한다. Local Ollama 준비는 `scripts/setup-ollama.ps1` 또는 `scripts/setup-ollama.sh`로 상태만 확인할 수 있으며, 모델 다운로드는 `-Pull`/`--pull`을 명시한 경우에만 수행한다.

## 4. 데이터 복원

서버가 중지된 상태에서 백업한 `data/schema.json`과 `data/projects/`를 복원한다. `schema.json`이 없거나 빈 객체이면 테이블 목록과 allowlist가 비어 채팅 조회가 거절된다. `/api/schemas/refresh`는 이미 등록된 테이블만 갱신하며 전체 Dataverse 테이블을 자동 발견하지 않는다.

## 5. 실행

직접 실행:

```powershell
npm start
```

Windows 관리 스크립트:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\server.ps1 start
powershell -ExecutionPolicy Bypass -File scripts\server.ps1 status
powershell -ExecutionPolicy Bypass -File scripts\server.ps1 logs
powershell -ExecutionPolicy Bypass -File scripts\server.ps1 stop
```

Linux에서는 `scripts/server.sh`, PM2에서는 `scripts/ecosystem.config.js`를 사용한다. 관리 스크립트는 소유한 FastAPI PID만 종료하며 앱의 JSONL 로그 외 별도 console 로그 파일을 만들지 않는다.

## 6. 네트워크·인증

- 앱 포트는 사내망 또는 reverse proxy 뒤에서만 노출하고 인터넷에 직접 공개하지 않는다.
- 운영은 TLS와 SSO/reverse-proxy 인증을 권장한다. 앱 자체에는 사용자별 로그인·RBAC가 없다.
- `API_KEY`는 모든 `/api/*`에 적용되는 공유 키다. 현재 SPA는 키를 직접 보내지 않으므로 사용할 경우 reverse proxy에서 헤더를 주입한다.
- 전달 헤더는 기본적으로 loopback proxy만 신뢰한다. 다른 proxy가 필요할 때만 `FORWARDED_ALLOW_IPS`를 구체적으로 설정한다.
- `/docs`, `/redoc`, `/openapi.json`은 기본 비활성이다. 진단 환경에서만 `ENABLE_API_DOCS=true`로 켠다.

## 7. 배포 검증

```powershell
npm run type-check
npm test
npm run build
.venv\Scripts\python -m compileall -q backend scripts\e2e_fastapi_safe.py
.venv\Scripts\python -m pip check
```

Local Ollama와 Dataverse가 준비됐으면 다음 안전 검증을 추가한다.

```powershell
npm run test:e2e:safe
```

이 스크립트는 `$top=0`만 사용해 CRM 행을 LLM에 보내지 않고 FastAPI health, 스키마 36개, 프로젝트 지침, describe/query, SSE와 정리를 검증한다. 질문·응답·테이블명·비밀값은 출력하지 않는다.

배포 후에는 다음을 확인한다.

1. `GET /api/health`가 HTTP 200이며 선택 provider/model과 `schemaTables=36`을 표시한다.
2. 프로젝트 생성·수정·삭제 및 지침 저장이 동작한다.
3. 승인된 질문에서 `dataverse_describe_table` → `dataverse_query` → 최종 답변 흐름이 완료된다.
4. Cloud는 `server.cloud.log`, Local은 `server.local.log` 하나만 활성 구조화 로그로 사용한다.
5. 알 수 없는 `/api/*`는 JSON 404이고 API 문서 경로는 기본 404다.

## 8. 백업·복구·중지

- 일관된 백업을 위해 서버를 먼저 중지하고 `data/` 전체를 복사한다.
- `.env`는 일반 파일 백업과 분리해 비밀 저장소에서 관리한다.
- 복구 전 현재 `data/`를 별도 보존하고 백업을 배치한 뒤 health·프로젝트 목록·승인된 샘플 조회를 확인한다.
- Cloud/Local 두 프로필을 동시에 띄울 때도 같은 `data/`를 공유해서 쓰지 않는다(포트만 다르고 `data/`는 프로필별로 분리). (2026-08-13부터 별도 `crm-ai-chat-local-llm` mirror 저장소는 폐기했고, `crm-ai-chat` 하나에서 `LLM_PROVIDER`로만 Cloud/Local을 나눈다.)

전체 아키텍처·API·정책·검증 증거는 [FINAL_HANDOVER.md](FINAL_HANDOVER.md)와 [specifications/](specifications/)를 따른다.
