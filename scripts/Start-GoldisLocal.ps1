param(
  [string]$EnvFile = ".env.local",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$envPath = if ([System.IO.Path]::IsPathRooted($EnvFile)) { $EnvFile } else { Join-Path $repoRoot $EnvFile }
$nodeCommand = Get-Command node -ErrorAction Stop
$npmCommand = Get-Command npm -ErrorAction Stop
$oldEnvironment = @{}
$children = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$cancelRequested = $false
$cancelHandler = [ConsoleCancelEventHandler]{ param($sender, $eventArgs) $eventArgs.Cancel = $true; $script:cancelRequested = $true }

function Set-LocalValue([string]$Name, [string]$Value) {
  if (-not $script:oldEnvironment.ContainsKey($Name)) { $script:oldEnvironment[$Name] = [Environment]::GetEnvironmentVariable($Name, "Process") }
  [Environment]::SetEnvironmentVariable($Name, $Value, "Process")
}

function Invoke-LocalCommand([string]$FilePath, [string[]]$Arguments, [string]$Label, [string]$LogDirectory) {
  $stdout = Join-Path $LogDirectory "$Label.out.log"
  $stderr = Join-Path $LogDirectory "$Label.err.log"
  $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $repoRoot -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  if ($process.ExitCode -ne 0) { throw "$Label failed; sprawdź prywatne logi w katalogu Goldis logs." }
}

function Start-LocalService([string[]]$Arguments, [string]$Label, [string]$LogDirectory) {
  $stdout = Join-Path $LogDirectory "$Label.out.log"
  $stderr = Join-Path $LogDirectory "$Label.err.log"
  $process = Start-Process -FilePath $nodeCommand.Source -ArgumentList $Arguments -WorkingDirectory $repoRoot -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $children.Add($process)
  return $process
}

function Stop-OwnedServices {
  foreach ($process in $children) {
    try {
      $process.Refresh()
      if (-not $process.HasExited) {
        try { $process.Kill($true) }
        catch { & (Join-Path $env:SystemRoot "System32\taskkill.exe") /PID $process.Id /T /F | Out-Null }
        $process.WaitForExit(10000) | Out-Null
      }
    } catch { }
  }
  $children.Clear()
}

try {
  if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) { throw "Nie znaleziono pliku środowiska. Skopiuj .env.windows.example do .env.local i uzupełnij lokalne sekrety." }
  foreach ($line in Get-Content -LiteralPath $envPath) {
    if ($line -match '^\s*(?:#|$)') { continue }
    if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { throw "Nieprawidłowy wpis w pliku środowiska; popraw format KEY=VALUE." }
    $name = $Matches[1]
    $value = $Matches[2].Trim()
    if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    Set-LocalValue $name $value
  }

  if (-not $env:WORKER_LIVE_PORTALS) { Set-LocalValue "WORKER_LIVE_PORTALS" "0" }
  if ($env:WORKER_LIVE_PORTALS -notin @("0", "1")) { throw "WORKER_LIVE_PORTALS musi mieć wartość 0 albo 1." }
  if (-not $env:API_PORT) { Set-LocalValue "API_PORT" "3001" }
  if (-not $env:WORKER_INTERNAL_HOST) { Set-LocalValue "WORKER_INTERNAL_HOST" "127.0.0.1" }
  if (-not $env:WORKER_INTERNAL_PORT) { Set-LocalValue "WORKER_INTERNAL_PORT" "3022" }
  if (-not $env:WORKER_RESULT_API_URL) { Set-LocalValue "WORKER_RESULT_API_URL" "http://127.0.0.1:3001" }
  if (-not $env:WORKER_INTERNAL_URL) { Set-LocalValue "WORKER_INTERNAL_URL" "http://127.0.0.1:3022" }
  if (-not $env:API_INTERNAL_URL) { Set-LocalValue "API_INTERNAL_URL" "http://127.0.0.1:3001" }
  if (-not $env:WORKER_HEADLESS) { Set-LocalValue "WORKER_HEADLESS" "0" }

  $localData = Join-Path $env:LOCALAPPDATA "Goldis"
  $logDirectory = Join-Path $localData "logs"
  New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null

  [Console]::add_CancelKeyPress($cancelHandler)
  if (-not $SkipBuild) {
    Write-Host "Buduję aplikację…"
    & $npmCommand.Source run build
    if ($LASTEXITCODE -ne 0) { throw "Build nie powiódł się; usługi nie zostały uruchomione." }
  }
  Write-Host "Sprawdzam konfigurację i dostępność PostgreSQL/Redis…"
  Invoke-LocalCommand $nodeCommand.Source @("scripts/local-preflight.cjs") "preflight" $logDirectory
  foreach ($directory in @($env:WORKER_PROFILE_DIR, $env:WORKER_STAGING_DIR, $env:API_EXPORT_DIR)) {
    if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
  }
  Write-Host "Wykonuję migracje bazy przed startem API…"
  Invoke-LocalCommand $nodeCommand.Source @("apps/api/dist/migrate.js") "migrations" $logDirectory
  Invoke-LocalCommand $nodeCommand.Source @("scripts/local-preflight.cjs", "--post-migration") "post-migration-preflight" $logDirectory

  Write-Host "Uruchamiam API, panel i worker. Zatrzymanie tego okna zamknie wyłącznie te trzy procesy i ich procesy potomne."
  [void](Start-LocalService @("apps/api/dist/main.js") "api" $logDirectory)
  [void](Start-LocalService @("node_modules/next/dist/bin/next", "start", "-p", "3000") "web" $logDirectory)
  [void](Start-LocalService @("apps/worker/dist/run-worker.js") "worker" $logDirectory)
  Write-Host "Panel: http://127.0.0.1:3000  |  API: http://127.0.0.1:3001/api/health/ready"
  Write-Host "Portale: $(if ($env:WORKER_LIVE_PORTALS -eq '1') { 'live — wymagają osobno zaakceptowanej konfiguracji' } else { 'wyłączone' })"

  while (-not $cancelRequested) {
    Start-Sleep -Milliseconds 500
    $failed = @($children | Where-Object { $_.HasExited })
    if ($failed.Count -gt 0) { throw "Jedna z uruchomionych usług zakończyła pracę. Sprawdź prywatne logi w katalogu Goldis logs." }
  }
}
finally {
  Stop-OwnedServices
  try { [Console]::remove_CancelKeyPress($cancelHandler) } catch { }
  foreach ($name in @($oldEnvironment.Keys)) {
    [Environment]::SetEnvironmentVariable($name, $oldEnvironment[$name], "Process")
  }
}
