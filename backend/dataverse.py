"""Dataverse Web API 직접 연결 (Claude Code/API 불필요 — 순수 REST).

server/dataverse.ts 포팅. 서비스 주체(client_credentials)로 토큰을 받아 Dataverse
Web API/메타데이터를 직접 호출한다. 스키마 갱신(EntityDefinitions)과 데이터 조회
(OData GET) 양쪽에서 공용으로 쓰는 인증·fetch 로직만 여기 둔다. LLM 호출은 이 파일에
전혀 없음.

필요 환경변수: DATAVERSE_TENANT_ID / DATAVERSE_CLIENT_ID /
              DATAVERSE_CLIENT_SECRET / DATAVERSE_URL
"""
from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass
from typing import Any

import httpx

TENANT_ID = os.environ.get("DATAVERSE_TENANT_ID", "")
CLIENT_ID = os.environ.get("DATAVERSE_CLIENT_ID", "")
CLIENT_SEC = os.environ.get("DATAVERSE_CLIENT_SECRET", "")
DV_URL = os.environ.get("DATAVERSE_URL", "").rstrip("/")
API_VERSION = "v9.2"
REQUEST_TIMEOUT_S = int(os.environ.get("DESCRIBE_TIMEOUT_MS", "60000")) / 1000


def dataverse_env_missing() -> str | None:
    if not TENANT_ID:
        return "DATAVERSE_TENANT_ID"
    if not CLIENT_ID:
        return "DATAVERSE_CLIENT_ID"
    if not CLIENT_SEC:
        return "DATAVERSE_CLIENT_SECRET"
    if not DV_URL:
        return "DATAVERSE_URL"
    return None


# ─── 액세스 토큰 (client_credentials, 캐시) ──────────────────────────────────
@dataclass
class _TokenCache:
    value: str
    exp_ms: float


_token_cache: _TokenCache | None = None
_http = httpx.AsyncClient(timeout=REQUEST_TIMEOUT_S)


async def get_dataverse_token() -> str:
    global _token_cache
    now_ms = time.time() * 1000
    if _token_cache and now_ms < _token_cache.exp_ms - 60_000:
        return _token_cache.value

    token_url = f"https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token"
    body = {
        "grant_type": "client_credentials",
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SEC,
        "scope": f"{DV_URL}/.default",
    }
    resp = await _http.post(token_url, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"})
    if resp.status_code >= 400:
        raise RuntimeError(f"토큰 발급 실패 ({resp.status_code}): {resp.text[:200]}")
    data = resp.json()
    _token_cache = _TokenCache(value=data["access_token"], exp_ms=now_ms + data["expires_in"] * 1000)
    return _token_cache.value


# ─── Dataverse Web API 인증된 GET (원문 Response 반환) ──────────────────────
async def dataverse_fetch(rel_path: str) -> httpx.Response:
    token = await get_dataverse_token()
    clean = rel_path.lstrip("/")
    url = f"{DV_URL}/api/data/{API_VERSION}/{clean}"
    return await _http.get(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0",
            "Prefer": 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"',
        },
    )


# ─── 데이터 조회용 GET (텍스트 반환, 호출측에서 truncate 등 가공) ────────────
# 자가 복구 2종:
#  - 네트워크 레벨 순간 오류 → 300ms 후 1회 재시도
#  - 401 Unauthorized(시크릿 로테이션·토큰 조기 폐기 등) → 토큰 캐시 무효화 후 1회 재발급 재시도
# 그 외 HTTP 오류(404/400/5xx)는 그대로 던져 호출측(모델의 tool_result)에 전달한다.
async def dataverse_get(rel_path: str) -> str:
    global _token_cache

    async def attempt() -> httpx.Response:
        return await dataverse_fetch(rel_path)

    try:
        resp = await attempt()
    except httpx.TransportError:
        await asyncio.sleep(0.3)
        resp = await attempt()

    if resp.status_code == 401:
        _token_cache = None
        resp = await attempt()

    if resp.status_code >= 400:
        raise RuntimeError(f"OData {resp.status_code}: {resp.text[:300]}")
    return resp.text


# ─── 엔티티 메타데이터 → 마크다운 스키마 표 (describe 대체, LLM 미사용) ──────
def _label_of(label: dict[str, Any] | None, fallback: str) -> str:
    if not label:
        return fallback
    localized = label.get("UserLocalizedLabel") or {}
    if localized.get("Label"):
        return localized["Label"]
    labels = label.get("LocalizedLabels") or []
    if labels and labels[0].get("Label"):
        return labels[0]["Label"]
    return fallback


