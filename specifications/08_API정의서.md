# CRM AI Notebook — 08 API 정의서

> 문서 ID: `CRM-AI-SPEC-08`<br>
> 버전: `3.0`<br>
> 상태: `Final`<br>
> 기준일: `2026-08-13`<br>
> 적용 대상: Cloud / Local 공통 Python/FastAPI API<br>
> 상위 문서: [`../FINAL_HANDOVER.md`](../FINAL_HANDOVER.md)

> **프로필 원칙:** canonical과 동기화된 Local mirror는 같은 12개 제품 HTTP API, JSON model, validation, SSE, 오류 계약을 제공한다. `POST /api/chat` 내부 provider와 `/api/health`의 provider 값, 활성 로그 파일명만 환경에서 달라진다.

---

## 1. 목적·범위

이 문서는 `defineview` API정의서 예시의 API Index·request/response·status·validation·인증·검수 형식을 현재 공통 Python/FastAPI 서버에 적용한다.

### 1.1 활성 구현 범위

| 영역 | 파일 |
|---|---|
| Route·middleware·project/schema/log/health/draft | `backend/main.py` |
| Chat SSE·tool·scope/OData guard | `backend/chat_api.py` |
| Project persistence | `backend/projects.py` |
| Dataverse HTTP | `backend/dataverse.py` |
| Frontend/API event types | `src/types/index.ts`, `backend/llm_provider.py` |
| LLM provider contract/adapters | `backend/llm_provider.py`, `backend/anthropic_provider.py`, `backend/ollama_provider.py` |

`backend/`가 두 프로필의 활성 API 계약 근거다. 과거 `server/*.ts`, `dist-server/`, `claudeapi/`는 현행 근거가 아니다.

`crm-ai-chat-dataverse-mcp`는 별도 stdio MCP 서버다. `dataverse://catalog` resource와 같은 이름의 두 MCP tool을 제공하지만, 웹앱의 `/api/chat`은 그 process를 호출하지 않고 FastAPI 내부 tool contract에서 `backend/dataverse.py`의 REST/OData GET을 실행한다. 따라서 이 문서의 12개 제품 HTTP API에 MCP resource/tool endpoint를 포함하지 않는다. 제품은 Text-to-SQL이 아니라 자연어→OData(Text-to-OData) 방식이다.

## 2. 공통 규약

| 항목 | 규약 |
|---|---|
| Base path | `/api`; version prefix 없음 |
| 일반 전송 | UTF-8 JSON |
| Chat 성공 전송 | `text/event-stream`, UTF-8 SSE |
| 생성/삭제 status | 생성도 200, 삭제 성공도 200 |
| 오류 JSON | 주로 `{ "error": "..." }` |
| 스트림 오류 | `{ "type": "error", "message": "..." }` |
| 프로젝트 ID | 서버 생성 UUID, route/file 허용 문자는 영문·숫자·하이픈 |
| 날짜 | `createdAt`, `updatedAt` ISO 8601 |
| 테이블 이름 | Dataverse logical name |
| Empty tables | `[]`은 전체 catalog 범위 |
| 인증 | `API_KEY`가 없으면 없음; 있으면 모든 `/api/*`에 공유 key |
| Body parser | FastAPI/Starlette JSON 파싱; malformed JSON을 400으로 정규화 |
| Provider parity | 12 API의 URI·outer contract 동일 |

## 3. API Index

| No. | Method | URI | Description | Cloud | Local |
|---:|:---:|---|---|:---:|:---:|
| 1 | POST | `/api/chat` | 질문을 공통 LLM/Dataverse 도구 루프로 처리하고 SSE 반환 | Y | Y |
| 2 | GET | `/api/projects` | 최근 수정 순 프로젝트 요약 목록 | Y | Y |
| 3 | POST | `/api/projects` | 프로젝트 생성 | Y | Y |
| 4 | GET | `/api/projects/{project_id}` | 프로젝트 상세, history 제외 | Y | Y |
| 5 | PATCH | `/api/projects/{project_id}` | 이름·tables·instructions·cells 부분 수정 | Y | Y |
| 6 | DELETE | `/api/projects/{project_id}` | 프로젝트 파일 즉시 삭제 | Y | Y |
| 7 | GET | `/api/tables` | 메모리 table catalog | Y | Y |
| 8 | POST | `/api/schemas/refresh` | 기존 schema key의 metadata 갱신 | Y | Y |
| 9 | GET | `/api/describe?table=...` | schema cache 조회 또는 metadata GET·저장 | Y | Y |
| 10 | GET | `/api/logs?n=...` | 활성 profile 최신 log | Y | Y |
| 11 | GET | `/api/health` | 앱·provider·Dataverse 설정·동시성 상태 | Y | Y |
| 12 | GET | `/api/instructions/draft` | 활성 log 기반 instructions 후보 | Y | Y |

