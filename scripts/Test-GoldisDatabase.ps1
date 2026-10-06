param([switch]$Automation, [switch]$PlatformOnly)
$ErrorActionPreference = 'Stop'
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
try {
    $compileProjects = @('packages/core/tsconfig.json', 'apps/api/tsconfig.json')
    if ($Automation) { $compileProjects += 'apps/worker/tsconfig.json' }
    foreach ($compileProject in $compileProjects) {
        node node_modules/typescript/bin/tsc -p $compileProject
        if ($LASTEXITCODE -ne 0) { throw 'TEST_BUILD_FAILED' }
    }
    docker run --detach --name $testContainer --label "goldis.test.owner=$testId" -e "POSTGRES_PASSWORD=$testPassword" -p '127.0.0.1::5432' postgres:17-alpine | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'TEST_POSTGRES_START_FAILED' }
    $created = $true
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
    if ($Automation) {
        docker run --detach --name $testRedis --label "goldis.test.owner=$testId" -p '127.0.0.1::6379' redis:7-alpine | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'TEST_REDIS_START_FAILED' }
        $redisCreated = $true
        $redisBinding = (docker port $testRedis 6379/tcp).Trim()
        if ($LASTEXITCODE -ne 0 -or $redisBinding -notmatch '^127\.0\.0\.1:(\d+)$') { throw 'TEST_REDIS_BINDING_INVALID' }
        $env:REDIS_URL = "redis://127.0.0.1:$($Matches[1])/0"
        $env:GOLDIS_TEST_REDIS_DISPOSABLE = '1'
        $env:GOLDIS_AUTOMATION_E2E = '1'
    }
    if ($PlatformOnly) { $env:GOLDIS_TEST_DB_MODES = 'users,tenant-scope' }
    npm run test:db-integration
    if ($LASTEXITCODE -ne 0) { throw 'DB_INTEGRATION_FAILED' }
} finally {
    $env:GOLDIS_TEST_DATABASE_ADMIN_URL = $previousAdminUrl
    $env:REDIS_URL = $previousRedisUrl
    $env:GOLDIS_TEST_REDIS_DISPOSABLE = $previousDisposableRedis
    $env:GOLDIS_AUTOMATION_E2E = $previousAutomation
    $env:GOLDIS_TEST_DB_MODES = $previousDbModes
    if ($redisCreated) {
        $redisInspection = docker inspect $testRedis | ConvertFrom-Json
        if ($LASTEXITCODE -eq 0 -and $redisInspection[0].Config.Labels.'goldis.test.owner' -eq $testId) { docker rm --force $testRedis | Out-Null }
    }
    if ($created) {
        $inspection = docker inspect $testContainer | ConvertFrom-Json
        if ($LASTEXITCODE -eq 0 -and $inspection[0].Config.Labels.'goldis.test.owner' -eq $testId) { docker rm --force $testContainer | Out-Null }
    }
}
