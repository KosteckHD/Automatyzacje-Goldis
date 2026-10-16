param([string]$EnvFile = ".env.local")

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$envPath = if ([System.IO.Path]::IsPathRooted($EnvFile)) { [System.IO.Path]::GetFullPath($EnvFile) } else { [System.IO.Path]::GetFullPath((Join-Path $repoRoot $EnvFile)) }

function New-RandomBytes([int]$Length) {
  $bytes = New-Object byte[] $Length
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  return ,$bytes
}

function New-RandomHex([int]$Length = 32) {
  return [BitConverter]::ToString((New-RandomBytes $Length)).Replace("-", "").ToLowerInvariant()
}

function New-RandomBase64([int]$Length = 32) {
  return [Convert]::ToBase64String((New-RandomBytes $Length))
}

function New-RandomBase64Url([int]$Length = 32) {
  return (New-RandomBase64 $Length).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Get-FreeLoopbackPort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    return [int]$listener.LocalEndpoint.Port
  } finally { $listener.Stop() }
}

function Protect-LocalFile([string]$Path) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $identityAce = "{0}:(F)" -f $identity
  $icacls = Join-Path $env:SystemRoot "System32\icacls.exe"
  & $icacls $Path /inheritance:r /grant:r $identityAce "*S-1-5-18:(F)" "*S-1-5-32-544:(F)" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "LOCAL_ENV_ACL_FAILED" }
}

if (Test-Path -LiteralPath $envPath) { throw "LOCAL_ENV_ALREADY_EXISTS; nie nadpisuję istniejącego pliku konfiguracji." }
$parent = Split-Path -Parent $envPath
New-Item -ItemType Directory -Force -Path $parent | Out-Null

$peselKey = New-RandomBase64
$keyringJson = ([ordered]@{ "1" = $peselKey } | ConvertTo-Json -Compress)
$keyringBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($keyringJson))
$artifactKey = New-RandomBase64
$artifactKeyringJson = ([ordered]@{ "1" = $artifactKey } | ConvertTo-Json -Compress)
$artifactKeyringBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($artifactKeyringJson))
$dbPassword = New-RandomHex
$migratorDbPassword = New-RandomHex
$apiDbPassword = New-RandomHex
$workerDbPassword = New-RandomHex
$enrichmentDbPassword = New-RandomHex
$adminPassword = New-RandomHex
$sessionSecret = New-RandomHex
$loginLimitSecret = New-RandomHex
$privilegedActionBindingKey = New-RandomHex
$workerAuthSecret = New-RandomHex
$redisApiPassword = New-RandomHex
$redisWorkerPassword = New-RandomHex
$importParserSecret = New-RandomHex
$stagingKey = New-RandomBase64Url
$registryCacheKey = New-RandomHex
$postgresPort = Get-FreeLoopbackPort
$redisPort = Get-FreeLoopbackPort
while ($redisPort -eq $postgresPort) { $redisPort = Get-FreeLoopbackPort }
$localData = Join-Path $env:LOCALAPPDATA "Goldis"
$profileDir = Join-Path $localData "playwright-profile"
$stagingDir = Join-Path $localData "staging"
$exportDir = Join-Path $localData "exports"
$secretDir = Join-Path $localData "secrets"
$portalConfig = Join-Path $repoRoot "config\portal-selectors.example.json"