`POST /api/chat`은 provider 설정이 없어도 route가 항상 존재한다. 설정 미완료는 405가 아니라 일관된 503이다.

## 4. 공통 데이터 모델

### 4.1 ProjectSummary

```json
{
  "id": "c7ec0b38-5155-4cc2-8d5f-50e4d29f9100",
  "name": "영업 분석",
  "tables": ["account", "opportunity"],
  "createdAt": "2026-08-12T01:00:00.000Z",
  "updatedAt": "2026-08-12T02:00:00.000Z"
}
```

### 4.2 ProjectDetail

```json
{
  "id": "c7ec0b38-5155-4cc2-8d5f-50e4d29f9100",
  "name": "영업 분석",
  "tables": ["account", "opportunity"],
  "instructions": {
    "joins": [],
    "terms": [],
    "examples": []
  },
  "cells": [],
  "createdAt": "2026-08-12T01:00:00.000Z",
  "updatedAt": "2026-08-12T02:00:00.000Z"
}
```

| Model | 포함 필드 | 제외 필드 |
|---|---|---|
| `ProjectSummary` | id, name, tables, createdAt, updatedAt | instructions, cells, history |
| `ProjectDetail` | Summary + instructions + cells | history |
| Stored project | Detail + history | 없음 |

### 4.3 Instructions

```json
{
  "joins": [
    {
      "fromTable": "opportunity",
      "fromCol": "customerid",
      "toTable": "account",
      "toCol": "accountid",
      "label": "영업기회 고객"
    }
  ],
  "terms": [
    {
      "table": "opportunity",
      "column": "estimatedvalue",
      "term": "예상 매출",
      "def": "영업기회의 예상 금액"
    }
  ],
  "examples": [
    {
      "question": "활성 영업기회 상위 5개를 보여줘",
      "answer": "실제 조회 결과를 표로 답한다"
    }
  ]
}
```

현재 runtime validation은 `joins`, `terms`, `examples`가 배열인지 확인한다. 각 행 내부 필드의 타입·논리 테이블/컬럼 존재 여부까지 완전 검증하지는 않는다.

### 4.4 Cell

서버는 `cells`가 배열인지 확인한 뒤 원소를 해석하지 않고 저장한다. 프론트의 현재 원소는 다음 형태다.

```json
{
  "id": 1,
  "type": "ai",
  "text": "활성 영업기회 5개 보여줘",
  "output": {
    "loading": false,
    "content": "| ... |",
    "toolName": null,
    "error": false,
    "rawContent": "| ... |",
    "execN": 1,
    "queries": [],
    "elapsedMs": 1250
  }
}
```

### 4.5 Stored canonical history

history는 API 응답에 포함되지 않는다. 프로젝트 파일에는 다음 공급자 중립 블록이 저장될 수 있다.

```json
[
  { "role": "user", "content": [{ "type": "text", "text": "거래처 3개" }] },
  {
    "role": "assistant",
    "content": [{
      "type": "tool_call",
      "id": "call-1",
      "name": "dataverse_query",
      "input": { "path": "accounts?$top=3" }
    }]
  },
  {
    "role": "user",
    "content": [{
      "type": "tool_result",
      "toolCallId": "call-1",
      "name": "dataverse_query",
      "content": "[...]"
    }]
  }
]
```

기존 Anthropic `tool_use/tool_result`와 OpenAI/Ollama `tool_calls/role=tool` history는 읽을 때 정규화되고 다음 성공 저장 때 canonical로 교체된다.

## 5. Endpoint 상세

### 5.1 `POST /api/chat`

#### Request

