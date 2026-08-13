"""Local Ollama + FastAPI + Dataverse `$top=0` 안전 종단간 검증.

실제 CRM 행·질문·도구 입력·응답 본문·비밀값은 출력하지 않는다. 임시 프로젝트와
프로세스는 성공/실패와 관계없이 정리한다. 실행 전 Ollama와 `.env` 설정이 필요하다.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import socket
import sys
import time
from typing import Any

import httpx
from dotenv import dotenv_values


ROOT = Path(__file__).resolve().parent.parent
PORT = 31987
BASE_URL = f"http://127.0.0.1:{PORT}"
MARKER = "FASTAPI-E2E-20260813"
STDOUT_PATH = ROOT / ".fastapi-live-e2e.stdout.log"
STDERR_PATH = ROOT / ".fastapi-live-e2e.stderr.log"


def _result(**values: Any) -> None:
    print(json.dumps(values, ensure_ascii=False, sort_keys=True))


def _port_is_in_use() -> bool:
    try:
        with socket.create_connection(("127.0.0.1", PORT), timeout=0.2):
            return True
    except OSError:
        return False


def _wait_for_health(client: httpx.Client) -> dict[str, Any]:
    deadline = time.monotonic() + 30
    last: dict[str, Any] = {}
    while time.monotonic() < deadline:
        try:
            response = client.get("/api/health")
            if response.status_code == 200:
                last = response.json()
                if last.get("schemaTables") == 36:
                    return last
        except httpx.HTTPError:
            pass
        time.sleep(0.25)
    raise RuntimeError("health_timeout")


def main() -> int:
    stage = "prepare"
    project_id: str | None = None
    process: subprocess.Popen[bytes] | None = None
    stdout_handle = None
    stderr_handle = None
    cleanup_deleted = False
    cleanup_get_404 = False
    try:
        if _port_is_in_use():
            raise RuntimeError("e2e_port_already_in_use")
        schema = json.loads((ROOT / "data" / "schema.json").read_text(encoding="utf-8"))
        table = sorted(schema)[0]
        entity_set = str(schema[table].get("entitySetName") or "")
        if not entity_set:
            raise RuntimeError("missing_entity_set")

        dotenv = dotenv_values(ROOT / ".env")
        api_key = str(dotenv.get("API_KEY") or "")
        headers = {"X-API-Key": api_key} if api_key else {}

        env = os.environ.copy()
        env["PORT"] = str(PORT)
        env["LLM_PROVIDER"] = "ollama"
        env["LLM_MODEL"] = "qwen3:8b"
        env["LLM_BASE_URL"] = "http://127.0.0.1:11434"
        stdout_handle = STDOUT_PATH.open("wb")
        stderr_handle = STDERR_PATH.open("wb")
        process = subprocess.Popen(
            [sys.executable, "-m", "backend.main"],
            cwd=ROOT,
            env=env,
            stdout=stdout_handle,
            stderr=stderr_handle,
        )

        with httpx.Client(
            base_url=BASE_URL,
            headers=headers,
            timeout=httpx.Timeout(240.0),
            trust_env=False,
        ) as client:
            stage = "health"
            health = _wait_for_health(client)
            chat_health = health.get("chat") if isinstance(health.get("chat"), dict) else {}
            provider_health = (
                chat_health.get("health") if isinstance(chat_health.get("health"), dict) else {}
            )

            stage = "create_project"
            response = client.post(
                "/api/projects",
                json={"name": "FastAPI live E2E 2026-08-13", "tables": [table]},
            )
            response.raise_for_status()
            project_id = str(response.json()["id"])

            stage = "patch_instructions"
            instructions = {
                "joins": [],
                "terms": [],
                "examples": [
                    {
                        "question": "FastAPI read-only tool verification",
                        "answer": (
                            "먼저 dataverse_describe_table을 호출한 뒤 dataverse_query를 "
                            f"{entity_set}?$top=0 경로로 호출하고, 답변 마지막에 {MARKER}를 적는다."
                        ),
                    }
                ],
            }
            response = client.patch(
                f"/api/projects/{project_id}", json={"instructions": instructions}
            )
            response.raise_for_status()
            marker_saved = response.json().get("instructions", {}).get("examples", [{}])[0].get(
                "answer", ""
            ).endswith(MARKER + "를 적는다.")

            stage = "chat"
            question = (
                f"{table} 테이블을 대상으로 먼저 dataverse_describe_table을 호출하고, "
                f"그 다음 dataverse_query를 {entity_set}?$top=0 경로로 정확히 호출하세요. "
                f"조회 결과를 짧게 요약하고 마지막에 {MARKER}를 그대로 적으세요."
            )
            events: list[dict[str, Any]] = []
            with client.stream(
                "POST", "/api/chat", json={"message": question, "sessionId": project_id}
            ) as response:
                response.raise_for_status()
                for line in response.iter_lines():
                    if line.startswith("data:"):
                        event = json.loads(line[5:].strip())
                        if isinstance(event, dict):
                            events.append(event)

            text = "".join(
                str(event.get("text") or "") for event in events if event.get("type") == "text"
            )
            describe_events = sum(
                1
                for event in events
                if event.get("type") == "query"
                and event.get("tool") == "dataverse_describe_table"
            )
            query_events = [
                event
                for event in events
                if event.get("type") == "query" and event.get("tool") == "dataverse_query"
            ]
            top_zero = any(
                isinstance(event.get("input"), dict)
                and "$top=0" in str(event["input"].get("path") or "")
                for event in query_events
            )
            error_events = sum(1 for event in events if event.get("type") == "error")
            done_events = sum(1 for event in events if event.get("type") == "done")

            stage = "cleanup_project"
            cleanup_deleted = client.delete(f"/api/projects/{project_id}").status_code == 200
            cleanup_get_404 = client.get(f"/api/projects/{project_id}").status_code == 404
            project_id = None

            passed = all(
                [
                    health.get("schemaTables") == 36,
                    chat_health.get("provider") == "ollama",
                    chat_health.get("configured") is True,
                    provider_health.get("status") == "ok",
                    marker_saved,
                    describe_events >= 1,
                    len(query_events) >= 1,
                    top_zero,
                    error_events == 0,
                    done_events == 1,
                    MARKER in text,
                    cleanup_deleted,
                    cleanup_get_404,
                ]
            )
            _result(
                passed=passed,
                backend="python-fastapi",
                provider="ollama",
                health=provider_health.get("status"),
                schemaTables=health.get("schemaTables"),
                projectInstructionsSaved=marker_saved,
                describeCalls=describe_events,
                queryCalls=len(query_events),
                topZeroConfirmed=top_zero,
                crmRowsSentToLlm=0,
                doneEvents=done_events,
                errorEvents=error_events,
                markerConfirmed=MARKER in text,
                answerChars=len(text),
                answerSha256Prefix=hashlib.sha256(text.encode("utf-8")).hexdigest()[:16],
                cleanupDelete=cleanup_deleted,
                cleanupGet404=cleanup_get_404,
            )
            return 0 if passed else 2
    except Exception as exc:
        _result(passed=False, stage=stage, errorType=type(exc).__name__)
        return 1
    finally:
        if project_id:
            try:
                dotenv = dotenv_values(ROOT / ".env")
                api_key = str(dotenv.get("API_KEY") or "")
                headers = {"X-API-Key": api_key} if api_key else {}
                with httpx.Client(
                    base_url=BASE_URL, headers=headers, timeout=5, trust_env=False
                ) as cleanup_client:
                    cleanup_client.delete(f"/api/projects/{project_id}")
            except Exception:
                pass
        if process is not None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        if stdout_handle is not None:
            stdout_handle.close()
        if stderr_handle is not None:
            stderr_handle.close()
        for temporary_log in (STDOUT_PATH, STDERR_PATH):
            try:
                temporary_log.unlink()
            except FileNotFoundError:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