async def _fetch_picklist_options(logical_name: str, attr_logical_name: str) -> str | None:
    try:
        path = (
            f"EntityDefinitions(LogicalName='{logical_name}')/Attributes(LogicalName='{attr_logical_name}')"
            "/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName"
            "&$expand=OptionSet($select=Options),GlobalOptionSet($select=Options)"
        )
        text = await dataverse_get(path)
        import json

        meta = json.loads(text)
        options = (meta.get("OptionSet") or {}).get("Options") or (meta.get("GlobalOptionSet") or {}).get("Options") or []
        if not options:
            return None
        return " / ".join(_label_of(o.get("Label"), str(o["Value"])) for o in options)
    except Exception:
        return None  # 옵션 라벨은 부가 정보 — 실패해도 전체 갱신은 막지 않음


@dataclass
class EntitySchemaResult:
    entity_set_name: str
    markdown: str


async def fetch_entity_schema(logical_name: str) -> EntitySchemaResult:
    import json

    path = (
        f"EntityDefinitions(LogicalName='{logical_name}')"
        "?$select=EntitySetName,DisplayName"
        "&$expand=Attributes($select=LogicalName,AttributeType,DisplayName,RequiredLevel)"
    )
    text = await dataverse_get(path)
    meta = json.loads(text)
    attrs: list[dict[str, Any]] = meta.get("Attributes") or []
    if not attrs:
        raise RuntimeError("속성 정보를 가져오지 못했습니다.")

    # Choice(Picklist) 컬럼만 옵션 라벨을 병렬로 추가 조회 (그 외 타입은 REST 1회로 충분)
    picklist_attrs = [a for a in attrs if a.get("AttributeType") == "Picklist"]
    option_entries = await asyncio.gather(
        *(_fetch_picklist_options(logical_name, a["LogicalName"]) for a in picklist_attrs)
    )
    option_map = {a["LogicalName"]: opt for a, opt in zip(picklist_attrs, option_entries)}

    rows = []
    for a in attrs:
        label = _label_of(a.get("DisplayName"), a["LogicalName"])
        required_level = (a.get("RequiredLevel") or {}).get("Value")
        required = required_level in ("ApplicationRequired", "SystemRequired")
        options = option_map.get(a["LogicalName"])
        desc = f"{label}{f' ({options})' if options else ''}{' (필수)' if required else ''}"
        rows.append(f"| {a['LogicalName']} | {a.get('AttributeType', '?')} | {desc} |")

    markdown = "\n".join(["| 컬럼명 | 타입 | 한국어 설명 |", "|---|---|---|", *rows])
    entity_set_name = meta.get("EntitySetName") or f"{logical_name}s"
    return EntitySchemaResult(entity_set_name=entity_set_name, markdown=markdown)


# ─── schema.json 공용 타입 + 얇은 카탈로그 (컨텍스트 절약, LLM 진행형 조회용) ──
# 매 세션 첫 메시지에 전체 테이블 전체 컬럼(수만 자)을 다 넣으면 비용·속도가
# 나빠진다. 대신 "카탈로그"(테이블명·라벨·엔티티집합명 한 줄)만 넣고, 모델이
# 실제로 필요한 테이블에 한해 describe 도구를 호출해 전체 컬럼을 가져오게 한다.
@dataclass
class SchemaEntry:
    label: str | None = None
    domain: str | None = None
    schema: str | None = None
    updated_at: str | None = None
    entity_set_name: str | None = None

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "SchemaEntry":
        return SchemaEntry(
            label=d.get("label"), domain=d.get("domain"), schema=d.get("schema"),
            updated_at=d.get("updatedAt"), entity_set_name=d.get("entitySetName"),
        )

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {}
        if self.label is not None:
            d["label"] = self.label
        if self.domain is not None:
            d["domain"] = self.domain
        if self.schema is not None:
            d["schema"] = self.schema
        if self.updated_at is not None:
            d["updatedAt"] = self.updated_at
        if self.entity_set_name is not None:
            d["entitySetName"] = self.entity_set_name
        return d


def build_compact_catalog(data: dict[str, SchemaEntry]) -> str:
    lines = []
    for table, info in data.items():
        if not info.schema:
            continue
        label = f" ({info.label})" if info.label else ""
        domain = f" [{info.domain}]" if info.domain else ""
        set_name = f" — 엔티티집합명: {info.entity_set_name}" if info.entity_set_name else ""
        lines.append(f"- {table}{label}{domain}{set_name}")
    return "\n".join(lines)