```http
POST /api/chat
Content-Type: application/json

{
  "message": "활성 거래처 5개를 보여줘",
  "sessionId": "c7ec0b38-5155-4cc2-8d5f-50e4d29f9100"
}
```

| 필드 | 타입 | 필수 | Validation | 사용 |
|---|---|:---:|---|---|
| `message` | string | Y | 문자열이며 trim 후 비어 있지 않음 | canonical user text |
| `sessionId` | string | Y | 문자열, ID 형식, 기존 project 존재 | project context lookup |
| `tables` | - | N/A | 계약 외 필드; 포함 시 400 | 사용 안 함 |
| `instructions` | - | N/A | 계약 외 필드; 포함 시 400 | 사용 안 함 |

서버는 `get_project_tables`, `get_project_instructions`, `get_project_history`로 context를 다시 읽는다.

#### Response header

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

15초마다 `:hb` SSE comment heartbeat를 보낸다. 브라우저 parser는 `data: ` 행만 처리한다.

#### SSE event

```text
data: {"type":"tool","name":"dataverse_describe_table"}

data: {"type":"query","tool":"dataverse_describe_table","input":{"table":"account"}}

data: {"type":"text","text":"조회 결과입니다..."}

data: {"type":"done"}

```

| type | JSON | Cardinality | 의미 |
|---|---|---:|---|
| `tool` | `{type,name}` | 0..N | provider가 tool call 시작 |
| `query` | `{type,tool,input}` | 0..N | 서버가 실행할 tool input |
| `text` | `{type,text}` | 0..N | 최종 답변. provider별 chunk timing 차이 가능 |
| `error` | `{type,message}` | 실패 시 1 | SSE 시작 후 오류 |
| `done` | `{type}` | 정상 시 1 | history 저장까지 정상 완료 |

#### Tool contract

| 도구 | Input | 서버 행동 |
|---|---|---|
| `dataverse_describe_table` | `{ "table": "logicalName" }` | 프로젝트 scope 확인 후 `schema.json` cache 반환 |
| `dataverse_query` | `{ "path": "entityset?..." }` | 상대경로·특수 segment·entity set 검증 후 Dataverse GET |

`dataverse_query.path` 규칙:

1. 선행 `/`는 제거한다.
2. 비어 있거나 decode 결과에 CR/LF, `\`, `#`가 있으면 거절한다.
3. `http://`, `https://`, `//` 같은 절대/network URL을 거절한다.
4. `$batch`, `$ref`, `$value` segment를 거절한다.
5. 첫 entity set은 프로젝트 tables에서 계산한 허용 집합에 있어야 한다.
6. 허용 집합이 비면 fail-closed한다.
7. 일반 collection에 `$top`이 없으면 `$top=100`을 추가하고, 100을 넘는 명시값은 100으로 낮춘다. `$count=true`에도 행 상한을 적용하며 `/$count` scalar와 `$apply`는 별도 처리한다.
8. 도구 결과 전체는 직렬화 기준 최대 8 KiB로 제한하고, JSON `value`는 그 안에서 최대 100행으로 줄인다.

#### Processing limits

| 항목 | 기본/상한 |
|---|---:|
| Tool/provider loop | 최대 6회 |
| LLM timeout | 120,000ms |
| Concurrent chat | 10 |
| Memory history sessions | 200 |
| Memory TTL | 24h |
| History trim | 약 20 messages, 실제 user question 경계 |
| Text-path fallback | 요청당 최대 1회 |
| Mutation JSON body | 기본 최대 1 MiB |
| Dataverse 일반 응답 | 기본 최대 8 MiB |
| Dataverse metadata 응답 | 기본 최대 64 MiB |
| LLM tool result | UTF-8 최대 8 KiB, `value` 최대 100행 |
| Dataverse retry | 네트워크 오류·429에 기본 최대 2회, 제한된 backoff |

#### Pre-SSE errors

| Status | 조건 | Body 예 |
|---:|---|---|
| 400 | message/sessionId 타입·필수 조건 실패 | `{"error":"message와 sessionId가 필요합니다."}` |
| 401 | shared API key 실패 | `{"error":"인증이 필요합니다..."}` |
| 404 | project 없음·ID invalid 또는 미등록 `/api/*` | JSON error |
| 413 | mutation body가 기본 1 MiB 상한 초과 | JSON error |
| 415 | mutation Content-Type이 JSON 계열이 아님 | JSON error |
| 422 | typed query/path validation 실패 | FastAPI `detail` |
| 429 | rate limit 또는 semaphore overload | JSON error |
| 503 | selected provider 미설정 | `{"error":"anthropic LLM 설정이 완료되지 않았습니다."}` |

