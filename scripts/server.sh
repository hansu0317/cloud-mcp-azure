#!/usr/bin/env bash
# Quali CRM AI Notebook FastAPI server management
set -u
set -o pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$APP_DIR/.env"
PID_FILE="$APP_DIR/.server.pid"
LOG_DIR="$APP_DIR/logs"

read_env_value() {
  local key="$1" raw value pattern="^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=(.*)$"
  [ -f "$ENV_FILE" ] || return 1
  while IFS= read -r raw || [ -n "$raw" ]; do
    raw="${raw%$'\r'}"
    if [[ "$raw" =~ $pattern ]]; then
      value="${BASH_REMATCH[2]}"; value="${value#"${value%%[![:space:]]*}"}"; value="${value%"${value##*[![:space:]]}"}"
      if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]] || [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
        value="${value:1:${#value}-2}"
      else
        value="${value%%[[:space:]]#*}"; value="${value%"${value##*[![:space:]]}"}"
      fi
      printf '%s\n' "$value"; return 0
    fi
  done < "$ENV_FILE"
  return 1
}

PORT="${PORT:-$(read_env_value PORT || true)}"; [ -n "$PORT" ] || PORT=3000
PROVIDER="${LLM_PROVIDER:-$(read_env_value LLM_PROVIDER || true)}"; [ -n "$PROVIDER" ] || PROVIDER=anthropic
PROVIDER="$(printf '%s' "$PROVIDER" | tr '[:upper:]' '[:lower:]')"
case "$PROVIDER" in anthropic) PROFILE=cloud ;; ollama) PROFILE=local ;; *) echo "Invalid LLM_PROVIDER: $PROVIDER" >&2; exit 1 ;; esac
case "$PORT" in *[!0-9]*|'') echo "Invalid PORT: $PORT" >&2; exit 1 ;; esac
[ "$PORT" -ge 1 ] 2>/dev/null && [ "$PORT" -le 65535 ] 2>/dev/null || { echo "Invalid PORT range: $PORT (allowed: 1..65535)" >&2; exit 1; }

bounded_timeout() {
  local name="$1" default="$2" value
  eval "value=\${$name:-}"
  [ -n "$value" ] || value="$(read_env_value "$name" || true)"
  [ -n "$value" ] || value="$default"
  case "$value" in *[!0-9]*|'') echo "Invalid $name: $value" >&2; exit 1 ;; esac
  [ "$value" -ge 1 ] && [ "$value" -le 300 ] || { echo "Invalid $name range: $value (allowed: 1..300)" >&2; exit 1; }
  printf '%s\n' "$value"
}

START_TIMEOUT="$(bounded_timeout SERVER_START_TIMEOUT_SECONDS 30)"
STOP_TIMEOUT="$(bounded_timeout SERVER_STOP_TIMEOUT_SECONDS 30)"

STRUCTURED_LOG="$LOG_DIR/server.$PROFILE.log"
PYTHON_BIN="$APP_DIR/.venv/bin/python"; [ -x "$PYTHON_BIN" ] || PYTHON_BIN="$(command -v python3 || command -v python)"

is_owned_pid() {
  local candidate="$1" command cwd
  case "$candidate" in *[!0-9]*|'') return 1 ;; esac
  kill -0 "$candidate" 2>/dev/null || return 1
  command="$(ps -p "$candidate" -o command= 2>/dev/null || true)"
  case "$command" in *"-m backend.main"*) ;; *) return 1 ;; esac
  if [ -e "/proc/$candidate/cwd" ]; then
    cwd="$(readlink "/proc/$candidate/cwd" 2>/dev/null || true)"
    [ "$cwd" = "$APP_DIR" ] || return 1
  fi
  return 0
}

port_owner_pid() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1
  elif command -v fuser >/dev/null 2>&1; then
    fuser "$PORT/tcp" 2>/dev/null | awk '{print $1}'
  fi
}

find_server_pid() {
  local candidate
  if [ -f "$PID_FILE" ]; then
    candidate="$(cat "$PID_FILE" 2>/dev/null || true)"
    is_owned_pid "$candidate" && { printf '%s\n' "$candidate"; return; }
  fi
  candidate="$(port_owner_pid || true)"
  [ -z "$candidate" ] || is_owned_pid "$candidate" && printf '%s\n' "$candidate"
}

start_server() {
  local existing pid owner waited
  existing="$(find_server_pid || true)"; [ -z "$existing" ] || { echo "[WARN] server already running (PID: $existing)"; exit 1; }
  owner="$(port_owner_pid || true)"
  [ -z "$owner" ] || { echo "[FAIL] port $PORT is occupied by a process this script does not own; refusing to manage it." >&2; exit 1; }
  mkdir -p "$LOG_DIR"
  echo '[BUILD] building React client...'; (cd "$APP_DIR" && npm run build:client) || exit 1
  echo "[START] starting FastAPI $PROFILE profile ($PROVIDER)..."
  (cd "$APP_DIR" && nohup "$PYTHON_BIN" -m backend.main >/dev/null 2>&1 & echo $! > "$PID_FILE")
  pid="$(cat "$PID_FILE")"; waited=0
  while [ "$waited" -lt "$START_TIMEOUT" ]; do
    is_owned_pid "$pid" || break
    owner="$(port_owner_pid || true)"
    [ "$owner" = "$pid" ] && break
    sleep 1; waited=$((waited+1))
  done
  owner="$(port_owner_pid || true)"
  if ! is_owned_pid "$pid" || [ "$owner" != "$pid" ]; then
    echo "[FAIL] server did not listen on port $PORT within ${START_TIMEOUT}s"
    tail -20 "$STRUCTURED_LOG" 2>/dev/null || true
    is_owned_pid "$pid" && kill -9 "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"; exit 1
  fi
  echo "[OK] FastAPI server started (PID: $pid)"; echo "     profile: $PROFILE ($PROVIDER)"; echo "     url: http://localhost:$PORT"; echo "     structured log: $STRUCTURED_LOG"
}

stop_server() {
  local pid; pid="$(find_server_pid || true)"; [ -n "$pid" ] || { echo '[WARN] no server running'; rm -f "$PID_FILE"; return; }
  kill "$pid" 2>/dev/null || true
  local waited=0; while is_owned_pid "$pid"; do
    sleep 1; waited=$((waited+1))
    [ "$waited" -lt "$STOP_TIMEOUT" ] || { echo "[WARN] graceful stop timed out after ${STOP_TIMEOUT}s; forcing owned process."; is_owned_pid "$pid" && kill -9 "$pid" 2>/dev/null || true; break; }
  done
  rm -f "$PID_FILE"; echo '[OK] server stopped'
}

case "${1:-}" in
  start) start_server ;;
  stop) stop_server ;;
  restart) stop_server; sleep 1; start_server ;;
  status) pid="$(find_server_pid || true)"; [ -n "$pid" ] && echo "[OK] FastAPI server running (PID: $pid, $PROFILE/$PROVIDER, http://localhost:$PORT)" || echo '[STOPPED] server is not running' ;;
  logs) [ -f "$STRUCTURED_LOG" ] && tail -20 -f "$STRUCTURED_LOG" || echo "Log file not found: $STRUCTURED_LOG" ;;
  *) echo "Usage: $0 {start|stop|restart|status|logs}"; exit 1 ;;
esac
