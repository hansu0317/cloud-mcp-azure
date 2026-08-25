# backend — 활성 Python/FastAPI 백엔드

> 프로젝트 전체 문서는 [../docs/README.md](../docs/README.md)에서 시작하세요. 이 문서는 `backend/` 코드를 직접 수정할 때 보는 모듈 단위 참고 자료입니다.

이 폴더가 Cloud/Local 두 프로필의 유일한 활성 백엔드입니다. UI·API·프롬프트·
Dataverse REST·프로젝트·히스토리·로그 계약은 같고 `LLM_PROVIDER`만 바꾸어
Anthropic 또는 Ollama를 선택합니다.

## 구성

2026-08-25: 파일이 늘어나면서 관심사별로 하위 폴더에 묶었다 — `from .auth import X`,
`from .providers.provider_factory import X`처럼 대부분 `from .패키지.파일 import`
형태다. `main.py`/`chat_api.py`/`dev.py`/`dataverse.py`만 최상위에 남아있다(각각
엔트리포인트이거나, 묶을 다른 파일이 없는 단독 모듈).

| 경로 | 역할 |
|---|---|
| `main.py` | FastAPI 앱, 12개 API, 인증·레이트리밋·SPA 서빙 |
| `chat_api.py` | provider-neutral 채팅·도구 루프·SSE·OData guard |
| `dev.py` | `.env`의 PORT를 존중하는 개발 서버 진입점(`npm run dev:server`) |
| `dataverse.py` | Entra client credentials, Dataverse GET, metadata→schema |
| `auth/` | Microsoft Entra ID 로그인(MSAL), 세션 쿠키, 이메일→부서 매핑(`departments.py`) |
| `providers/` | LLM provider 추상화 — `llm_provider.py`(canonical 계약), `anthropic_provider.py`, `ollama_provider.py`, `provider_factory.py`(`LLM_PROVIDER=anthropic\|ollama` 선택) |
| `store/` | 프로젝트·대화 기록 저장 — `projects.py`(`data/projects/*.json`), `history.py`(기록 변환·트리밍). 지금은 로컬 파일이지만 호출부(`main.py`/`chat_api.py`)는 함수 계약만 알고 내부 구현은 모른다 — 나중에 공용 서버/DB로 옮길 때 이 폴더 내부만 바꾸면 된다(departments.py와 같은 패턴). |
| `core/` | 공용 인프라 — `logger.py`(JSON Lines 로그), `semaphore.py`(동시 실행 제한), `sse.py`(SSE 헤더·상태코드) |

## 채팅 계약

`POST /api/chat` body는 `{ "message": "...", "sessionId": "..." }`만 허용합니다.
`tables` 및 프로젝트 지침은 클라이언트를 신뢰하지 않고 서버가 `sessionId`로
프로젝트 파일을 매 요청 읽어 적용합니다. 응답은 `text/tool/query/error/done` SSE입니다.

로드된 도구는 `dataverse_describe_table`, `dataverse_query` 두 개뿐이며 모두 읽기 전용입니다.
자연어→OData GET(Text-to-OData)이며 SQL 드라이버나 CRM 쓰기 도구는 없습니다.

## 프로필

| 항목 | Cloud | Local |
|---|---|---|
| `LLM_PROVIDER` | `anthropic` | `ollama` |
| 기본 model | `claude-haiku-4-5` | `qwen3:30b-a3b` |
| endpoint | Anthropic Messages | Ollama native `/api/chat` |
| 필수 LLM 설정 | `ANTHROPIC_API_KEY` | Ollama 기동·모델 설치 |
| 활성 로그 | `logs/server.cloud.log` | `logs/server.local.log` |

`LLM_MODEL`, `LLM_BASE_URL`은 provider별 값보다 우선하는 공통 override입니다.

## 실행·검증

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
npm install
npm run dev
```

```powershell
npm run type-check
npm test
npm run build
python -m compileall -q backend
```

`npm start`는 `python -m backend.main`을 실행합니다. Python 백엔드는 별도 빌드 산출물이
없고, `npm run build`는 React SPA의 `dist/`만 생성합니다.
