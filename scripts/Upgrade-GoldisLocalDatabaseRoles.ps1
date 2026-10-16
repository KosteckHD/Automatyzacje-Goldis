param([string]$EnvFile = ".env.local")

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$envPath = if ([System.IO.Path]::IsPathRooted($EnvFile)) { [System.IO.Path]::GetFullPath($EnvFile) } else { [System.IO.Path]::GetFullPath((Join-Path $repoRoot $EnvFile)) }

function New-RolePassword {
  $bytes = New-Object byte[] 32
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  return [BitConverter]::ToString($bytes).Replace("-", "").ToLowerInvariant()
}

function Protect-LocalFile([string]$Path) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $identityAce = "{0}:(F)" -f $identity
  $icacls = Join-Path $env:SystemRoot "System32\icacls.exe"
  & $icacls $Path /inheritance:r /grant:r $identityAce "*S-1-5-18:(F)" "*S-1-5-32-544:(F)" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "LOCAL_ENV_ACL_FAILED" }
}

if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) { throw "LOCAL_ENV_NOT_FOUND" }
$values = @{}
$lines = [System.Collections.Generic.List[string]]::new()
foreach ($line in Get-Content -LiteralPath $envPath) {
  $lines.Add($line)
  if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { $values[$Matches[1]] = $Matches[2].Trim() }
}
if (-not $values.DB_PASSWORD -or -not $values.DATABASE_URL) { throw "LOCAL_DATABASE_SETTINGS_MISSING" }

try { $databaseUri = [Uri]$values.DATABASE_URL } catch { throw "LOCAL_DATABASE_URL_INVALID" }
if ($databaseUri.Scheme -notin @("postgres", "postgresql") -or $databaseUri.Host -notin @("127.0.0.1", "localhost", "::1")) {
  throw "LOCAL_DATABASE_URL_MUST_USE_LOOPBACK"
}

$authorityHost = if ($databaseUri.Host.Contains(":")) { "[$($databaseUri.Host)]" } else { $databaseUri.Host }
$authorityPort = if ($databaseUri.IsDefaultPort) { "" } else { ":$($databaseUri.Port)" }
$databaseTarget = "$authorityHost$authorityPort$($databaseUri.AbsolutePath)$($databaseUri.Query)"
$rolePasswords = @{}
foreach ($role in @("MIGRATOR", "API", "WORKER", "ENRICHMENT")) {
  $key = "${role}_DB_PASSWORD"
  $configured = $values[$key]
  $rolePasswords[$role] = if ($configured -match '^[a-fA-F0-9]{64}$') { $configured } else { New-RolePassword }
}
$updates = [ordered]@{
  MIGRATOR_DB_PASSWORD = $rolePasswords.MIGRATOR
  API_DB_PASSWORD = $rolePasswords.API
  WORKER_DB_PASSWORD = $rolePasswords.WORKER
  ENRICHMENT_DB_PASSWORD = $rolePasswords.ENRICHMENT
  DATABASE_URL = "postgres://goldis_api:$($rolePasswords.API)@$databaseTarget"
  MIGRATOR_DATABASE_URL = "postgres://goldis_migrator:$($rolePasswords.MIGRATOR)@$databaseTarget"
  WORKER_DATABASE_URL = "postgres://goldis_worker:$($rolePasswords.WORKER)@$databaseTarget"
  ENRICHMENT_DATABASE_URL = "postgres://goldis_enrichment:$($rolePasswords.ENRICHMENT)@$databaseTarget"
}
$written = @{}
$nextLines = foreach ($line in $lines) {
  if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=.*$' -and $updates.Contains($Matches[1])) {
    $name = $Matches[1]
    $written[$name] = $true
    "{0}={1}" -f $name, $updates[$name]
  } else { $line }
}
foreach ($name in $updates.Keys) {
  if (-not $written.ContainsKey($name)) { $nextLines += "{0}={1}" -f $name, $updates[$name] }
}

$temporaryPath = Join-Path (Split-Path -Parent $envPath) (".goldis-db-roles-{0}.tmp" -f [Guid]::NewGuid().ToString("N"))
try {
  [System.IO.File]::WriteAllText($temporaryPath, (($nextLines -join "`r`n") + "`r`n"), [Text.UTF8Encoding]::new($false))
  Protect-LocalFile $temporaryPath
  Move-Item -LiteralPath $temporaryPath -Destination $envPath -Force
  Protect-LocalFile $envPath
} finally {
  if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) { Remove-Item -LiteralPath $temporaryPath -Force }
}

Write-Host "Local database role credentials are ready in $envPath. Existing database contents were not changed."
Write-Host "The next local start provisions the four isolated roles and applies the explicit permission matrix after migrations."
