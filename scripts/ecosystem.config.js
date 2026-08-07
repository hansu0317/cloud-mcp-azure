module.exports = {
  apps: [{
    name:        'crm-ai-chat',
    // backend/main.py는 패키지 내부 상대 임포트(from .chat_api import ...)를 쓰므로
    // `python backend/main.py`로 직접 실행하면 안 되고 `python -m backend.main`이어야
    // 한다. interpreter를 'none'으로 두고 script 자리에 파이썬 실행 파일 자체를 지정해
    // pm2가 그대로 `<script> <args>` = `python -m backend.main`을 실행하게 한다.
    script:      '.venv/bin/python',   // venv 없으면 'python3'/'python'으로 교체
    interpreter: 'none',
    args:        '-m backend.main',
    instances: 1,        // 세션 히스토리가 인메모리라 단일 인스턴스
    autorestart: true,
    watch:   false,
    max_memory_restart: '500M',

    env_production: {
      NODE_ENV: 'production',
      PORT:     3000,
    },

    // PM2 자체 로그 (app.log/error.log 와 별개)
    error_file:      'logs/pm2-error.log',
    out_file:        'logs/pm2-out.log',
    merge_logs:      true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  }],
};

// 사용법:
//   pm2 start ecosystem.config.js --env production
//   pm2 save        ← 재부팅 후 자동 시작 등록
//   pm2 startup     ← 시스템 서비스 등록 (안내 명령어 출력)
//   pm2 logs crm-ai-chat
//   pm2 restart crm-ai-chat
