"""Dataverse(Dynamics 365 CRM) 읽기 전용 MCP 서버 — Python, 이 저장소 안에서 실행.

과거 별도 저장소(crm-ai-chat-dataverse-mcp, Node/TS)로 분리해 관리하던 것을
이 프로젝트 하나로 통합했다. 새 로직을 다시 짜지 않고, 웹앱 채팅이 쓰는 것과
**완전히 동일한** 가드(엔티티 화이트리스트, `$top` 100행 강제, 8 KiB 응답 상한,
Dataverse 인증/재시도)를 backend/chat_api.py·backend/dataverse.py에서 그대로
불러와 재사용한다. 웹앱과 이 MCP 서버가 서로 다른 코드로 갈라져 안전장치가
어긋나는 일이 없도록 하기 위함이다.

이 서버는 crm-ai-chat 웹앱 FastAPI 프로세스와 별도로 실행되는 독립 프로세스다
(MCP 표준이 원래 그런 용도 — MCP client가 필요할 때 이 프로세스를 직접 띄운다).
같은 저장소 안에 있을 뿐, 웹앱이 이 프로세스를 실행하거나 호출하지 않는다.

실행:
  Claude Desktop/Claude Code 등 stdio MCP client에 등록해 쓸 때:
    python -m backend.mcp_server
  원격 HTTP MCP client(streamable-http)에서 쓸 때:
    python -m backend.mcp_server --http --port 8765

Claude Desktop 등록 예시(claude_desktop_config.json):
  {
    "mcpServers": {
      "dataverse": {
        "command": "C:\\path\\to\\.venv\\Scripts\\python.exe",
        "args": ["-m", "backend.mcp_server"],
        "cwd": "C:\\path\\to\\crm-ai-chat"
      }
    }
  }

프로젝트 스코프(테이블 범위 제한)는 웹앱 전용 개념이라 여기서는 적용하지 않는다 —
MCP client는 schema.json에 등록된 전체 카탈로그를 볼 수 있다(READ-ONLY, 화이트
리스트 밖 엔티티는 여전히 거부된다).
"""
from __future__ import annotations

import argparse
import asyncio

from dotenv import load_dotenv

load_dotenv()  # backend.dataverse가 import 시점에 환경변수를 읽으므로 가장 먼저 실행

from mcp.server import MCPServer

from .chat_api import _dataverse_query, _describe_table_from_cache, _read_schema_file
from .dataverse import build_compact_catalog, close_dataverse_client, dataverse_env_missing

app: MCPServer = MCPServer(
    name="crm-ai-chat-dataverse",
    version="1.0.0",
    instructions=(
        "Microsoft Dataverse(Dynamics 365 CRM)를 OData GET으로 읽기 전용 조회하는 도구다. "
        "1) 먼저 dataverse://catalog 리소스로 조회 가능한 테이블 목록을 확인하라. "
        "2) 정확한 컬럼명을 모르면 dataverse_describe_table을 호출하라. "
        "3) dataverse_query를 호출해 실제 데이터를 조회한 결과만 근거로 답하라. "
        "생성·수정·삭제는 지원하지 않는다(읽기 전용)."
    ),
)


@app.resource("dataverse://catalog")
async def catalog() -> str:
    """조회 가능한 전체 테이블 목록(읽기 전용 컨텍스트, 도구 호출 없이 바로 읽힘)."""
    missing = dataverse_env_missing()
    if missing:
        return f"{missing} 환경변수가 설정되지 않았습니다. (.env 확인)"
    text = build_compact_catalog(_read_schema_file())
    return text or "등록된 테이블이 없습니다. crm-ai-chat 웹앱에서 스키마를 먼저 갱신하세요."


@app.tool()
async def dataverse_describe_table(table: str) -> str:
    """테이블 컬럼·타입·설명·엔티티집합명을 schema.json 캐시에서 조회한다(캐시 조회, 네트워크 호출 없음)."""
    return _describe_table_from_cache(table, [])


@app.tool()
async def dataverse_query(path: str) -> str:
    """엔티티집합명으로 시작하는 OData 상대 경로를 GET으로 조회한다(읽기 전용, `$top` 자동 100행 제한)."""
    missing = dataverse_env_missing()
    if missing:
        return f"{missing} 환경변수가 설정되지 않았습니다. (.env 확인)"
    return await _dataverse_query(path, [])


async def _amain(transport: str, port: int) -> None:
    try:
        if transport == "stdio":
            await app.run_stdio_async()
        else:
            await app.run_streamable_http_async(port=port)
    finally:
        await close_dataverse_client()


def main() -> None:
    parser = argparse.ArgumentParser(description="crm-ai-chat Dataverse MCP 서버")
    parser.add_argument("--http", action="store_true", help="streamable-http transport로 실행(기본: stdio)")
    parser.add_argument("--port", type=int, default=8765, help="--http일 때 바인딩 포트(기본 8765)")
    args = parser.parse_args()
    asyncio.run(_amain("streamable-http" if args.http else "stdio", args.port))


if __name__ == "__main__":
    main()
