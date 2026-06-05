const express = require('express');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const path = require('path');

const app = express();
const PORT = 3000;
const CWD = __dirname;

// cmd.exe 경유 시 한국어 인코딩 깨짐 → claude.exe 직접 실행
const CLAUDE_BIN = process.platform === 'win32'
  ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
  : 'claude';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 웹 세션 ID → Claude 세션 ID 매핑
const sessionMap = new Map();

app.post('/api/session/new', (req, res) => {
  const sessionId = randomUUID();
  res.json({ sessionId });
});

app.post('/api/chat', (req, res) => {
  const { message, sessionId } = req.body;

  if (!message || !sessionId) {
    return res.status(400).json({ error: 'message와 sessionId가 필요합니다.' });
  }

  // SSE 헤더 설정
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const args = [
    '-p', message,
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
  ];

  // 기존 세션이 있으면 이어서 대화
  const claudeSessionId = sessionMap.get(sessionId);
  if (claudeSessionId) {
    args.push('--resume', claudeSessionId);
  }

  const claude = spawn(CLAUDE_BIN, args, {
    cwd: CWD,
    shell: false,              // shell 미사용 → 인코딩 문제 없음
    stdio: ['ignore', 'pipe', 'pipe'],  // stdin 무시 → 3초 대기 없음
    env: process.env,
  });

  claude.stdout.setEncoding('utf8');
  claude.stderr.setEncoding('utf8');

  let buffer = '';
  let lastText = '';
  let newSessionId = null;
  let finished = false;

  const send = (data) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };

  claude.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // 마지막 미완성 줄은 버퍼에 유지

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const event = JSON.parse(trimmed);

        if (event.type === 'system' && event.subtype === 'init') {
          newSessionId = event.session_id;
        }

        if (event.type === 'assistant') {
          const content = event.message?.content || [];
          for (const block of content) {
            if (block.type === 'text') {
              // 누적 텍스트에서 새로 추가된 부분만 전송 (스트리밍 효과)
              if (block.text.length > lastText.length) {
                const delta = block.text.slice(lastText.length);
                send({ type: 'text', text: delta });
                lastText = block.text;
              }
            } else if (block.type === 'tool_use') {
              // MCP 툴 호출 시 로딩 표시
              const toolName = block.name.replace('mcp__dataverse__', '');
              send({ type: 'tool', name: toolName });
            }
          }
        }

        if (event.type === 'result') {
          if (newSessionId) {
            sessionMap.set(sessionId, newSessionId);
          }
          if (!finished) {
            finished = true;
            send({ type: 'done' });
          }
        }

      } catch {
        // JSON 파싱 불가 줄 무시 (경고 메시지 등)
      }
    }
  });

  claude.stderr.on('data', (data) => {
    const text = data.toString();
    // "Warning: no stdin" 같은 일반 경고는 무시
    if (!text.includes('Warning:') && !text.includes('warning:')) {
      console.error('[claude]', text.trim());
    }
  });

  claude.on('close', () => {
    if (!finished) {
      send({ type: 'done' });
    }
    if (!res.writableEnded) res.end();
  });

  claude.on('error', (err) => {
    send({ type: 'error', message: `Claude 실행 오류: ${err.message}` });
    if (!res.writableEnded) res.end();
  });

  // req.on('close')는 POST body 전송 후 half-close로 너무 일찍 발화 → res.on('close') 사용
  res.on('close', () => {
    if (!claude.killed) claude.kill();
  });
});

app.listen(PORT, () => {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Makino CRM Chat 서버 실행 중');
  console.log(`  http://localhost:${PORT}`);
  console.log('  Dataverse MCP 연결됨');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});
