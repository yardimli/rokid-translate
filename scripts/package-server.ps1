$ErrorActionPreference = 'Stop'
$repoPath = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Force "$repoPath\dist" | Out-Null
$archive = "$repoPath\dist\rokid-test-server.zip"
# Explicit allowlist prevents local credentials, node_modules and logs entering the upload.
$items = @('src', 'public', 'deploy', 'scripts', 'test', 'package.json', 'package-lock.json', '.env.example', 'DEPLOY.md', 'PROTOCOL.md') |
    ForEach-Object { Join-Path "$repoPath\server" $_ }
Compress-Archive -LiteralPath $items -DestinationPath $archive -Force
Write-Output "Server upload package: $archive"
