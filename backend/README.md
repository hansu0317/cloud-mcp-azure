# backend — Python(FastAPI) 백엔드

claudeapi/chat-api.ts + server/*.ts를 대체하는 Python 백엔드. 프로세스 spawn 없이
`api.anthropic.com`에 직접 호출하고, Dataverse는 [dataverse.py](dataverse.py)(서비스
주체 client_credentials + OData GET)로 직접 조회합니다.

> 2026-08: TypeScript(Express) 백엔드를 Python(FastAPI)으로 전환. API 계약(엔드포인트
> 경로·요청/응답 JSON 모양·SSE 이벤트 포맷)과 `data/*.json` 파일 포맷은 그대로 유지되어
> 프론트엔드(`src/`)는 무변경입니다.

## 엔드포인트

- `POST /api/chat`
  - 요청: `{ message, sessionId, tables? }` — `sessionId`는 프로젝트 id([projects.py](projects.py)),
    `tables`는 그 프로젝트의 테이블 스코프(빈 배열/미지정이면 전체 테이블)
  - 응답(SSE): `text` / `tool` / `query` / `error` / `done`

프로젝트 CRUD(`/api/projects*`)는 [main.py](main.py) + [projects.py](projects.py) 참고 —
전체 아키텍처는 리포 루트의 [README.md](../README.md)에 정리돼 있습니다.

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
python -m venv .venv
.venv\Scripts\activate       # Windows (bash면 source .venv/bin/activate)
pip install -r requirements.txt

npm install
npm run dev                  # 서버(uvicorn --reload) + 프론트(vite) 동시 실행
```

기동 로그에 `채팅 엔드포인트 등록됨 — POST /api/chat` 이 출력됩니다.

## 구현 메모

- 세션별 대화 히스토리는 인메모리(`chat_api._history_map`, 최근 20메시지)를 1차 캐시로
  쓰고, 매 요청 후 [projects.py](projects.py)를 통해 `data/projects/<id>.json`에도
  저장한다. 인메모리 캐시가 비어있으면(서버 재시작 등) 그 파일에서 복구하므로, 다중
  인스턴스로 수평 확장하지 않는 한 재시작해도 대화 맥락이 끊기지 않는다.
- 히스토리 트리밍은 "일반 텍스트 user 메시지" 경계에서만 자른다 —
  tool_use/tool_result 쌍이 깨지면 그 세션의 모든 후속 요청이 400으로 실패하기 때문.
- 프로젝트에 테이블 스코프(`tables`)가 지정돼 있으면 시스템 프롬프트 카탈로그와
  OData 가드(`_guard_odata_path`) 양쪽을 그 범위로 제한한다 — 모델이 스코프 밖 테이블을
  조회하려 해도 서버가 차단하고 `tool_result` 오류로 돌려보낸다.
- SSE는 `asyncio.Queue` + 15초 하트비트로 구현([sse.py](sse.py)) — Node의
  `setInterval` 하트비트와 동일한 역할이다. 클라이언트 연결 종료는
  `request.is_disconnected()`로 감지해 백그라운드 Claude 호출 태스크를 취소한다.
