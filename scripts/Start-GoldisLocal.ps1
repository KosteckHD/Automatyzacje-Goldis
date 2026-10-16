param(
  [string]$EnvFile = ".env.local",
  [switch]$SkipBuild,
  [switch]$SkipDataServices,
  [switch]$SkipPortalWorker
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

function Start-LocalService([string[]]$Arguments, [string]$Label, [string]$LogDirectory, [string]$WorkingDirectory) {
  $stdout = Join-Path $LogDirectory "$Label.out.log"
  $stderr = Join-Path $LogDirectory "$Label.err.log"
  if (-not $WorkingDirectory) { $WorkingDirectory = $repoRoot }
  $process = Start-Process -FilePath $nodeCommand.Source -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $children.Add($process)
  return $process
}

function Wait-LocalApiReady([System.Diagnostics.Process]$ApiProcess) {
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  while ([DateTime]::UtcNow -lt $deadline) {
    $ApiProcess.Refresh()
    if ($ApiProcess.HasExited) { throw "API nie uruchomiło się; sprawdź prywatny log api.err.log przed startem workera." }
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$env:API_PORT/api/health/ready" -TimeoutSec 2 -UseBasicParsing
      if ([int]$response.StatusCode -eq 200) { return }
    } catch { }
    Start-Sleep -Milliseconds 500
  }
  throw "API nie osiągnęło readiness w 60 sekund; worker i panel nie zostały uruchomione. Sprawdź prywatne logi API."
}

