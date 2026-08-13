# backend — 활성 Python/FastAPI 백엔드

이 폴더가 Cloud/Local 두 프로필의 유일한 활성 백엔드입니다. UI·API·프롬프트·
Dataverse REST·프로젝트·히스토리·로그 계약은 같고 `LLM_PROVIDER`만 바꾸어
Anthropic 또는 Ollama를 선택합니다.

## 구성

| 파일 | 역할 |
|---|---|
| `main.py` | FastAPI 앱, 12개 API, 인증·레이트리밋·SPA 서빙 |
| `chat_api.py` | provider-neutral 채팅·도구 루프·SSE·OData guard |
| `llm_provider.py` | canonical message/tool/health 계약 |
| `anthropic_provider.py` | Anthropic Messages SSE adapter |
| `ollama_provider.py` | Ollama native `/api/chat` NDJSON adapter |
| `provider_factory.py` | `LLM_PROVIDER=anthropic|ollama` 선택 |
| `history.py` | 기존 기록 변환·트리밍·describe 압축 |
| `dataverse.py` | Entra client credentials, Dataverse GET, metadata→schema |
| `projects.py` | `data/projects/*.json` 저장·ID 검증·history 비노출 |
| `logger.py` | `server.cloud.log` / `server.local.log` JSON Lines |
| `mcp_server.py` | Claude Desktop/Code 등 외부 MCP client용 Dataverse MCP 서버(별도 프로세스, `chat_api.py`와 같은 guard 함수 재사용) |

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

## MCP 서버 (외부 client용, 웹앱과 별도 프로세스)

```powershell
npm run mcp        # stdio — Claude Desktop/Code 등록용
npm run mcp:http    # streamable-http — 원격 MCP client용
```

`main.py`(웹앱)는 기동 시 이 모듈을 import하지 않습니다. 자세한 등록 방법은
[../README.md](../README.md#mcp와-웹앱-rest-경로의-관계)를 참고하세요.
