param(
  [string]$EnvFile = ".env.local",
  [string]$DestinationDirectory = (Join-Path $env:LOCALAPPDATA "Goldis\backups")
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$envPath = if ([IO.Path]::IsPathRooted($EnvFile)) { [IO.Path]::GetFullPath($EnvFile) } else { [IO.Path]::GetFullPath((Join-Path $repoRoot $EnvFile)) }
$destinationRoot = [IO.Path]::GetFullPath($DestinationDirectory)
$docker = (Get-Command docker -ErrorAction Stop).Source
$node = (Get-Command node -ErrorAction Stop).Source
$cryptoScript = Join-Path $PSScriptRoot "goldis-backup-crypto.cjs"
$runId = [Guid]::NewGuid().ToString("N")
$workRoot = Join-Path $destinationRoot ".work-$runId"
$payloadRoot = Join-Path $workRoot "payload"
$zipPath = Join-Path $workRoot "goldis-local.zip"
$createdUtc = [DateTime]::UtcNow.ToString("o")
$passphrase = $null

function Protect-PrivateDirectory([string]$Path) {
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $icacls = Join-Path $env:SystemRoot "System32\icacls.exe"
  & $icacls $Path /inheritance:r /grant:r "${identity}:(OI)(CI)(F)" "*S-1-5-18:(OI)(CI)(F)" "*S-1-5-32-544:(OI)(CI)(F)" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "BACKUP_ACL_FAILED" }
}

function Read-LocalEnvironment([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "BACKUP_ENV_FILE_NOT_FOUND" }
  $values = @{}
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match '^\s*(?:#|$)') { continue }
    if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { throw "BACKUP_ENV_FORMAT_INVALID" }
    $value = $Matches[2].Trim()
    if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $values[$Matches[1]] = $value
  }
  return $values
}

function Resolve-LocalDirectory([string]$Value, [string]$Fallback) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return [IO.Path]::GetFullPath($Fallback) }
  return [IO.Path]::GetFullPath($Value)
}

function Assert-NoReparsePoints([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $items = @(Get-Item -LiteralPath $Path -Force) + @(Get-ChildItem -LiteralPath $Path -Force -Recurse -ErrorAction Stop)
  foreach ($item in $items) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "BACKUP_SOURCE_REPARSE_POINT_UNSUPPORTED" }
  }
}

function Copy-LocalDirectory([string]$Source, [string]$Target) {
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  if (-not (Test-Path -LiteralPath $Source -PathType Container)) { return }
  Assert-NoReparsePoints $Source
  Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $Target -Recurse -Force
  }
}

function Invoke-Compose([string[]]$Arguments) {
  $result = & $docker compose @Arguments 2>$null
  if ($LASTEXITCODE -ne 0) { throw "BACKUP_COMPOSE_QUERY_FAILED" }
  return ($result | Out-String).Trim()
}

function Save-ContainerDump([string]$ContainerId, [string]$Path) {
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $docker
  $start.Arguments = "exec $ContainerId pg_dump -U goldis -d goldis --format=custom --no-owner"
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  if (-not $process.Start()) { throw "BACKUP_PG_DUMP_START_FAILED" }
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $process.StandardOutput.BaseStream.CopyTo($stream)
    $stream.Flush($true)
  } finally { $stream.Dispose() }
  $process.WaitForExit()
  $null = $stderrTask.GetAwaiter().GetResult()
  if ($process.ExitCode -ne 0 -or (Get-Item -LiteralPath $Path).Length -lt 64) { throw "BACKUP_PG_DUMP_FAILED" }
}

