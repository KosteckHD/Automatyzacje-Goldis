param(
  [Parameter(Mandatory = $true)][string]$BackupPath,
  [string]$EnvFile = ".env.local"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$backupPath = [IO.Path]::GetFullPath($BackupPath)
$envPath = if ([IO.Path]::IsPathRooted($EnvFile)) { [IO.Path]::GetFullPath($EnvFile) } else { [IO.Path]::GetFullPath((Join-Path $repoRoot $EnvFile)) }
$workId = [Guid]::NewGuid().ToString("N")
$workRoot = Join-Path $env:LOCALAPPDATA "Goldis\backup-check\.work-$workId"
$zipPath = Join-Path $workRoot "backup.zip"
$extractRoot = Join-Path $workRoot "payload"
$node = (Get-Command node -ErrorAction Stop).Source
$docker = (Get-Command docker -ErrorAction Stop).Source
$cryptoScript = Join-Path $PSScriptRoot "goldis-backup-crypto.cjs"
$passphrase = $null

function Protect-PrivateDirectory([string]$Path) {
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $icacls = Join-Path $env:SystemRoot "System32\icacls.exe"
  & $icacls $Path /inheritance:r /grant:r "${identity}:(OI)(CI)(F)" "*S-1-5-18:(OI)(CI)(F)" "*S-1-5-32-544:(OI)(CI)(F)" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "BACKUP_CHECK_ACL_FAILED" }
}

function Read-LocalEnvironment([string]$Path) {
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

function Get-Container([string]$Path, [string]$Project) {
  $args = @("compose", "-p", $Project, "--env-file", $Path, "-f", (Join-Path $repoRoot "compose.yaml"),
    "-f", (Join-Path $repoRoot "compose.local-browser.yaml"), "ps", "-q", "postgres")
  $container = (& $docker @args 2>$null | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $container -notmatch '^[a-f0-9]{12,64}$') { throw "BACKUP_CHECK_LOCAL_POSTGRES_NOT_RUNNING" }
  $meta = (& $docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.State.Running}}' $container 2>$null | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $meta -ne "goldis-local|postgres|true") { throw "BACKUP_CHECK_POSTGRES_OWNERSHIP_INVALID" }
  return $container
}

function Assert-PostgresArchive([string]$Container, [string]$DumpPath) {
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $docker
  $start.Arguments = "exec -i $Container pg_restore --list"
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  if (-not $process.Start()) { throw "BACKUP_CHECK_PG_RESTORE_START_FAILED" }
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  $dumpStream = [IO.File]::OpenRead($DumpPath)
  try { $dumpStream.CopyTo($process.StandardInput.BaseStream); $process.StandardInput.Close() }
  finally { $dumpStream.Dispose() }
  $process.WaitForExit()
  $null = $stdout.GetAwaiter().GetResult()
  $null = $stderr.GetAwaiter().GetResult()
  if ($process.ExitCode -ne 0) { throw "BACKUP_CHECK_POSTGRES_ARCHIVE_INVALID" }
}