Dataverse 환경변수 누락, provider timeout, tool loop 초과, tool/runtime 오류는 SSE가 열린 뒤 `error` 이벤트가 될 수 있다. 실패·취소 시 현재 요청 history를 rollback한다.

### 5.2 `GET /api/projects`

```json
{
  "projects": [
    {
      "id": "...",
      "name": "영업 분석",
      "tables": ["account"],
      "createdAt": "...",
      "updatedAt": "..."
    }
  ]
}
```

- `updatedAt` 내림차순이다.
- `instructions`, `cells`, `history`를 포함하지 않는다.
- 읽을 수 없는/잘못된 project 파일은 목록에서 제외될 수 있다.

### 5.3 `POST /api/projects`

#### Request

```json
{
  "name": "영업 분석",
  "tables": ["account", "opportunity"]
}
```

| 필드 | 타입 | 필수 | 규칙 |
|---|---|:---:|---|
| name | string | N | trim, 비면 `제목 없는 프로젝트` |
| tables | string[] | N | 기본 `[]`; 각 값이 현재 catalog에 등록돼야 함 |

성공 200으로 `ProjectDetail`을 반환하고 `data/projects/<uuid>.json`을 만든다. instructions/cells/history는 빈 배열로 초기화한다.

| 오류 | 조건 |
|---:|---|
| 400 | name이 문자열이 아님, tables가 문자열 배열이 아님, 미등록 table 포함 |

### 5.4 `GET /api/projects/{project_id}`

| 결과 | Status | Body |
|---|---:|---|
| 기존 유효 project | 200 | `ProjectDetail`, history 제외 |
| 없음/ID invalid/읽기 실패 | 404 | `{error}` |

### 5.5 `PATCH /api/projects/{project_id}`

#### Request

```json
{
  "name": "새 이름",
  "tables": ["account"],
  "instructions": { "joins": [], "terms": [], "examples": [] },
  "cells": []
}
```

모든 필드는 선택이며 전달된 필드만 바꾼다.

| 필드 | Runtime validation |
|---|---|
| name | string |
| tables | 모든 원소 string + catalog 등록 |
| instructions | object + joins/terms/examples가 배열 |
| cells | 배열 |

성공 200 `ProjectDetail`; project 없음/ID invalid는 404; 형식·미등록 table은 400이다. 빈 name은 기존 이름을 유지한다.

### 5.6 `DELETE /api/projects/{project_id}`

```json
{ "ok": true }
```

- 성공 200.
- 없음/ID invalid/삭제 실패는 404.
- 파일의 instructions/cells/history가 함께 즉시 삭제된다.
- 휴지통·undo API는 없다.

### 5.7 `GET /api/tables`

```json
{
  "tables": [
    { "name": "account", "label": "거래처", "domain": "영업" }
  ]
}
```

기동 시 `data/schema.json`을 메모리로 읽은 catalog다. 파일이 없거나 잘못되면 빈 배열일 수 있다.

### 5.8 `POST /api/schemas/refresh`

```json
{
  "updated": 2,
  "tables": ["account", "opportunity"]
}
```

| 상황 | Response |
|---|---|
| catalog key 0개 | `{updated:0,tables:[]}` |
| 이미 진행 중 | `{updated:0,tables:[],message:"갱신이 이미 진행 중입니다."}` |
| 일부 성공 | 성공 table만 집계; 실패는 profile log |

- 기존 `schema.json` key를 6개 batch로 갱신한다.
- Choice 계열(Picklist·State·Status·MultiSelect) option의 숫자 코드와 label을 `코드=라벨` 형태로 조회할 수 있다.
- LLM은 사용하지 않는다.
- 새 table 자동 발견 API가 아니다.

### 5.9 `GET /api/describe?table={logicalName}`

Cache hit:

```json
{ "schema": "| 컬럼명 | 타입 | ...", "cached": true }
```

Cache miss 성공:

