const fs = require('fs')
const path = require('path')

const appDir = path.resolve(__dirname, '..')
const envFile = path.join(appDir, '.env')
const fileEnv = {}
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    fileEnv[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2').replace(/\s+#.*$/, '')
  }
}

const provider = (process.env.LLM_PROVIDER || fileEnv.LLM_PROVIDER || 'anthropic').toLowerCase()
if (!['anthropic', 'ollama'].includes(provider)) throw new Error('LLM_PROVIDER must be anthropic or ollama.')
const profile = provider === 'anthropic' ? 'cloud' : 'local'
const python = process.platform === 'win32'
  ? path.join(appDir, '.venv', 'Scripts', 'python.exe')
  : path.join(appDir, '.venv', 'bin', 'python')
const pythonBin = fs.existsSync(python) ? python : (process.platform === 'win32' ? 'python' : 'python3')
const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null'

module.exports = { apps: [{
  name: `crm-ai-chat-${profile}`,
  cwd: appDir,
  script: pythonBin,
  interpreter: 'none',
  args: '-m backend.main',
  instances: 1,
  autorestart: true,
  watch: false,
  max_memory_restart: '500M',
  env: { LLM_PROVIDER: provider },
  env_production: { LLM_PROVIDER: provider },
  // 앱 자체 JSONL logger만 server.<profile>.log에 기록한다. PM2 console 파일은 만들지 않는다.
  error_file: nullDevice,
  out_file: nullDevice,
  merge_logs: true,
  log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
}] }
