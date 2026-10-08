param([Parameter(Mandatory=$true)][string]$SourceRoot, [Parameter(Mandatory=$true)][string]$ResultPath, [switch]$IncludeServer)
$ErrorActionPreference='Stop'
try {
    & "$PSScriptRoot\write-version.ps1" -SourceRoot $SourceRoot
    Add-Type -Path "$env:windir\System32\inetsrv\Microsoft.Web.Administration.dll"
    $manager=New-Object Microsoft.Web.Administration.ServerManager
    try {
        $site=$manager.Sites['sensor 2']
        if (!$site) { throw 'IIS site sensor 2 does not exist' }
        $root=$site.Applications['/'].VirtualDirectories['/'].PhysicalPath
        if ($root -ne 'C:\inetpub\wwwroot\Sensor2') { throw 'Unexpected deployment directory' }
    } finally { $manager.Dispose() }
    # Client-only updates preserve the user's HTTP/HTTPS bindings and running backend.
    $folders=@('client','shared')
    if ($IncludeServer) { $folders += 'server' }
    foreach ($folder in $folders) {
        $source=Join-Path $SourceRoot $folder
        Get-ChildItem -LiteralPath $source -File -Recurse | ForEach-Object {
            $relative=$_.FullName.Substring($source.Length).TrimStart('\')
            $destination=Join-Path "$root\app\$folder" $relative
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
            [IO.File]::WriteAllBytes($destination,[IO.File]::ReadAllBytes($_.FullName))
        }
    }
    [IO.File]::WriteAllBytes("$root\app\sw.js",[IO.File]::ReadAllBytes((Join-Path $SourceRoot 'sw.js')))
    if ($IncludeServer) {
        $restartManager=New-Object Microsoft.Web.Administration.ServerManager
        try { $restartManager.ApplicationPools['Sensor2AppPool'].Recycle() | Out-Null } finally { $restartManager.Dispose() }
    }
    @{ok=$true;path=$root} | ConvertTo-Json | Set-Content -LiteralPath $ResultPath -Encoding UTF8
} catch {
    @{error=($_ | Out-String)} | ConvertTo-Json | Set-Content -LiteralPath $ResultPath -Encoding UTF8
    exit 1
}
