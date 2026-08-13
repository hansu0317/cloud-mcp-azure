"""`.env`의 PORT를 존중하는 FastAPI 개발 서버 진입점."""
from __future__ import annotations

import os
import sys

from dotenv import load_dotenv


def main() -> None:
    if sys.version_info < (3, 11):
        raise RuntimeError("crm-ai-chat FastAPI 백엔드는 Python 3.11 이상이 필요합니다.")
    load_dotenv()
    port_text = os.environ.get("PORT", "3000")
    try:
        port = int(port_text)
    except ValueError as exc:
        raise RuntimeError(f"PORT는 정수여야 합니다: {port_text!r}") from exc
    if not 1 <= port <= 65535:
        raise RuntimeError(f"PORT 범위는 1..65535여야 합니다: {port}")

    import uvicorn

    uvicorn.run(
        "backend.main:app",
        host=os.environ.get("DEV_HOST", "127.0.0.1"),
        port=port,
        reload=True,
        proxy_headers=True,
        forwarded_allow_ips=os.environ.get("FORWARDED_ALLOW_IPS", "127.0.0.1,::1"),
    )


if __name__ == "__main__":
    main()
