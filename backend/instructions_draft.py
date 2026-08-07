"""instructions.json 초안 자동 생성 — logs/app.log의 실제 사용 이력에서 후보를 뽑는다.

GET /api/instructions/draft (backend/main.py)가 이 모듈을 호출한다. 사람이 매번 빈
화면에서부터 조인/용어/예시를 타이핑하는 대신, 이미 실제로 오간 질문·답변에서
후보를 자동으로 채워 InstructionsModal에 미리 보여주고 사람은 검토·수정·삭제만
하도록 하는 게 목적이다 — 완전 자동 저장은 하지 않는다(틀린 지침이 잘못된 답변을
계속 재생산할 수 있어서, 최종 승인은 항상 사람이 함).

joins(조인 관계)는 의도적으로 항상 빈 배열을 반환한다: Lookup 컬럼이 실제로 어느
테이블을 가리키는지(대상 엔티티)는 지금 schema.json에 없는 정보라, Dataverse의
Microsoft.Dynamics.CRM.LookupAttributeMetadata($expand=Targets)를 테이블별로 추가
조회해야 한다 — 스키마 갱신(36개 테이블) 시간에 영향을 주는 작업이라 별도로 계획만
해두고 이번 자동 초안 생성 범위에서는 뺐다(TODO: 다음 스프린트).
"""
from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path
from typing import Any

LOG_FILE = Path.cwd() / "logs" / "app.log"
MAX_LOG_ENTRIES = 500   # 오래된 로그까지 전부 훑을 필요는 없음 — 최근 이력이면 충분

# 답변 로그 끝에 붙는 "(9.2초, 쿼리 2회, 토큰 in:11293 out:320 …)" 통계 접미사 제거용
_STATS_SUFFIX_RE = re.compile(r"\s*\([\d.]+초,\s*쿼리\s*\d+회.*?\)\s*$")
_QUERY_COUNT_RE = re.compile(r"쿼리\s*(\d+)회")

# 조사·어미 등 아주 단순한 접미사만 제거하는 가벼운 휴리스틱(형태소 분석기 없음) —
# 완벽한 어간 추출이 아니라 "그럴듯한 후보"를 뽑는 용도라 사람의 최종 검토를 전제로 한다.
_SUFFIXES = [
    "으로부터", "에서부터", "에서", "으로", "까지", "부터", "이랑", "하고", "한테",
    "에게", "이나", "라도", "이라", "랑", "도", "만", "은", "는", "이", "가",
    "을", "를", "의", "와", "과", "로",
]
_STOPWORDS = {
    "조회", "보여줘", "보여주세요", "알려줘", "알려주세요", "해줘", "해주세요",
    "좀", "뭐", "어떤", "얼마", "몇", "줘", "전체", "모든", "전부", "관련",
    "최근", "순서로", "순으로", "결과", "맞아", "진짜", "현재", "그냥", "그거",
    "이거", "저거", "우리", "나온", "나온거", "인지", "인가요", "있나",
    "목록", "것만", "중에서", "만보여줘",
}
# "3건", "5개"처럼 숫자로 시작하는 토큰은 업무 용어가 아니라 개수 표현이라 후보에서 제외
_NUMERIC_TOKEN_RE = re.compile(r"^\d+[가-힣]{0,2}$")


def _strip_suffix(token: str) -> str:
    for suf in _SUFFIXES:
        if len(token) > len(suf) + 1 and token.endswith(suf):
            return token[: -len(suf)]
    return token


def _read_log_entries() -> list[dict[str, Any]]:
    try:
        lines = LOG_FILE.read_text(encoding="utf-8").strip().split("\n")
    except OSError:
        return []
    entries: list[dict[str, Any]] = []
    for line in lines[-MAX_LOG_ENTRIES:]:
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return entries  # 파일 순서 그대로 = 시간순


def _draft_examples(entries: list[dict[str, Any]], max_n: int = 8) -> list[dict[str, str]]:
    """API-질문 다음에 나오는 API-답변 중, 실제로 쿼리를 1회 이상 성공시킨 쌍만 후보로 승격."""
    examples: list[dict[str, str]] = []
    seen_questions: set[str] = set()
    pending_question: str | None = None

    for entry in entries:
        category = entry.get("category")
        message = entry.get("message", "")
        if category == "API-질문":
            pending_question = message
        elif category == "API-답변" and pending_question:
            m = _QUERY_COUNT_RE.search(message)
            query_count = int(m.group(1)) if m else 0
            if query_count >= 1 and pending_question not in seen_questions:
                answer = _STATS_SUFFIX_RE.sub("", message).strip()
                examples.append({"question": pending_question, "answer": answer})
                seen_questions.add(pending_question)
            pending_question = None

    return examples[-max_n:]  # 최신순으로 최대 max_n개


def _draft_terms(entries: list[dict[str, Any]], max_n: int = 8) -> list[dict[str, str]]:
    """실제 질문에서 자주 등장하는 단어를 빈도순으로 뽑아 term 후보(table/column/def는 빈 채)로 반환."""
    counter: Counter[str] = Counter()
    for entry in entries:
        if entry.get("category") != "API-질문":
            continue
        question = entry.get("message", "")
        for raw_token in re.split(r"[\s,.?!·/]+", question):
            token = _strip_suffix(raw_token.strip())
            if len(token) < 2 or token in _STOPWORDS or _NUMERIC_TOKEN_RE.match(token):
                continue
            counter[token] += 1

    return [
        {"table": "", "column": "", "term": word, "def": ""}
        for word, _count in counter.most_common(max_n)
    ]


def build_instructions_draft() -> dict[str, list[dict[str, str]]]:
    entries = _read_log_entries()
    return {
        "joins": [],   # 의도적으로 비움 — 모듈 docstring 참고 (다음 스프린트 예정)
        "terms": _draft_terms(entries),
        "examples": _draft_examples(entries),
    }
