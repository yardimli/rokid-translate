param([switch]$SkipLint)
$ErrorActionPreference = 'Stop'
$repoPath = Split-Path -Parent $PSScriptRoot
Push-Location $repoPath
try {
    # Prefer the repository-local toolchain prepared during the first build.
    $localJdk = Get-ChildItem -Directory "$repoPath\.tools\jdk17" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($localJdk) { $env:JAVA_HOME = $localJdk.FullName }
    if (-not $env:JAVA_HOME) { throw 'Set JAVA_HOME to JDK 17, then run this script again.' }
    # Let Gradle use Android Studio's SDK selection in local.properties.
    $sdkProperties = Join-Path $repoPath 'local.properties'
    $hasProjectSdk = (Test-Path $sdkProperties) -and
        (Select-String -Path $sdkProperties -Pattern '^\s*sdk\.dir\s*=' -Quiet)
    if ($hasProjectSdk) {
        Remove-Item Env:ANDROID_HOME -ErrorAction SilentlyContinue
        Remove-Item Env:ANDROID_SDK_ROOT -ErrorAction SilentlyContinue
    } elseif (-not $env:ANDROID_HOME -and (Test-Path "$repoPath\.tools\android-sdk")) {
        $env:ANDROID_HOME = "$repoPath\.tools\android-sdk"
    }
    $env:GRADLE_USER_HOME = "$repoPath\.tools\gradle-user"
    $env:ANDROID_USER_HOME = "$repoPath\.tools\android-user"
    $tasks = @('assembleDebug', 'testDebugUnitTest')
    if (-not $SkipLint) { $tasks += 'lintDebug' }
    $localGradle = "$repoPath\.tools\gradle-8.11.1\bin\gradle.bat"
    if (Test-Path $localGradle) { & $localGradle @tasks --no-daemon }
    else { & .\gradlew.bat @tasks --no-daemon }
    if ($LASTEXITCODE -ne 0) { throw 'Android build failed.' }
    New-Item -ItemType Directory -Force dist | Out-Null
    Copy-Item app/build/outputs/apk/debug/app-debug.apk dist/rokid-translate-test.apk -Force
    Write-Output "APK: $repoPath\dist\rokid-translate-test.apk"
} finally { Pop-Location }