```json
{ "schema": "| 컬럼명 | 타입 | ...", "cached": false }
```

| Status | 조건 |
|---:|---|
| 200 | cache 또는 Dataverse metadata 조회 성공 |
| 400 | table query 누락 |
| 500 | Dataverse env/metadata/file 처리 실패 |

동일 table의 동시 cache miss는 하나의 `asyncio.Task`에 합류한다. 이 운영 API의 table 값은 project chat scope와 별도이며 접근 권한이 분리돼 있지 않다.

### 5.10 `GET /api/logs?n={count}`

```json
[
  {
    "time": "2026-08-12T12:00:00.000+09:00",
    "level": "info",
    "category": "API-답변",
    "message": "...",
    "data": {}
  }
]
```

| 항목 | 규칙 |
|---|---|
| 기본 `n` | 100 |
| 최대 | 200 |
| 순서 | 최신 우선 |
| Cloud source | `logs/server.cloud.log` |
| Local source | `logs/server.local.log` |
| 파일 없음 | `[]` |
| 잘못된 JSON line | 제외 |

`n`은 서버가 1~200 범위로 clamp한다. 로그에는 질문·답변·query·오류가 포함될 수 있고 RBAC가 없다.

### 5.11 `GET /api/health`

Anthropic 예:

```json
{
  "ok": true,
  "uptime": 120,
  "schemaTables": 36,
  "chat": {
    "enabled": true,
    "provider": "anthropic",
    "model": "claude-haiku-4-5",
    "endpoint": "https://api.anthropic.com",
    "configured": true,
    "health": {
      "status": "ok",
      "provider": "anthropic",
      "model": "claude-haiku-4-5",
      "endpoint": "https://api.anthropic.com"
    },
    "active": 0,
    "queued": 0,
    "max": 10
  }
}
```

Ollama profile은 같은 구조에서 `provider:"ollama"`, 해당 model/endpoint를 반환한다.

| Field | 의미 |
|---|---|
| `ok` | FastAPI health route가 응답함. dependency 전체 정상 의미 아님 |
| `uptime` | process seconds |
| `schemaTables` | memory catalog table count |
| `chat.enabled` | provider configured + health ok + Dataverse 필수 env 완성 |
| `chat.configured` | provider 기본 설정. Anthropic은 key 필요, Ollama는 true |
| `chat.health` | 2초 provider ping 결과 `ok/unreachable/misconfigured` |
| `chat.missingEnv` | 첫 누락 Dataverse env 이름, 있을 때만 |
| `active/queued/max` | process-local chat semaphore |

Anthropic health는 `/v1/models`, Ollama는 `/api/tags`를 호출한다. Ollama는 endpoint 연결뿐 아니라 선택한 모델이 tags 목록에 설치됐는지도 확인한다. 모니터링은 HTTP 200과 top-level `ok`만 보지 말고 `chat.enabled`, `chat.health.status`, `missingEnv`를 확인한다.

### 5.12 `GET /api/instructions/draft`

```json
{
  "joins": [],
  "terms": [
    { "table": "", "column": "", "term": "파이프라인", "def": "" }
  ],
  "examples": [
    { "question": "...", "answer": "..." }
  ]
}
```

| 항목 | 규칙 |
|---|---|
| source | 활성 `server.cloud.log` 또는 `server.local.log` 최근 500 entries |
| terms | 질문 token 빈도, stopword 제거, 최대 8 |
| examples | 질문 뒤 query 1회 이상 성공 답변 조합, 중복 제거, 최대 8 |
| joins | 항상 빈 배열 |
| storage | 없음. client form에 후보만 표시 |
| LLM call | 없음 |

프로젝트 저장은 별도 PATCH가 필요하다.

## 6. 인증·인가

### 6.1 Shared API key

`API_KEY`가 비어 있지 않으면 모든 `/api/*`에 아래 중 하나를 요구한다.

```http
X-API-Key: <shared-secret>
```

또는 기술적으로 `?api_key=<shared-secret>`을 지원한다.

| 항목 | 현재 상태 |
|---|---|
| 미설정 | 인증 없음 |
| 잘못된 키 | 401 |
| 맞는 키 | 12개 API 전부 허용 |
| 사용자 식별 | 없음 |
| 역할/RBAC | 없음 |
| 프로젝트 소유권 | 없음 |
| SPA header 전송 | 없음 |

