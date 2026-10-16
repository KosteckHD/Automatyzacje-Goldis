param([string]$EnvFile = ".env.local")

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$envPath = if ([System.IO.Path]::IsPathRooted($EnvFile)) { [System.IO.Path]::GetFullPath($EnvFile) } else { [System.IO.Path]::GetFullPath((Join-Path $repoRoot $EnvFile)) }
$oldEnvironment = @{}

function Set-ProcessValue([string]$Name, [string]$Value) {
  if (-not $script:oldEnvironment.ContainsKey($Name)) { $script:oldEnvironment[$Name] = [Environment]::GetEnvironmentVariable($Name, "Process") }
  [Environment]::SetEnvironmentVariable($Name, $Value, "Process")
}

try {
  if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) { throw "RESTORE_ENV_FILE_NOT_FOUND" }
  foreach ($line in Get-Content -LiteralPath $envPath) {
    if ($line -match '^\s*(?:#|$)') { continue }
    if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { throw "RESTORE_ENV_FORMAT_INVALID" }
    $name = $Matches[1]
    $value = $Matches[2].Trim()
    if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    Set-ProcessValue $name $value
  }
  if (-not $env:COMPOSE_PROJECT_NAME) { Set-ProcessValue "COMPOSE_PROJECT_NAME" "goldis-local" }
  if ($env:COMPOSE_PROJECT_NAME -ne "goldis-local") { throw "RESTORE_LOCAL_COMPOSE_PROJECT_REQUIRED" }
  $apiPort = if ($env:API_PORT -match '^\d{1,5}$') { [int]$env:API_PORT } else { 3001 }
  $workerPort = if ($env:WORKER_INTERNAL_PORT -match '^\d{1,5}$') { [int]$env:WORKER_INTERNAL_PORT } else { 3022 }
  foreach ($port in @($apiPort, 3000, $workerPort) | Select-Object -Unique) {
    if (@(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue).Count -gt 0) {
      throw "RESTORE_STOP_API_WEB_AND_WORKERS_FIRST"
    }
  }
  $activeGoldisWorkers = @(Get-CimInstance Win32_Process | Where-Object {
    $commandLine = ([string]$_.CommandLine).Replace('\', '/')
    $commandLine -match 'apps/(worker/dist/run-worker|api/dist/enrichment-worker|api/dist/main)\.js'
  })
  if ($activeGoldisWorkers.Count -gt 0) { throw "RESTORE_STOP_API_WEB_AND_WORKERS_FIRST" }

  $docker = (Get-Command docker -ErrorAction Stop).Source
  $npm = (Get-Command npm -ErrorAction Stop).Source
  $node = (Get-Command node -ErrorAction Stop).Source
  $composeFiles = @("-p", $env:COMPOSE_PROJECT_NAME, "--env-file", $envPath,
    "-f", (Join-Path $repoRoot "compose.yaml"), "-f", (Join-Path $repoRoot "compose.local-browser.yaml"))
  & $docker compose @composeFiles up -d postgres
  if ($LASTEXITCODE -ne 0) { throw "RESTORE_POSTGRES_START_FAILED" }
  & $npm run build -w @goldis/api
  if ($LASTEXITCODE -ne 0) { throw "RESTORE_API_BUILD_FAILED" }
  & $node (Join-Path $repoRoot "apps/api/dist/infrastructure/database/migrate.js")
  if ($LASTEXITCODE -ne 0) { throw "RESTORE_DATABASE_MIGRATION_FAILED" }
  Set-ProcessValue "GOLDIS_RESTORE_MAINTENANCE" "1"
  & $node (Join-Path $repoRoot "apps/api/scripts/apply-deletion-journal.cjs")
  if ($LASTEXITCODE -ne 0) { throw "RESTORE_JOURNAL_REPLAY_FAILED" }
  Write-Host "Journal został zastosowany. Aplikacja nie została uruchomiona; wykonaj kontrolowany start dopiero po sprawdzeniu danych."
} finally {
  foreach ($name in @($oldEnvironment.Keys)) {
    [Environment]::SetEnvironmentVariable($name, $oldEnvironment[$name], "Process")
  }
}
