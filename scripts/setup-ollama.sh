#!/usr/bin/env bash
# Ollama 설치 확인 + 모델 다운로드 보조 스크립트 (Linux)
# 자동 설치는 하지 않으며 --pull을 명시했을 때만 모델을 내려받는다.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$APP_DIR/.env"

PULL=false
MODEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --pull) PULL=true; shift ;;
    --model) MODEL="$2"; shift 2 ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$MODEL" ]; then
  if [ -f "$ENV_FILE" ] && grep -q '^LOCAL_LLM_MODEL=' "$ENV_FILE"; then
    MODEL="$(grep '^LOCAL_LLM_MODEL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '[:space:]')"
  fi
  [ -n "$MODEL" ] || MODEL="qwen3:30b-a3b"
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Ollama 설치 확인"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if ! command -v ollama >/dev/null 2>&1; then
  echo "[미설치] Ollama가 PATH에 없습니다."
  echo "공식 안내: https://ollama.com/download"
  echo "설치 후 이 스크립트를 다시 실행하세요."
  exit 1
fi

echo "[설치됨] $(ollama --version)"
if systemctl is-active --quiet ollama 2>/dev/null; then
  echo "서비스 상태: systemd로 실행 중"
else
  echo "systemd 서비스가 아니면 'ollama serve'를 별도로 실행해야 할 수 있습니다."
fi
echo "서버 주소: http://localhost:11434"
ollama list

if [ "$PULL" != true ]; then
  echo "대상 모델 '$MODEL'을 받으려면 --pull을 붙여 다시 실행하세요."
  exit 0
fi

echo "모델 다운로드: $MODEL"
ollama pull "$MODEL"
echo "완료: ollama run $MODEL"
