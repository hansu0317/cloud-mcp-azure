module.exports = {
  apps: [{
    name:    'crm-ai-chat',
    script:  'dist-server/server/index.js',  // npm run build:server 후 사용
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
