param()
$ErrorActionPreference = 'Stop'

$testId = [Guid]::NewGuid().ToString('N')
$testContainer = "goldis-security-redis-$testId"
$previousRedisUrl = $env:REDIS_URL
$previousDisposable = $env:GOLDIS_TEST_REDIS_DISPOSABLE
$previousLimitSecret = $env:LOGIN_RATE_LIMIT_SECRET
$previousPrefix = $env:LOGIN_RATE_LIMIT_KEY_PREFIX
$created = $false

try {
    docker run --detach --name $testContainer --label "goldis.test.owner=$testId" -p '127.0.0.1::6379' redis:7-alpine | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'SECURITY_REDIS_START_FAILED' }
    $created = $true
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        docker exec $testContainer redis-cli ping *> $null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) { throw 'SECURITY_REDIS_READY_TIMEOUT' }
    $binding = (docker port $testContainer 6379/tcp).Trim()
    if ($LASTEXITCODE -ne 0 -or $binding -notmatch '^127\.0\.0\.1:(\d+)$') { throw 'SECURITY_REDIS_BINDING_INVALID' }

    $env:REDIS_URL = "redis://127.0.0.1:$($Matches[1])/0"
    $env:GOLDIS_TEST_REDIS_DISPOSABLE = '1'
    $env:LOGIN_RATE_LIMIT_SECRET = 'synthetic-security-redis-test-secret-32-bytes-minimum'
    $env:LOGIN_RATE_LIMIT_KEY_PREFIX = "goldis:security:$testId"
    npm run build -w @goldis/api
    if ($LASTEXITCODE -ne 0) { throw 'SECURITY_REDIS_BUILD_FAILED' }
    npm run test:login-rate-limit-redis-smoke -w @goldis/api
    if ($LASTEXITCODE -ne 0) { throw 'SECURITY_REDIS_SMOKE_FAILED' }
} finally {
    $env:REDIS_URL = $previousRedisUrl
    $env:GOLDIS_TEST_REDIS_DISPOSABLE = $previousDisposable
    $env:LOGIN_RATE_LIMIT_SECRET = $previousLimitSecret
    $env:LOGIN_RATE_LIMIT_KEY_PREFIX = $previousPrefix
    if ($created) {
        $inspectionJson = docker inspect $testContainer
        if ($LASTEXITCODE -eq 0) {
            $inspection = $inspectionJson | ConvertFrom-Json
            if ($inspection[0].Config.Labels.'goldis.test.owner' -eq $testId) {
                docker rm --force $testContainer | Out-Null
                if ($LASTEXITCODE -ne 0) { Write-Warning 'SECURITY_REDIS_CLEANUP_FAILED' }
            }
        }
    }
}
