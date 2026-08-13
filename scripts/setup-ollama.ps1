# Ollama 설치 확인 + 모델 다운로드 보조 스크립트 (Windows / PowerShell)
#
# 자동으로 Ollama를 설치하지 않습니다. 모델 다운로드도 -Pull을 명시했을 때만
# 수행합니다.
#
# 사용법:
#   powershell -ExecutionPolicy Bypass -File scripts\setup-ollama.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\setup-ollama.ps1 -Pull
#   powershell -ExecutionPolicy Bypass -File scripts\setup-ollama.ps1 -Pull -Model qwen3:8b

param(
    [switch]$Pull,
    [switch]$EnableIGPU,
    [string]$Model
)

$ErrorActionPreference = 'Stop'

try {
    if ((chcp) -notmatch '65001') { chcp 65001 | Out-Null }
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
} catch {}

$AppDir = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $AppDir '.env'

function Get-EnvValue([string]$Key, [string]$Default) {
    if (Test-Path -LiteralPath $EnvFile) {
        $line = Get-Content -LiteralPath $EnvFile | Where-Object { $_ -match "^\s*$Key=" } | Select-Object -First 1
        if ($line) {
            $value = ($line -split '=', 2)[1].Trim()
            if ($value) { return $value }
        }
    }
    return $Default
}

$TargetModel = if ($Model) { $Model } else { Get-EnvValue -Key 'LOCAL_LLM_MODEL' -Default 'qwen3:30b-a3b' }

Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host "  Ollama 설치 확인"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

$ollamaCmd = Get-Command ollama -ErrorAction SilentlyContinue
if (-not $ollamaCmd) {
    Write-Host "`n[미설치] Ollama가 PATH에 없습니다.`n"
    Write-Host "설치 방법:"
    Write-Host "  winget install Ollama.Ollama"
    Write-Host "  또는 https://ollama.com/download"
    Write-Host "`n설치 후 새 터미널에서 이 스크립트를 다시 실행하세요."
    exit 1
}

$version = (& ollama --version) 2>&1
Write-Host "`n[설치됨] $version"
Write-Host "서버 주소: http://localhost:11434"
Write-Host "자동 시작 방식은 설치 형태에 따라 다르므로 재부팅 후 별도로 확인하세요."

$igpu = [Environment]::GetEnvironmentVariable('OLLAMA_IGPU_ENABLE', 'User')
if ($EnableIGPU) {
    [Environment]::SetEnvironmentVariable('OLLAMA_IGPU_ENABLE', '1', 'User')
    Write-Host "OLLAMA_IGPU_ENABLE=1 을 사용자 환경변수로 적용했습니다. Ollama를 재시작하세요."
} elseif ($igpu -eq '1') {
    Write-Host "OLLAMA_IGPU_ENABLE=1 (사용자 환경변수)"
} else {
    Write-Host "iGPU 옵션을 적용하려면 -EnableIGPU를 명시하세요."
}

Write-Host "`n현재 받아둔 모델 목록:"
& ollama list

if (-not $Pull) {
    Write-Host "`n대상 모델 '$TargetModel'을 받으려면 -Pull을 붙여 다시 실행하세요:"
    Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\setup-ollama.ps1 -Pull"
    exit 0
}

Write-Host "`n모델 다운로드: $TargetModel"
& ollama pull $TargetModel
Write-Host "`n완료: ollama run $TargetModel"
