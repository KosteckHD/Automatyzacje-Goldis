param([Parameter(Mandatory = $true)][string]$EnvFile)

$ErrorActionPreference = "Stop"
$envPath = [System.IO.Path]::GetFullPath($EnvFile)
if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) { throw "LOCAL_ENV_NOT_FOUND" }
$values = @{}
foreach ($line in Get-Content -LiteralPath $envPath) {
  if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { $values[$Matches[1]] = $Matches[2].Trim() }
}
$secretsPath = $values.GOLDIS_SECRETS_DIR
if (-not $secretsPath) { throw "GOLDIS_SECRETS_DIR_REQUIRED" }
$secretsPath = [System.IO.Path]::GetFullPath($secretsPath)
New-Item -ItemType Directory -Force -Path $secretsPath | Out-Null

function Protect-LocalPath([string]$Path) {
  $identityAce = "{0}:(F)" -f [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $icacls = Join-Path $env:SystemRoot "System32\icacls.exe"
  & $icacls $Path /inheritance:r /grant:r $identityAce "*S-1-5-18:(F)" "*S-1-5-32-544:(F)" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "LOCAL_SECRET_ACL_FAILED" }
}

function Get-ContainerDatabaseUrl([string]$Name) {
  if (-not $values[$Name]) { throw "${Name}_REQUIRED" }
  $url = [Uri]$values[$Name]
  $username = [Uri]::UnescapeDataString($url.UserInfo.Split(":", 2)[0])
  $password = [Uri]::UnescapeDataString($url.UserInfo.Split(":", 2)[1])
  return "postgres://${username}:${password}@postgres:5432$($url.AbsolutePath)"
}

$authMailKeyring = $values.AUTH_MAIL_ENCRYPTION_KEYS_BASE64
if (-not $authMailKeyring) {
  $existingAuthMailKeyring = Join-Path $secretsPath "auth_mail_keyring"
  if (Test-Path -LiteralPath $existingAuthMailKeyring -PathType Leaf) {
    $authMailKeyring = [System.IO.File]::ReadAllText($existingAuthMailKeyring).Trim()
  } else {
    $keyBytes = [byte[]]::new(32)
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($keyBytes) } finally { $rng.Dispose() }
    $json = '{"1":"' + [Convert]::ToBase64String($keyBytes) + '"}'
    $authMailKeyring = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    [Array]::Clear($keyBytes, 0, $keyBytes.Length)
  }
}

$contents = [ordered]@{
  database_password = $values.DB_PASSWORD
  migrator_db_password = $values.MIGRATOR_DB_PASSWORD
  api_db_password = $values.API_DB_PASSWORD
  worker_db_password = $values.WORKER_DB_PASSWORD
  enrichment_db_password = $values.ENRICHMENT_DB_PASSWORD
  redis_api_password = $values.REDIS_API_PASSWORD
  redis_worker_password = $values.REDIS_WORKER_PASSWORD
  database_url_migrator = Get-ContainerDatabaseUrl "MIGRATOR_DATABASE_URL"
  database_url_api = Get-ContainerDatabaseUrl "DATABASE_URL"
  database_url_worker = Get-ContainerDatabaseUrl "WORKER_DATABASE_URL"
  database_url_enrichment = Get-ContainerDatabaseUrl "ENRICHMENT_DATABASE_URL"
  redis_url_api = "redis://goldis_api:$($values.REDIS_API_PASSWORD)@redis:6379/0"
  redis_url_worker = "redis://goldis_worker:$($values.REDIS_WORKER_PASSWORD)@redis:6379/0"
  session_secret = $values.SESSION_SECRET
  login_rate_limit_secret = $values.LOGIN_RATE_LIMIT_SECRET
  privileged_action_binding_key = $values.PRIVILEGED_ACTION_BINDING_KEY
  admin_user = $values.GOLDIS_ADMIN_USER
  admin_password = $values.GOLDIS_ADMIN_PASSWORD
  pesel_keyring = $values.PESEL_ENCRYPTION_KEYS_BASE64
  artifact_keyring = $values.ARTIFACT_ENCRYPTION_KEYS_BASE64
  worker_auth_secret = $values.WORKER_AUTH_SECRET
  import_parser_secret = $values.IMPORT_PARSER_SHARED_SECRET
  registry_cache_key = $values.REGISTRY_CACHE_HMAC_KEY
  pzu_login = $values.PZU_LOGIN
  pzu_password = $values.PZU_PASSWORD
  compensa_login = $values.COMPENSA_LOGIN
  compensa_password = $values.COMPENSA_PASSWORD
  worker_staging_key = $values.WORKER_STAGING_KEY_V1
  resend_api_key = $values.RESEND_API_KEY
  auth_mail_keyring = $authMailKeyring
}

foreach ($entry in $contents.GetEnumerator()) {
  if ($null -eq $entry.Value) { $entry.Value = "" }
  $target = Join-Path $secretsPath $entry.Key
  [System.IO.File]::WriteAllText($target, [string]$entry.Value, [Text.UTF8Encoding]::new($false))
  Protect-LocalPath $target
}
Protect-LocalPath $secretsPath
Write-Host "Compose secret files are ready in the ACL-protected Goldis directory."
