#!/bin/bash
# CRM Chat 서버 관리 스크립트
# 사용법: ./server.sh {start|stop|status|restart|logs}

APP_NAME="crm-mcp"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$APP_DIR/.server.pid"
LOG_DIR="$APP_DIR/logs"
LOG_FILE="$LOG_DIR/app.log"
NODE_BIN="$(which node)"

mkdir -p "$LOG_DIR"

case "$1" in
  start)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "⚠️  서버가 이미 실행 중입니다. (PID: $(cat "$PID_FILE"))"
      exit 1
    fi
    # 프론트엔드 빌드 (dist/) — tsx로 소스 직접 실행하므로 서버 빌드는 불필요
    echo "🔨 프론트엔드 빌드 중..."
    if ! ( cd "$APP_DIR" && npm run build:client ) >> "$LOG_FILE" 2>&1; then
      echo "❌ 프론트엔드 빌드 실패. 로그를 확인하세요:"
      tail -20 "$LOG_FILE"
      exit 1
    fi
    echo "▶  서버 시작 중..."
    nohup npx --prefix "$APP_DIR" tsx "$APP_DIR/server/index.ts" >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    sleep 1
    if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "✅ 서버 시작 완료 (PID: $(cat "$PID_FILE"))"
      echo "   http://localhost:3000"
      echo "   로그: $LOG_FILE"
    else
      echo "❌ 서버 시작 실패. 로그를 확인하세요:"
      tail -20 "$LOG_FILE"
      rm -f "$PID_FILE"
      exit 1
    fi
    ;;

  stop)
    # PID 파일 없어도 포트로 찾아서 종료 시도
    PID=""
    if [ -f "$PID_FILE" ]; then
      PID="$(cat "$PID_FILE")"
      # PID 파일은 있지만 프로세스가 없으면 포트로 재탐색
      if ! kill -0 "$PID" 2>/dev/null; then
        PID=""
      fi
    fi

    # PID 파일로 못 찾으면 포트 3000 점유 프로세스에서 찾기
    if [ -z "$PID" ]; then
      PID="$(fuser 3000/tcp 2>/dev/null | tr -d ' ')"
    fi

    if [ -z "$PID" ]; then
      echo "⚠️  실행 중인 서버가 없습니다."
      rm -f "$PID_FILE"
      exit 0
    fi

    echo "🛑 서버 종료 중... (PID: $PID)"
    kill "$PID" 2>/dev/null

    # 최대 10초 대기하며 종료 확인
    WAIT=0
    while kill -0 "$PID" 2>/dev/null; do
      sleep 1
      WAIT=$((WAIT + 1))
      if [ "$WAIT" -ge 10 ]; then
        echo "⚠️  Graceful Shutdown 타임아웃 — 강제 종료합니다."
        kill -9 "$PID" 2>/dev/null
        break
      fi
    done

    rm -f "$PID_FILE"
    echo "✅ 서버 중지 완료"
    ;;

  restart)
    "$0" stop
    sleep 1
    "$0" start
    ;;

  status)
    # PID 파일로 먼저 확인, 없으면 포트 3000으로 탐색
    PID=""
    if [ -f "$PID_FILE" ]; then
      PID="$(cat "$PID_FILE")"
      if ! kill -0 "$PID" 2>/dev/null; then
        PID=""
      fi
    fi
    if [ -z "$PID" ]; then
      PID="$(fuser 3000/tcp 2>/dev/null | tr -d ' ')"
    fi

    if [ -n "$PID" ]; then
      echo "✅ 서버 실행 중 (PID: $PID)"
      echo "   http://localhost:3000"
      # PID 파일이 없었으면 복구
      if [ ! -f "$PID_FILE" ] || [ "$(cat "$PID_FILE" 2>/dev/null)" != "$PID" ]; then
        echo "$PID" > "$PID_FILE"
        echo "   ⚠️  PID 파일 재생성됨 ($PID_FILE)"
      fi
      APP_LOG="$LOG_DIR/app.log"
      if [ -f "$APP_LOG" ]; then
        echo ""
        echo "── 최근 로그 ──────────────────────────────"
        tail -5 "$APP_LOG"
      fi
    else
      echo "🛑 서버 중지 상태"
      rm -f "$PID_FILE" 2>/dev/null
    fi
    ;;

  logs)
    APP_LOG="$LOG_DIR/app.log"
    if [ -f "$APP_LOG" ]; then
      echo "── app.log ─────────────────────────────────"
      tail -f "$APP_LOG"
    else
      echo "로그 파일 없음: $APP_LOG"
    fi
    ;;

  logs-error)
    ERR_LOG="$LOG_DIR/error.log"
    if [ -f "$ERR_LOG" ]; then
      echo "── error.log ───────────────────────────────"
      tail -f "$ERR_LOG"
    else
      echo "에러 로그 없음"
    fi
    ;;

  cron-setup)
    CRON_CMD="0 10 * * * $APP_DIR/scripts/log_rotate.sh >> $LOG_DIR/rotate.log 2>&1"
    (crontab -l 2>/dev/null | grep -v "log_rotate.sh"; echo "$CRON_CMD") | crontab -
    echo "✅ 크론탭 등록 완료: 매일 오전 10시 로그 로테이션"
    crontab -l | grep log_rotate
    ;;

  cron-remove)
    (crontab -l 2>/dev/null | grep -v "log_rotate.sh") | crontab -
    echo "🗑  크론탭 제거 완료"
    ;;

  *)
    echo "사용법: $0 {start|stop|restart|status|logs|logs-error|cron-setup|cron-remove}"
    exit 1
    ;;
esac
