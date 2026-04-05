param(
  [switch]$Json
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$reportRoot = Join-Path $projectRoot "security-reports"
$tempRoot = Join-Path $reportRoot "tmp"
$configPath = Join-Path $projectRoot "backend\semgrep\javascript-product-audit.yml"

New-Item -ItemType Directory -Force -Path $reportRoot | Out-Null
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

$env:TEMP = $tempRoot
$env:TMP = $tempRoot
$env:XDG_CONFIG_HOME = $reportRoot
$env:SEMGREP_LOG_FILE = Join-Path $reportRoot "semgrep.log"
$env:SEMGREP_SETTINGS_FILE = Join-Path $reportRoot "semgrep-settings.yml"
$env:SEMGREP_SEND_METRICS = "off"

$args = @(
  "scan",
  "--metrics=off",
  "--config", $configPath,
  "backend",
  "frontend",
  "vscode-extension",
  "firefox-extension"
)

if ($Json) {
  $args = @("scan", "--json", "--metrics=off", "--config", $configPath, "backend", "frontend", "vscode-extension", "firefox-extension")
}

& pysemgrep @args