따라서 별도 인증 프록시가 안전하게 header를 주입하지 않는 한 `API_KEY` 활성화는 현 SPA를 중단시킨다. Query key는 노출 위험 때문에 권장하지 않는다.

### 6.2 Dataverse authorization

앱 서버가 `client_credentials`로 Entra token을 받아 `DATAVERSE_URL/api/data/v9.2/`에 Bearer GET을 보낸다. 앱 코드의 read-only 경계와 별도로 서비스 주체에도 최소 읽기 역할을 부여해야 한다.

### 6.3 LLM authorization

- Anthropic adapter만 `ANTHROPIC_API_KEY`를 `x-api-key`로 보낸다.
- Ollama native adapter는 Authorization header를 보내지 않는다.
- 어느 LLM에도 Dataverse token/client secret/API_KEY를 제공하지 않는다.

## 7. 레이트리밋·동시성·타임아웃

| Control | 대상 | 기본 | 결과 |
|---|---|---:|---|
| FastAPI rate limit | `/api/chat`, `/api/describe` | 20 requests / 60s / IP | 429 JSON; rate-limit header 없음 |
| Semaphore | chat | active 기본 10 + 대기 최대 20 | active와 대기열이 모두 찬 뒤 신규 요청 429 |
| Session lock | 같은 `sessionId` chat | 요청 직렬화 | history 상호삽입·lost update 방지 |
| Provider timeout | 각 stream turn | 120s | SSE error + rollback |
| Dataverse timeout | each fetch | 60s | tool error/endpoint error |
| SSE heartbeat | open chat | 15s | `:hb` comment |
| Graceful shutdown | process | 30s | 연결 종료 후 강제 exit |

레이트리밋은 `request.client.host`를 키로 쓰고 만료 bucket과 최대 bucket 수를 정리한다. 전달 헤더는 기본적으로 loopback proxy만 신뢰하며 `FORWARDED_ALLOW_IPS`로 명시 확장한다. 프로젝트·tables·schema refresh·logs·health·draft에는 별도 rate limit이 없다. 취소·timeout·오류 때 semaphore permit을 반환하고 현재 turn history를 rollback한다.

## 8. 오류 계약

| Status/Event | 적용 | 의미 |
|---|---|---|
| 400 JSON | chat required/type, project payload, describe query | client input 오류 |
| 401 JSON | 모든 API | shared key 실패 |
| 404 JSON | project GET/PATCH/DELETE/chat 및 미등록 `/api/*` | 없음·invalid ID/route |
| 413 JSON | mutation API | body 크기 상한 초과 |
| 415 JSON | mutation API | JSON이 아닌 Content-Type |
| 422 JSON | FastAPI typed path/query validation | 예: `n`에 숫자가 아닌 값; 기본 `detail` 형식 |
| 429 JSON | chat/describe rate, chat overload | 제한 초과 |
| 500 JSON | describe/log 등의 내부 오류 | server/dependency 오류 |
| 503 JSON | chat provider 미설정 | profile 설정 부족 |
| 503 text | SPA build 없음 | `npm run build` 필요 |
| SSE `error` | chat stream 이후 | Dataverse env/provider/tool loop/internal 오류, `max_tokens`·content filter·알 수 없는 provider 종료 사유 |

오류 본문/문구는 사용자에게 비밀을 포함하지 않아야 한다. provider endpoint·OData 오류 preview·질문 preview는 profile log에 남을 수 있다.

## 9. 폐기·미지원 API

| URI/Interface | 상태 | 대체 |
|---|---|---|
| `/api/instructions` 전역 GET/POST | 폐기 | 프로젝트 PATCH `instructions` |
| Cloud 전용 draft | 폐기된 구분 | 공통 `/api/instructions/draft` |
| Provider-specific chat route | 없음 | 공통 `/api/chat` |
| CRM create/update/delete tool | 미지원 | 없음 |
| FastAPI 자동 문서 | 기본 비활성 | `ENABLE_API_DOCS=true`일 때만 `/openapi.json`, `/docs`, `/redoc` 제공; 운영에서는 계속 비활성 권장 |
| Ollama `/v1` OpenAI-compatible | 미지원 | native `/api/chat`, `/api/tags` |

