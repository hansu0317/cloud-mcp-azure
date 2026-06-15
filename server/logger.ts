import fs                  from 'fs'
import path                from 'path'
import { createStream }    from 'rotating-file-stream'

const LOGS_DIR  = path.join(process.cwd(), 'logs')
const MAX_FILES = parseInt(process.env.LOG_MAX_FILES ?? '30')

if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true })

const appStream = createStream('app.log', {
  interval: '1d',
  path:     LOGS_DIR,
  maxFiles: MAX_FILES,
  size:     '50M',
  compress: 'gzip',
})

function localISO(): string {
  const now = new Date()
  const off = now.getTimezoneOffset()
  const sign = off <= 0 ? '+' : '-'
  const abs  = Math.abs(off)
  return new Date(now.getTime() - off * 60000).toISOString().slice(0, -1)
    + `${sign}${String(Math.floor(abs / 60)).padStart(2,'0')}:${String(abs % 60).padStart(2,'0')}`
}

function write(level: 'INFO' | 'ERROR', category: string, message: string, data?: unknown): void {
  const entry: Record<string, unknown> = { time: localISO(), level, category, message }
  if (data !== undefined) entry.data = data
  appStream.write(JSON.stringify(entry) + '\n')

  const color = level === 'ERROR' ? '\x1b[31m' : '\x1b[36m'
  const reset = '\x1b[0m'
  const dataStr = data !== undefined ? ' ' + JSON.stringify(data) : ''
  console.log(`${color}[${level}]${reset} [${category}] ${message}${dataStr}`)
}

export default {
  info:  (cat: string, msg: string, data?: unknown) => write('INFO',  cat, msg, data),
  error: (cat: string, msg: string, data?: unknown) => write('ERROR', cat, msg, data),
}
