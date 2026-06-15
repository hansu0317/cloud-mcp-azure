#!/bin/bash
# 스키마 캐시 워밍업 스크립트
# 서버 시작 후 1회 실행 — schema.json에 등록된 테이블 전체를 describe하여 캐시
# ※ 웹 UI의 "스키마 갱신" 버튼과 동일한 효과 (CLI 버전)
# 사용법: ./scripts/warmup_schema.sh [PORT]

PORT="${1:-3000}"
BASE="http://localhost:${PORT}"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  스키마 갱신 요청"
echo "  서버: ${BASE}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

RESULT=$(curl -s --max-time 600 -X POST "${BASE}/api/schemas/refresh")
UPDATED=$(echo "$RESULT" | grep -o '"updated":[0-9]*' | grep -o '[0-9]*')

echo "  완료: ${UPDATED}개 테이블 갱신"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