## 10. 보안 이슈와 남은 제약

| Priority | 영역 | 현재 상태 | 영향/조치 |
|:---:|---|---|---|
| P0 | 인증/RBAC | 사용자·역할·소유권 없음 | 내부망 제한, 재개 시 SSO/RBAC |
| P0 | API key/SPA | browser가 header 미전송 | 안전한 auth integration 전 활성화 주의 |
| P0 | 민감 데이터 | cells/history/logs 평문 | ACL·암호화·보존·마스킹 |
| P0 | Cloud 전송 | 질문·schema·tool result 외부 가능 | 데이터 분류·승인 |
| P1 | OData | 첫 entity set·특수 path guard와 `$top<=100`은 적용됐으나 `$expand` 내부 깊이는 완전 통제 아님 | parser·expand depth 상한 |
| P1 | payload | 1 MiB body 상한·JSON media type·outer shape를 검사하나 세부 business rule은 제한적 | JSON Schema·업무 검증 보강 |
| P1 | logs | `/api/logs`에 별도 운영자 권한 없음 | RBAC 전 UI 연결 금지 |
| P1 | local files | project/schema 원자 교체는 적용됐으나 프로세스 간 transaction 없음 | 단일 writer·backup |
| P2 | versioning | `/api/v1` 없음 | breaking change 시 version strategy |

과거 이슈인 chat body tables 신뢰, entity-set fail-open, 비정상 sessionId history path 쓰기, provider별 chat route 차이는 현재 코드에서 해결됐다.

## 11. 프로필 차이

| API 관점 | Cloud | Local | 공통 계약 |
|---|---|---|---|
| `/api/chat` route | 항상 등록 | 항상 등록 | O |
| Chat request/SSE | 동일 | 동일 | O |
| Provider native | Anthropic Messages/SSE | Ollama chat/NDJSON | adapter 내부 |
| Health ping | `/v1/models` | `/api/tags` | health object 동일 |
| Draft | 공통 | 공통 | O |
| Logs API source | server.cloud.log | server.local.log | response 동일 |
| Projects/history | canonical | canonical | O |

## 12. 검수 체크포인트

| ID | 요청 | 기대 결과 |
|---|---|---|
| `API-CHK-01` | 두 프로필 API Index 확인 | 12/12 동일 |
| `API-CHK-02` | provider key 없음 Cloud chat | 503, route 존재 |
| `API-CHK-03` | 없는/invalid sessionId chat | 404, 새 파일 없음 |
| `API-CHK-04` | 잘못된 project payload | 400 |
| `API-CHK-05` | 미등록 table 생성/PATCH | 400 |
| `API-CHK-06` | body tables 조작 chat | HTTP 400; 정상 body에서는 저장 project scope 사용 |
| `API-CHK-07` | absolute/CRLF/backslash/fragment/batch/ref/value path | tool error, Dataverse 미호출 |
| `API-CHK-08` | 허용 entity set 없음 | fail-closed |
| `API-CHK-09` | provider별 tool call | 같은 SSE event 순서·최종 done |
| `API-CHK-10` | 기존 history | normalize 후 성공 시 canonical 저장 |
| `API-CHK-11` | provider timeout/cancel | SSE error·history rollback·permit 반환 |
| `API-CHK-12` | `/api/health` | 실제 provider/status/model/endpoint와 enabled 확인 |
| `API-CHK-13` | `/api/logs` | profile별 활성 파일만 조회 |
| `API-CHK-14` | draft | 두 프로필 200, 자동 저장 없음 |
| `API-CHK-15` | API key + current SPA | 401 제약 확인 |

## 13. 변경 이력

| 버전 | 날짜 | 상태 | 변경 내용 |
|---|---|---|---|
| `1.0` | 2026-08-12 | Superseded | 공통 11 + Cloud 전용 1, FastAPI/Express 차이 기준 |
| `2.0` | 2026-08-12 | Superseded | 공통 12 API와 이전 서버 구현 기준 |
| `3.0` | 2026-08-13 | Final | 공통 Python/FastAPI 12개 제품 API, always-registered chat, provider adapter, project validation, server-authoritative scope, relative OData guard, canonical history, profile logs 기준으로 확정 |