function Wait-LocalImportParserReady([System.Diagnostics.Process]$ParserProcess) {
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while ([DateTime]::UtcNow -lt $deadline) {
    $ParserProcess.Refresh()
    if ($ParserProcess.HasExited) { throw "Parser importu zakończył pracę; sprawdź prywatny log import-parser.err.log." }
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$env:IMPORT_PARSER_PORT/health/live" -TimeoutSec 2 -UseBasicParsing
      if ([int]$response.StatusCode -eq 200) { return }
    } catch { }
    Start-Sleep -Milliseconds 250
  }
  throw "Parser importu nie osiągnął gotowości w 15 sekund; API nie zostało uruchomione."
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
  if (-not $env:IMPORT_PARSER_URL) { Set-LocalValue "IMPORT_PARSER_URL" "http://127.0.0.1:3010" }
  if (-not $env:IMPORT_PARSER_HOST) { Set-LocalValue "IMPORT_PARSER_HOST" "127.0.0.1" }
  if (-not $env:IMPORT_PARSER_PORT) { Set-LocalValue "IMPORT_PARSER_PORT" "3010" }
  if (-not $env:IMPORT_PARSER_SHARED_SECRET -or $env:IMPORT_PARSER_SHARED_SECRET.Length -lt 32) { throw "Ustaw oddzielny IMPORT_PARSER_SHARED_SECRET o długości co najmniej 32 znaków." }
  if (-not $env:COMPOSE_PROJECT_NAME) { Set-LocalValue "COMPOSE_PROJECT_NAME" "goldis-local" }
  if ($env:COMPOSE_PROJECT_NAME -notmatch '^[a-z0-9][a-z0-9_-]{0,62}$') { throw "COMPOSE_PROJECT_NAME musi być nazwą lokalnego projektu Docker Compose." }
  if (-not $env:WORKER_HEADLESS) { Set-LocalValue "WORKER_HEADLESS" "0" }
  if (-not $env:GOLDIS_ENRICHMENT_PROVIDER) { Set-LocalValue "GOLDIS_ENRICHMENT_PROVIDER" "disabled" }
  if (-not $env:MF_VAT_ENVIRONMENT) { Set-LocalValue "MF_VAT_ENVIRONMENT" "production" }
  if ($env:GOLDIS_ENRICHMENT_PROVIDER -notin @("disabled", "mf-vat")) { throw "GOLDIS_ENRICHMENT_PROVIDER musi mieć wartość disabled albo mf-vat." }
  if ($env:MF_VAT_ENVIRONMENT -notin @("production", "test")) { throw "MF_VAT_ENVIRONMENT musi mieć wartość production albo test." }
  if ($env:GOLDIS_ENRICHMENT_PROVIDER -in @("mf-vat", "gus-bir") -and ($env:REGISTRY_CACHE_HMAC_KEY -notmatch '^[a-fA-F0-9]{64,128}$' -or $env:REGISTRY_CACHE_HMAC_KEY.Length % 2 -ne 0)) {
    throw "Dla aktywnego dostawcy rejestru ustaw REGISTRY_CACHE_HMAC_KEY jako losowy klucz 32–64 bajty w zapisie hex."
  }

  $localData = Join-Path $env:LOCALAPPDATA "Goldis"
  $logDirectory = Join-Path $localData "logs"
  New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
  & (Join-Path $PSScriptRoot "Write-GoldisComposeSecrets.ps1") -EnvFile $envPath

  if (-not $SkipDataServices) {
    $dockerCommand = Get-Command docker -ErrorAction Stop
    Write-Host "Uruchamiam lokalny PostgreSQL i Redis przez Docker Compose…"
    & $dockerCommand.Source compose -p $env:COMPOSE_PROJECT_NAME --env-file $envPath -f (Join-Path $repoRoot "compose.yaml") -f (Join-Path $repoRoot "compose.local-browser.yaml") up -d postgres redis
    if ($LASTEXITCODE -ne 0) { throw "Nie udało się uruchomić lokalnego PostgreSQL/Redis. Usługi aplikacji nie zostały uruchomione." }
    & $dockerCommand.Source compose -p $env:COMPOSE_PROJECT_NAME --env-file $envPath -f (Join-Path $repoRoot "compose.yaml") -f (Join-Path $repoRoot "compose.local-browser.yaml") run --rm --no-deps db-roles
    if ($LASTEXITCODE -ne 0) { throw "Nie udało się przygotować odrębnych kont PostgreSQL. API i workery nie zostały uruchomione." }
  }

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
  $apiDatabaseUrl = $env:DATABASE_URL
  if (-not $env:MIGRATOR_DATABASE_URL) { throw "Brak MIGRATOR_DATABASE_URL dla odrębnego konta migracji." }
  Set-LocalValue "DATABASE_URL" $env:MIGRATOR_DATABASE_URL
  Invoke-LocalCommand $nodeCommand.Source @("apps/api/dist/infrastructure/database/migrate.js") "migrations" $logDirectory
  Invoke-LocalCommand $nodeCommand.Source @("apps/api/dist/infrastructure/database/apply-runtime-grants.js") "runtime-grants" $logDirectory
  Set-LocalValue "DATABASE_URL" $apiDatabaseUrl
  Invoke-LocalCommand $nodeCommand.Source @("scripts/local-preflight.cjs", "--post-migration") "post-migration-preflight" $logDirectory
  Set-LocalValue "DATABASE_URL" $env:MIGRATOR_DATABASE_URL
  Invoke-LocalCommand $nodeCommand.Source @("apps/api/dist/processes/bootstrap-admin/composition/main.js") "bootstrap-admin" $logDirectory
  Set-LocalValue "DATABASE_URL" $apiDatabaseUrl
  Set-LocalValue "GOLDIS_ADMIN_USER" ""
  Set-LocalValue "GOLDIS_ADMIN_PASSWORD" ""

  Write-Host "Uruchamiam API, panel i workery. Zatrzymanie tego okna zamknie wyłącznie uruchomione procesy i ich procesy potomne."
  $parserProcess = Start-LocalService @("apps/api/dist/import-parser-main.js") "import-parser" $logDirectory
  Wait-LocalImportParserReady $parserProcess
  $apiProcess = Start-LocalService @("apps/api/dist/composition/main.js") "api" $logDirectory
  Wait-LocalApiReady $apiProcess
  [void](Start-LocalService @((Join-Path $repoRoot "node_modules/next/dist/bin/next"), "start", "-p", "3000") "web" $logDirectory (Join-Path $repoRoot "apps/web"))
  if (-not $SkipPortalWorker) {
    if (-not $env:WORKER_DATABASE_URL) { throw "Brak WORKER_DATABASE_URL dla odrębnego konta workera." }
    if (-not $env:WORKER_REDIS_URL) { throw "Brak WORKER_REDIS_URL dla odrębnego konta Redis workera." }
    $apiRedisUrl = $env:REDIS_URL
    Set-LocalValue "DATABASE_URL" $env:WORKER_DATABASE_URL
    Set-LocalValue "REDIS_URL" $env:WORKER_REDIS_URL
    [void](Start-LocalService @("apps/worker/dist/run-worker.js") "worker" $logDirectory)
    Set-LocalValue "DATABASE_URL" $apiDatabaseUrl
    Set-LocalValue "REDIS_URL" $apiRedisUrl
  }
  if (-not $env:ENRICHMENT_DATABASE_URL) { throw "Brak ENRICHMENT_DATABASE_URL dla odrębnego konta wzbogacania." }
  Set-LocalValue "DATABASE_URL" $env:ENRICHMENT_DATABASE_URL
  [void](Start-LocalService @("apps/api/dist/enrichment-worker.js") "enrichment-worker" $logDirectory)
  Set-LocalValue "DATABASE_URL" $apiDatabaseUrl
  Write-Host "Panel: http://127.0.0.1:3000  |  API: http://127.0.0.1:3001/api/health/ready"
  Write-Host "Portale: $(if ($env:WORKER_LIVE_PORTALS -eq '1') { 'live — wymagają osobno zaakceptowanej konfiguracji' } else { 'wyłączone' })"
  if ($SkipPortalWorker) { Write-Host "Worker portalowy pominięty: profil pozostaje dla nadzorowanej kontroli selektorów." }
  Write-Host "Wzbogacanie NIP → REGON: $env:GOLDIS_ENRICHMENT_PROVIDER (sprawdź /api/health/enrichment)"

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