function Get-ManifestFiles([string]$Root) {
  $files = @(Get-ChildItem -LiteralPath $Root -File -Force -Recurse | Sort-Object FullName | ForEach-Object {
    [ordered]@{
      path = $_.FullName.Substring($Root.Length + 1).Replace("\", "/")
      bytes = $_.Length
      sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  })
  return $files
}

try {
  if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) { throw "BACKUP_ENV_FILE_NOT_FOUND" }
  $settings = Read-LocalEnvironment $envPath
  $projectName = $settings["COMPOSE_PROJECT_NAME"]
  if ($projectName -ne "goldis-local") { throw "BACKUP_LOCAL_COMPOSE_PROJECT_REQUIRED" }
  foreach ($port in @(3000, 3001, 3022)) {
    if (@(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue).Count -gt 0) {
      throw "BACKUP_STOP_LOCAL_APP_AND_WORKERS_FIRST"
    }
  }
  $exportRoot = Resolve-LocalDirectory $settings["API_EXPORT_DIR"] (Join-Path $env:LOCALAPPDATA "Goldis\exports")
  $stagingRoot = Resolve-LocalDirectory $settings["WORKER_STAGING_DIR"] (Join-Path $env:LOCALAPPDATA "Goldis\staging")
  foreach ($sourceRoot in @($exportRoot, $stagingRoot)) {
    $normalizedSource = $sourceRoot.TrimEnd('\') + '\'
    $normalizedDestination = $destinationRoot.TrimEnd('\') + '\'
    if ($normalizedDestination.StartsWith($normalizedSource, [StringComparison]::OrdinalIgnoreCase) -or
      $normalizedSource.StartsWith($normalizedDestination, [StringComparison]::OrdinalIgnoreCase)) {
      throw "BACKUP_OUTPUT_OVERLAPS_SOURCE"
    }
  }

  Protect-PrivateDirectory $destinationRoot
  Protect-PrivateDirectory $workRoot
  New-Item -ItemType Directory -Force -Path $payloadRoot | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $payloadRoot "config") | Out-Null
  Copy-Item -LiteralPath $envPath -Destination (Join-Path $payloadRoot "config\env.local")
  Copy-LocalDirectory $exportRoot (Join-Path $payloadRoot "exports")
  Copy-LocalDirectory $stagingRoot (Join-Path $payloadRoot "staging")

  $composeArgs = @("-p", $projectName, "--env-file", $envPath, "-f", (Join-Path $repoRoot "compose.yaml"),
    "-f", (Join-Path $repoRoot "compose.local-browser.yaml"), "ps", "-q", "postgres")
  $containerId = Invoke-Compose $composeArgs
  if ($containerId -notmatch '^[a-f0-9]{12,64}$') { throw "BACKUP_LOCAL_POSTGRES_NOT_RUNNING" }
  $containerMeta = (& $docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.State.Running}}' $containerId 2>$null | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $containerMeta -ne "goldis-local|postgres|true") { throw "BACKUP_POSTGRES_OWNERSHIP_INVALID" }
  Save-ContainerDump $containerId (Join-Path $payloadRoot "database.dump")

  $manifest = [ordered]@{
    format = "goldis-local-backup"
    formatVersion = 1
    createdAtUtc = $createdUtc
    database = [ordered]@{ name = "goldis"; format = "postgres-custom"; composeProject = "goldis-local" }
    included = @("PostgreSQL", "API_EXPORT_DIR", "WORKER_STAGING_DIR", ".env.local keys and local configuration")
    excluded = @("Redis ephemeral queues and rate limits", "browser profile and portal login cookies", "application logs", "deletion journal and its signing key; keep this local recovery state outside database backups")
    files = @(Get-ManifestFiles $payloadRoot)
  }
  if (@(Get-ChildItem -LiteralPath $payloadRoot -Force -Recurse | Where-Object {
    ($_.Attributes -band [IO.FileAttributes]::Hidden) -ne 0 -or ($_.Attributes -band [IO.FileAttributes]::System) -ne 0
  }).Count -gt 0) { throw "BACKUP_HIDDEN_FILE_UNSUPPORTED" }
  $manifestPath = Join-Path $payloadRoot "manifest.json"
  $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
  Compress-Archive -Path (Join-Path $payloadRoot "*") -DestinationPath $zipPath -CompressionLevel Optimal

  $securePassphrase = Read-Host "Ustaw hasło backupu (minimum 16 znaków); zapisz je poza komputerem" -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassphrase)
  try { $passphrase = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  if ($passphrase.Length -lt 16) { throw "BACKUP_PASSPHRASE_TOO_SHORT" }
  $env:GOLDIS_BACKUP_PASSPHRASE = $passphrase
  $stamp = [DateTime]::UtcNow.ToString("yyyyMMdd-HHmmss")
  $outputPath = Join-Path $destinationRoot "goldis-local-$stamp-$runId.goldis-backup"
  & $node $cryptoScript encrypt $zipPath $outputPath | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "BACKUP_ENCRYPTION_FAILED" }
  $icacls = Join-Path $env:SystemRoot "System32\icacls.exe"
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  & $icacls $outputPath /inheritance:r /grant:r "${identity}:(F)" "*S-1-5-18:(F)" "*S-1-5-32-544:(F)" | Out-Null
  if ($LASTEXITCODE -ne 0) { Remove-Item -LiteralPath $outputPath -Force; throw "BACKUP_FILE_ACL_FAILED" }
  Write-Host "Lokalny backup zaszyfrowany i gotowy: $outputPath"
  Write-Host "Nie obejmuje kolejki Redis ani profilu przeglądarki; po odtworzeniu sprawdź stan zadań i zaloguj ponownie portale."
  Write-Host "Dziennik kasowań i jego klucz nie są w backupie. Zachowaj je poza backupem i użyj przy odtwarzaniu, zanim uruchomisz aplikację."
} finally {
  Remove-Item Env:GOLDIS_BACKUP_PASSPHRASE -ErrorAction SilentlyContinue
  $passphrase = $null
  if (Test-Path -LiteralPath $workRoot) {
    $absoluteWork = [IO.Path]::GetFullPath($workRoot)
    if ($absoluteWork.StartsWith([IO.Path]::GetFullPath($destinationRoot).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -and
      $absoluteWork -match '\\.work-[a-f0-9]{32}$') {
      Remove-Item -LiteralPath $absoluteWork -Recurse -Force
    }
  }
}
