$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot
$runRoot = Join-Path $projectRoot 'deploy\run'
$nginxRoot = 'C:\WorkSpace\nginx-1.30.2'
$nginxPidFile = Join-Path $runRoot 'nginx.pid'
if (Test-Path $nginxPidFile) {
    $nginxProcess = Get-Process -Id ([int](Get-Content $nginxPidFile)) -ErrorAction SilentlyContinue
    if ($nginxProcess -and $nginxProcess.ProcessName -eq 'nginx') {
        & "$nginxRoot\nginx.exe" -p "$nginxRoot/" -c "$projectRoot\deploy\nginx-roamly.conf" -s quit
        if ($LASTEXITCODE -ne 0) { throw 'Nginx quit failed' }
    }
}
$pidFile = Join-Path $runRoot 'backend.pid'
if (Test-Path $pidFile) {
    $backendId = [int](Get-Content $pidFile)
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$backendId" -ErrorAction SilentlyContinue
    if ($process -and $process.Name -eq 'node.exe') {
        $expectedScript = Join-Path $projectRoot 'scripts\run-production.mjs'
        if (!$process.CommandLine.Contains($expectedScript)) { throw 'PID belongs to another process; refusing to stop it.' }
        Stop-Process -Id $backendId
    }
    Remove-Item -LiteralPath $pidFile
}
Write-Output 'Production deployment stopped. Existing test servers remain running.'
