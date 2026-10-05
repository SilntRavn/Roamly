param(
    [string]$SdkRoot = 'C:\WorkSpace\android-sdk',
    [string]$JdkRoot = 'C:\WorkSpace\roamly-jdk21\jdk-21.0.12.1+1',
    [string]$GradleRoot = 'C:\WorkSpace\gradle-9.6.0',
    [string]$ServerUrl = 'http://6.6.6.6:18080',
    [Alias('DebugWebView')][switch]$DebugEngine,
    [string]$OutputPath
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot
$androidRoot = Join-Path $projectRoot 'android'
$toolsRoot = Join-Path $SdkRoot 'build-tools\37.0.0'
$java = Join-Path $JdkRoot 'bin\java.exe'
$gradle = Join-Path $GradleRoot 'lib\gradle-gradle-cli-main-9.6.0.jar'
$serverUri = [Uri]$ServerUrl
if ($serverUri.Scheme -notin 'http','https' -or !$serverUri.Host -or $serverUri.AbsolutePath -ne '/' -or $serverUri.Query -or $serverUri.UserInfo -or $serverUri.Fragment) { throw 'ServerUrl must be an HTTP(S) origin without credentials, path or query.' }
foreach ($required in @($java, $gradle, "$SdkRoot\platforms\android-37.1\android.jar", "$toolsRoot\zipalign.exe", "$androidRoot\signing\roamly-release.p12", "$androidRoot\signing\password.txt")) {
    if (!(Test-Path -LiteralPath $required)) { throw "Missing build dependency: $required" }
}
function Run-Checked([string]$Exe, [string[]]$Arguments) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Build failed: $Exe ($LASTEXITCODE)" }
}
[IO.File]::WriteAllText("$androidRoot\local.properties", 'sdk.dir=' + $SdkRoot.Replace('\','/'))
$cleartext = ($serverUri.Scheme -eq 'http').ToString().ToLower()
$networkConfig = '<network-security-config><base-config cleartextTrafficPermitted="false" /><domain-config cleartextTrafficPermitted="' + $cleartext + '"><domain includeSubdomains="false">' + $serverUri.Host + '</domain></domain-config></network-security-config>'
[IO.File]::WriteAllText("$androidRoot\res\xml\network_security_config.xml", $networkConfig)
foreach ($manifestPath in @("$androidRoot\assets\messaging\manifest.json", "$androidRoot\debug-assets\messaging\manifest.json")) {
    if (!(Test-Path -LiteralPath $manifestPath)) { continue }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $manifest.content_scripts[0].matches = @($serverUri.Scheme + '://' + $serverUri.Host + '/*')
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 10))
}
$variant = if ($DebugEngine) { 'debug' } else { 'release' }
$task = if ($DebugEngine) { 'assembleDebug' } else { 'assembleRelease' }
Run-Checked $java @('-cp', $gradle, 'org.gradle.launcher.GradleMain', '-p', $androidRoot, '--no-daemon', $task, '--console=plain', ('-PserverUrl=' + $ServerUrl.TrimEnd('/')))
$builtApks = @(Get-ChildItem -LiteralPath "$androidRoot\build\outputs\apk\$variant" -Filter '*.apk')
if ($builtApks.Count -ne 1) { throw 'Expected one ARM64 APK.' }
$apk = if ($OutputPath) { [IO.Path]::GetFullPath($OutputPath) } else { Join-Path $projectRoot 'artifacts\apk\Roamly-1.0.2-arm64.apk' }
New-Item -ItemType Directory -Force (Split-Path $apk) | Out-Null
Copy-Item -LiteralPath $builtApks[0].FullName -Destination $apk -Force
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($apk)
try {
    $libraries = @($archive.Entries | Where-Object { $_.FullName -match '^lib/.+\.so$' })
    if (!$libraries.Count) { throw 'APK contains no native engine libraries.' }
    if (@($libraries | Where-Object { $_.FullName -notlike 'lib/arm64-v8a/*' }).Count) { throw 'APK contains a non-ARM64 native library.' }
    if (@($libraries | Where-Object { $_.CompressedLength -ge $_.Length }).Count) { throw 'APK contains an uncompressed native library.' }
} finally { $archive.Dispose() }
Run-Checked $java @('-jar', "$toolsRoot\lib\apksigner.jar", 'verify', '--verbose', '--print-certs', $apk)
Run-Checked "$toolsRoot\zipalign.exe" @('-c', '-P', '16', '4', $apk)
Get-FileHash -LiteralPath $apk -Algorithm SHA256 | Format-List
Write-Output "APK ready: $apk"
