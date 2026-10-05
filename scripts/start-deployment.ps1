param([switch]$Build)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot
$runRoot = Join-Path $projectRoot 'deploy\run'
$nginxRoot = 'C:\WorkSpace\nginx-1.30.2'
$nginxConfig = Join-Path $projectRoot 'deploy\nginx-roamly.conf'
New-Item -ItemType Directory -Force $runRoot | Out-Null
Push-Location $projectRoot
try {
    if ($Build) { & npm.cmd run build; if ($LASTEXITCODE -ne 0) { throw 'Web build failed' } }
    if (!(Test-Path "$projectRoot\dist\index.html")) { throw 'Run npm run build first.' }
    $listener = Get-NetTCPConnection -State Listen -LocalPort 24173 -ErrorAction SilentlyContinue
    $pidFile = Join-Path $runRoot 'backend.pid'
    if ($listener) {
        if (!(Test-Path $pidFile) -or [int](Get-Content $pidFile) -ne $listener.OwningProcess) { throw 'Port 24173 belongs to another process; it will not be stopped.' }
        Write-Output 'Production backend already running on 24173.'
    } else {
        $nodePath = (Get-Command node.exe).Source
        $launchPath = Join-Path $PSScriptRoot 'run-production.mjs'
        $process = Start-Process -FilePath $nodePath -ArgumentList ('"' + $launchPath + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput "$runRoot\backend.stdout.log" -RedirectStandardError "$runRoot\backend.stderr.log"
        Set-Content -LiteralPath $pidFile -Value $process.Id
        $ready = $false
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            Start-Sleep -Milliseconds 300
            if ($process.HasExited) { throw "Backend failed; inspect $runRoot\backend.stderr.log" }
            try { Invoke-WebRequest 'http://127.0.0.1:24173/' -UseBasicParsing | Out-Null; $ready = $true; break } catch {}
        }
        if (!$ready) { throw 'Backend did not become ready.' }
    }
    & "$nginxRoot\nginx.exe" -p "$nginxRoot/" -c $nginxConfig -t
    if ($LASTEXITCODE -ne 0) { throw 'Nginx configuration validation failed.' }
    $nginxPidFile = Join-Path $runRoot 'nginx.pid'
    $nginxProcess = if (Test-Path $nginxPidFile) { Get-Process -Id ([int](Get-Content $nginxPidFile)) -ErrorAction SilentlyContinue }
    if ($nginxProcess -and $nginxProcess.ProcessName -eq 'nginx') {
        & "$nginxRoot\nginx.exe" -p "$nginxRoot/" -c $nginxConfig -s reload
        if ($LASTEXITCODE -ne 0) { throw 'Nginx reload failed.' }
    } else {
        if (Get-NetTCPConnection -State Listen -LocalPort 18080 -ErrorAction SilentlyContinue) { throw 'Port 18080 is occupied by another process.' }
        Start-Process -FilePath "$nginxRoot\nginx.exe" -ArgumentList @('-p', "$nginxRoot/", '-c', $nginxConfig) -WorkingDirectory $nginxRoot -WindowStyle Hidden
    }
    Write-Output 'Roamly: http://6.6.6.6:18080 (production backend 24173; existing test servers untouched)'
} finally { Pop-Location }
