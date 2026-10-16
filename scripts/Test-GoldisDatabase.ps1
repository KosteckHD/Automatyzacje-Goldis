param([switch]$Automation, [switch]$PlatformOnly, [ValidateSet('migrations','migrations-upgrade','password-recovery','tenant-scope','teams-db','admin-users-db','grouping','registry-jobs','reports','deletion','backup-restore','security-db','run-control','runtime-roles','app-module')][string]$Module)
$ErrorActionPreference = 'Stop'
if ($Module -and ($Automation -or $PlatformOnly)) { throw 'MODULE_TEST_CANNOT_ENABLE_AUTOMATION' }
$testId = [Guid]::NewGuid().ToString('N')
$testContainer = "goldis-db-smoke-$testId"
$testPassword = [Guid]::NewGuid().ToString('N')
$previousAdminUrl = $env:GOLDIS_TEST_DATABASE_ADMIN_URL
$created = $false
$redisCreated = $false
$testRedis = "goldis-automation-redis-$testId"
$previousRedisUrl = $env:REDIS_URL
$previousDisposableRedis = $env:GOLDIS_TEST_REDIS_DISPOSABLE
$previousAutomation = $env:GOLDIS_AUTOMATION_E2E
$previousDbModes = $env:GOLDIS_TEST_DB_MODES
$previousModuleRunner = $env:GOLDIS_TEST_MODULE_RUNNER
$previousAppModuleSmoke = $env:GOLDIS_TEST_APP_MODULE_SMOKE
$previousLivePortals = $env:WORKER_LIVE_PORTALS
$previousPlaywrightIntegration = $env:PLAYWRIGHT_INTEGRATION
$previousTestPostgresContainer = $env:GOLDIS_TEST_POSTGRES_CONTAINER
$previousTestPostgresOwner = $env:GOLDIS_TEST_POSTGRES_OWNER
$fullFlowEnvironmentNames = @('GOLDIS_AUTOMATION_E2E', 'GOLDIS_FULL_FLOW_E2E', 'GOLDIS_PLATFORM_E2E', 'GOLDIS_LIVE_E2E')
$previousFullFlowEnvironment = @{}
foreach ($name in $fullFlowEnvironmentNames) { $previousFullFlowEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    foreach ($name in $fullFlowEnvironmentNames) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
    $env:WORKER_LIVE_PORTALS = '0'
    $env:PLAYWRIGHT_INTEGRATION = '0'
    if ($Module) { $env:GOLDIS_TEST_MODULE_RUNNER = '1' }
    $compileProjects = @('packages/core/tsconfig.json', 'apps/api/tsconfig.json')
    if (-not $Module -or $Automation -or $Module -eq 'runtime-roles' -or $Module -eq 'security-db' -or $Module -eq 'app-module') { $compileProjects += 'apps/worker/tsconfig.json' }
    if ($Module -eq 'run-control') { $compileProjects += 'apps/worker/tsconfig.json' }
    foreach ($compileProject in $compileProjects) {
        $workspaceName = switch ($compileProject) {
            'packages/core/tsconfig.json' { '@goldis/core' }
            'apps/api/tsconfig.json' { '@goldis/api' }
            'apps/worker/tsconfig.json' { '@goldis/worker' }
            default { throw 'TEST_BUILD_WORKSPACE_UNKNOWN' }
        }
        node scripts/clean-workspace-dist.cjs $workspaceName
        if ($LASTEXITCODE -ne 0) { throw 'TEST_BUILD_CLEAN_FAILED' }
        node node_modules/typescript/bin/tsc -p $compileProject
        if ($LASTEXITCODE -ne 0) { throw 'TEST_BUILD_FAILED' }
    }
    docker run --detach --name $testContainer --label "goldis.test.owner=$testId" -e "POSTGRES_PASSWORD=$testPassword" -p '127.0.0.1::5432' postgres:17-alpine | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'TEST_POSTGRES_START_FAILED' }
    $created = $true
    $env:GOLDIS_TEST_POSTGRES_CONTAINER = $testContainer
    $env:GOLDIS_TEST_POSTGRES_OWNER = $testId
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        docker exec $testContainer pg_isready -U postgres -d postgres *> $null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) { throw 'TEST_POSTGRES_READY_TIMEOUT' }
    $binding = (docker port $testContainer 5432/tcp).Trim()
    if ($LASTEXITCODE -ne 0 -or $binding -notmatch '^127\.0\.0\.1:(\d+)$') { throw 'TEST_POSTGRES_BINDING_INVALID' }
    $testPort = $Matches[1]
    $env:GOLDIS_TEST_DATABASE_ADMIN_URL = "postgresql://postgres:$testPassword@127.0.0.1:$testPort/postgres"
    if ($Automation -or $Module -eq 'app-module' -or (-not $Module -and -not $PlatformOnly)) {
        docker run --detach --name $testRedis --label "goldis.test.owner=$testId" -p '127.0.0.1::6379' redis:7-alpine | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'TEST_REDIS_START_FAILED' }
        $redisCreated = $true
        $redisBinding = (docker port $testRedis 6379/tcp).Trim()
        if ($LASTEXITCODE -ne 0 -or $redisBinding -notmatch '^127\.0\.0\.1:(\d+)$') { throw 'TEST_REDIS_BINDING_INVALID' }
        $env:REDIS_URL = "redis://127.0.0.1:$($Matches[1])/0"
        $env:GOLDIS_TEST_REDIS_DISPOSABLE = '1'
        if ($Automation) { $env:GOLDIS_AUTOMATION_E2E = '1' }
    }
    if ($Module -eq 'migrations') { $env:GOLDIS_TEST_DB_MODES = 'users-empty' }
    elseif ($Module -eq 'migrations-upgrade') { $env:GOLDIS_TEST_DB_MODES = 'upgrade-061-062' }
    elseif ($Module -eq 'password-recovery') { $env:GOLDIS_TEST_DB_MODES = 'users-empty' }
    elseif ($Module -eq 'tenant-scope') { $env:GOLDIS_TEST_DB_MODES = 'tenant-scope' }
    elseif ($Module -eq 'teams-db') { $env:GOLDIS_TEST_DB_MODES = 'teams' }
    elseif ($Module -eq 'admin-users-db') { $env:GOLDIS_TEST_DB_MODES = 'admin-users' }
    elseif ($Module -eq 'registry-jobs') { $env:GOLDIS_TEST_DB_MODES = 'registry-jobs' }
    elseif ($Module -eq 'reports') { $env:GOLDIS_TEST_DB_MODES = 'reports' }
    elseif ($Module -eq 'deletion') { $env:GOLDIS_TEST_DB_MODES = 'deletion' }
    elseif ($Module -eq 'grouping') { $env:GOLDIS_TEST_DB_MODES = 'grouping-perf' }
    elseif ($Module -eq 'backup-restore') { $env:GOLDIS_TEST_DB_MODES = 'backup-restore' }
    elseif ($Module -eq 'run-control') { $env:GOLDIS_TEST_DB_MODES = 'run-control' }
    elseif ($Module -eq 'security-db') { $env:GOLDIS_TEST_DB_MODES = 'users,tenant-scope,runtime-roles' }
    elseif ($Module -eq 'runtime-roles') { $env:GOLDIS_TEST_DB_MODES = 'runtime-roles' }
    elseif ($Module -eq 'app-module') {
        $env:GOLDIS_TEST_DB_MODES = 'app-module'
    }
    if ($Module -eq 'app-module' -or ($Automation -or (-not $Module -and -not $PlatformOnly))) {
        $env:GOLDIS_TEST_APP_MODULE_SMOKE = '1'
    }
    elseif ($PlatformOnly) { $env:GOLDIS_TEST_DB_MODES = 'users,tenant-scope' }
    npm run test:db-integration
    if ($LASTEXITCODE -ne 0) { throw 'DB_INTEGRATION_FAILED' }
} finally {
    $env:GOLDIS_TEST_DATABASE_ADMIN_URL = $previousAdminUrl
    $env:REDIS_URL = $previousRedisUrl
    $env:GOLDIS_TEST_REDIS_DISPOSABLE = $previousDisposableRedis
    $env:GOLDIS_AUTOMATION_E2E = $previousAutomation
    $env:GOLDIS_TEST_DB_MODES = $previousDbModes
    $env:GOLDIS_TEST_MODULE_RUNNER = $previousModuleRunner
    $env:GOLDIS_TEST_APP_MODULE_SMOKE = $previousAppModuleSmoke
    $env:WORKER_LIVE_PORTALS = $previousLivePortals
    $env:PLAYWRIGHT_INTEGRATION = $previousPlaywrightIntegration
    $env:GOLDIS_TEST_POSTGRES_CONTAINER = $previousTestPostgresContainer
    $env:GOLDIS_TEST_POSTGRES_OWNER = $previousTestPostgresOwner
    foreach ($name in $fullFlowEnvironmentNames) { [Environment]::SetEnvironmentVariable($name, $previousFullFlowEnvironment[$name], 'Process') }
    if ($redisCreated) {
        $redisInspection = docker inspect $testRedis | ConvertFrom-Json
        if ($LASTEXITCODE -eq 0 -and $redisInspection[0].Config.Labels.'goldis.test.owner' -eq $testId) { docker rm --force $testRedis | Out-Null }
    }
    if ($created) {
        $inspection = docker inspect $testContainer | ConvertFrom-Json
        if ($LASTEXITCODE -eq 0 -and $inspection[0].Config.Labels.'goldis.test.owner' -eq $testId) { docker rm --force $testContainer | Out-Null }
    }
}