try {
  if (-not (Test-Path -LiteralPath $backupPath -PathType Leaf) -or [IO.Path]::GetExtension($backupPath) -ne ".goldis-backup") {
    throw "BACKUP_CHECK_FILE_INVALID"
  }
  if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) { throw "BACKUP_CHECK_ENV_FILE_NOT_FOUND" }
  $settings = Read-LocalEnvironment $envPath
  if ($settings["COMPOSE_PROJECT_NAME"] -ne "goldis-local") { throw "BACKUP_LOCAL_COMPOSE_PROJECT_REQUIRED" }
  Protect-PrivateDirectory $workRoot
  $securePassphrase = Read-Host "Wpisz hasło backupu" -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassphrase)
  try { $passphrase = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  $env:GOLDIS_BACKUP_PASSPHRASE = $passphrase
  & $node $cryptoScript decrypt $backupPath $zipPath | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "BACKUP_CHECK_DECRYPT_FAILED" }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    $fileEntries = @($archive.Entries | Where-Object { -not $_.FullName.EndsWith("/") })
    foreach ($entry in $fileEntries) {
      $name = $entry.FullName.Replace("\", "/")
      $segments = $name.Split('/')
      if ([string]::IsNullOrWhiteSpace($name) -or $name.StartsWith("/") -or $name -match '^[A-Za-z]:' -or
        $segments -contains ".." -or $segments -contains "") { throw "BACKUP_CHECK_ARCHIVE_PATH_INVALID" }
    }
  } finally { $archive.Dispose() }
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force
  $manifestPath = Join-Path $extractRoot "manifest.json"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "BACKUP_CHECK_MANIFEST_MISSING" }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.format -ne "goldis-local-backup" -or $manifest.formatVersion -ne 1 -or
    $manifest.database.name -ne "goldis" -or $manifest.database.format -ne "postgres-custom" -or
    $manifest.database.composeProject -ne "goldis-local") { throw "BACKUP_CHECK_MANIFEST_INVALID" }
  $expectedPaths = @($manifest.files | ForEach-Object { [string]$_.path })
  $actualPaths = @(Get-ChildItem -LiteralPath $extractRoot -File -Force -Recurse | Where-Object { $_.FullName -ne $manifestPath } | ForEach-Object {
    $_.FullName.Substring($extractRoot.Length + 1).Replace("\", "/")
  })
  if (Compare-Object ($expectedPaths | Sort-Object) ($actualPaths | Sort-Object)) { throw "BACKUP_CHECK_MANIFEST_FILE_SET_MISMATCH" }
  foreach ($item in $manifest.files) {
    $relative = [string]$item.path
    if ($relative.StartsWith("/") -or $relative -match '^[A-Za-z]:' -or $relative.Split('/') -contains "..") { throw "BACKUP_CHECK_MANIFEST_PATH_INVALID" }
    $file = [IO.Path]::GetFullPath((Join-Path $extractRoot ($relative.Replace("/", "\"))))
    if (-not $file.StartsWith([IO.Path]::GetFullPath($extractRoot).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
      -not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "BACKUP_CHECK_MANIFEST_PATH_INVALID" }
    $info = Get-Item -LiteralPath $file
    $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($info.Length -ne [long]$item.bytes -or $hash -ne [string]$item.sha256) { throw "BACKUP_CHECK_CHECKSUM_MISMATCH" }
  }
  $envInBackup = Join-Path $extractRoot "config\env.local"
  $dumpPath = Join-Path $extractRoot "database.dump"
  if (-not (Test-Path -LiteralPath $envInBackup -PathType Leaf) -or -not (Test-Path -LiteralPath $dumpPath -PathType Leaf)) {
    throw "BACKUP_CHECK_REQUIRED_FILES_MISSING"
  }
  $container = Get-Container $envPath "goldis-local"
  Assert-PostgresArchive $container $dumpPath
  Write-Host ("BACKUP_VERIFIED createdAtUtc={0} files={1} postgresArchive=true checksum=true encryption=true" -f $manifest.createdAtUtc, $manifest.files.Count)
  Write-Host "To jest kontrola integralności kopii. Nie wprowadza ona backupu do działającej bazy."
} finally {
  Remove-Item Env:GOLDIS_BACKUP_PASSPHRASE -ErrorAction SilentlyContinue
  $passphrase = $null
  if (Test-Path -LiteralPath $workRoot) {
    $absoluteWork = [IO.Path]::GetFullPath($workRoot)
    $safeRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Goldis\backup-check")).TrimEnd('\') + '\'
    if ($absoluteWork.StartsWith($safeRoot, [StringComparison]::OrdinalIgnoreCase) -and $absoluteWork -match '\\.work-[a-f0-9]{32}$') {
      Remove-Item -LiteralPath $absoluteWork -Recurse -Force
    }
  }
}
