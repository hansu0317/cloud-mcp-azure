import path from 'path'

// Claude Code CLI 실행 파일 경로 (OS 별 분기)
export const CLAUDE_BIN = process.platform === 'win32'
  ? path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
  : 'claude'

// 허용할 읽기 전용 Dataverse MCP 도구 목록
export const DATAVERSE_READ_TOOLS = [
  'mcp__dataverse__read_query',
  'mcp__dataverse__search',
  'mcp__dataverse__search_data',
  'mcp__dataverse__describe',
  'mcp__dataverse__file_download',
].join(',')

export interface ClaudeSpawnOptions {
  resume?:       string  // Claude 세션 ID (대화 이어가기)
  allowedTools?: string  // 허용 MCP 도구 (기본값: DATAVERSE_READ_TOOLS)
}

// Claude CLI spawn 인수 빌더
export function buildClaudeArgs(prompt: string, opts: ClaudeSpawnOptions = {}): string[] {
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--allowedTools', opts.allowedTools ?? DATAVERSE_READ_TOOLS,
  ]
  if (opts.resume) args.push('--resume', opts.resume)
  return args
}