$settings = [ordered]@{
  COMPOSE_PROJECT_NAME = "goldis-local"
  GOLDIS_SECRETS_DIR = $secretDir.Replace("\", "/")
  DATABASE_URL = "postgres://goldis_api:$apiDbPassword@127.0.0.1:$postgresPort/goldis"
  MIGRATOR_DATABASE_URL = "postgres://goldis_migrator:$migratorDbPassword@127.0.0.1:$postgresPort/goldis"
  WORKER_DATABASE_URL = "postgres://goldis_worker:$workerDbPassword@127.0.0.1:$postgresPort/goldis"
  ENRICHMENT_DATABASE_URL = "postgres://goldis_enrichment:$enrichmentDbPassword@127.0.0.1:$postgresPort/goldis"
  DB_PASSWORD = $dbPassword
  MIGRATOR_DB_PASSWORD = $migratorDbPassword
  API_DB_PASSWORD = $apiDbPassword
  WORKER_DB_PASSWORD = $workerDbPassword
  ENRICHMENT_DB_PASSWORD = $enrichmentDbPassword
  GOLDIS_POSTGRES_HOST_PORT = "$postgresPort"
  GOLDIS_REDIS_HOST_PORT = "$redisPort"
  REDIS_URL = "redis://goldis_api:$redisApiPassword@127.0.0.1:$redisPort/0"
  WORKER_REDIS_URL = "redis://goldis_worker:$redisWorkerPassword@127.0.0.1:$redisPort/0"
  REDIS_API_PASSWORD = $redisApiPassword
  REDIS_WORKER_PASSWORD = $redisWorkerPassword
  API_PORT = "3001"
  API_INTERNAL_URL = "http://127.0.0.1:3001"
  WORKER_INTERNAL_URL = "http://127.0.0.1:3022"
  WORKER_RESULT_API_URL = "http://127.0.0.1:3001"
  PUBLIC_APP_ORIGIN = "http://127.0.0.1:3000"
  TRUST_PROXY_IPS = ""
  LOGIN_RATE_LIMIT_SECRET = $loginLimitSecret
  PRIVILEGED_ACTION_BINDING_KEY = $privilegedActionBindingKey
  SESSION_SECRET = $sessionSecret
  GOLDIS_ADMIN_USER = "admin-local"
  GOLDIS_ADMIN_PASSWORD = $adminPassword
  PESEL_ENCRYPTION_ACTIVE_KEY_VERSION = "1"
  PESEL_ENCRYPTION_KEYS_BASE64 = $keyringBase64
  ARTIFACT_ENCRYPTION_ACTIVE_KEY_VERSION = "1"
  ARTIFACT_ENCRYPTION_KEYS_BASE64 = $artifactKeyringBase64
  WORKER_AUTH_SECRET = $workerAuthSecret
  IMPORT_PARSER_URL = "http://127.0.0.1:3010"
  IMPORT_PARSER_HOST = "127.0.0.1"
  IMPORT_PARSER_PORT = "3010"
  IMPORT_PARSER_SHARED_SECRET = $importParserSecret
  WORKER_INTERNAL_HOST = "127.0.0.1"
  WORKER_INTERNAL_PORT = "3022"
  WORKER_HEADLESS = "0"
  WORKER_CHROMIUM_SANDBOX = "0"
  WORKER_BROWSER_CHANNEL = ""
  WORKER_PROFILE_DIR = $profileDir
  WORKER_STAGING_DIR = $stagingDir
  WORKER_STAGING_KEY_VERSION = "1"
  WORKER_STAGING_KEY_V1 = $stagingKey
  API_EXPORT_DIR = $exportDir
  WORKER_PORTAL_CONFIG_PATH = $portalConfig
  WORKER_LIVE_PORTALS = "0"
  WORKER_DB_POOL_MAX = "8"
  WORKER_PORTAL_MIN_ACTION_INTERVAL_MS = "1000"
  GOLDIS_ENRICHMENT_PROVIDER = "mf-vat"
  MF_VAT_ENVIRONMENT = "production"
  MF_VAT_MIN_REQUEST_INTERVAL_MS = "1000"
  REGISTRY_CACHE_HMAC_KEY = $registryCacheKey
  PZU_LOGIN = ""
  PZU_PASSWORD = ""
  COMPENSA_LOGIN = ""
  COMPENSA_PASSWORD = ""
}

$content = (($settings.GetEnumerator() | ForEach-Object { "{0}={1}" -f $_.Key, $_.Value }) -join "`r`n") + "`r`n"
$created = $false
try {
  [System.IO.File]::WriteAllText($envPath, $content, [Text.UTF8Encoding]::new($false))
  $created = $true
  Protect-LocalFile $envPath
  & (Join-Path $PSScriptRoot "Write-GoldisComposeSecrets.ps1") -EnvFile $envPath
  if ($LASTEXITCODE -ne 0) { throw "LOCAL_SECRET_FILES_FAILED" }
} catch {
  if ($created -and (Test-Path -LiteralPath $envPath -PathType Leaf)) { Remove-Item -LiteralPath $envPath -Force }
  throw
}

Write-Host "Created local configuration: $envPath"
Write-Host "The initial admin password is stored only in this file; the first login requires changing it."
Write-Host "Portal automation and registry providers remain disabled. Local start launches PostgreSQL and Redis."
