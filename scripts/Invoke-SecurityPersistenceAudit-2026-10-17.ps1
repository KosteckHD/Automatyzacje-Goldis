param([string]$PostgresBin = 'C:\Program Files\PostgreSQL\18\bin', [switch]$ProbesOnly)
$ErrorActionPreference = 'Stop'
$auditId = [Guid]::NewGuid().ToString('N')
$auditRoot = Join-Path $env:TEMP "goldis-security-audit-$auditId"
$auditData = Join-Path $auditRoot 'data'
$auditStarted = $false
$auditPreviousAdmin = $env:GOLDIS_TEST_DATABASE_ADMIN_URL
$auditPreviousModes = $env:GOLDIS_TEST_DB_MODES
$auditPreviousMarker = $env:GOLDIS_SECURITY_AUDIT_CLUSTER
try {
    New-Item -ItemType Directory -Path $auditRoot | Out-Null
    & (Join-Path $PostgresBin 'initdb.exe') -D $auditData -U postgres --locale=C --encoding=UTF8 --auth-local=trust --auth-host=trust --no-sync | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'AUDIT_INITDB_FAILED' }
    $auditListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $auditListener.Start()
    $auditPort = $auditListener.LocalEndpoint.Port
    $auditListener.Stop()
    & (Join-Path $PostgresBin 'pg_ctl.exe') -D $auditData -o "-h 127.0.0.1 -p $auditPort -c listen_addresses=127.0.0.1" -l (Join-Path $auditRoot 'postgres.log') -w -t 30 start
    if ($LASTEXITCODE -ne 0) { throw 'AUDIT_POSTGRES_START_FAILED' }
    $auditStarted = $true
    $env:GOLDIS_TEST_DATABASE_ADMIN_URL = "postgresql://postgres@127.0.0.1:$auditPort/postgres"
    $env:GOLDIS_TEST_DB_MODES = 'reports,deletion,upgrade-061-062'
    $env:GOLDIS_SECURITY_AUDIT_CLUSTER = $auditId
    if (-not $ProbesOnly) {
        node apps/api/scripts/run-db-integration.cjs
        if ($LASTEXITCODE -ne 0) { throw 'AUDIT_DB_SMOKES_FAILED' }
    }
    node scripts/security-persistence-audit-2026-10-17.cjs
    if ($LASTEXITCODE -ne 0) { throw 'AUDIT_PERSISTENCE_PROBES_FAILED' }
} finally {
    $env:GOLDIS_TEST_DATABASE_ADMIN_URL = $auditPreviousAdmin
    $env:GOLDIS_TEST_DB_MODES = $auditPreviousModes
    $env:GOLDIS_SECURITY_AUDIT_CLUSTER = $auditPreviousMarker
    if ($auditStarted) {
        & (Join-Path $PostgresBin 'pg_ctl.exe') -D $auditData -m fast -w -t 30 stop | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'AUDIT_POSTGRES_STOP_FAILED' }
    }
    $auditResolved = [System.IO.Path]::GetFullPath($auditRoot)
    $auditTempPrefix = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
    if (-not $auditResolved.StartsWith($auditTempPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $auditResolved) -ne "goldis-security-audit-$auditId") {
        throw 'AUDIT_CLEANUP_PATH_INVALID'
    }
    if (Test-Path -LiteralPath $auditResolved) { Remove-Item -LiteralPath $auditResolved -Recurse -Force }
}
