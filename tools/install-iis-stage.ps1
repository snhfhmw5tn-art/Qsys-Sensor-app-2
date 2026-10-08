param(
    [Parameter(Mandatory=$true)][string]$Stage,
    [Parameter(Mandatory=$true)][string]$ResultPath
)
$ErrorActionPreference = 'Stop'
try {
    Import-Module WebAdministration
    $name = 'sensor 2'
    $pool = 'Sensor2AppPool'
    $target = 'C:\inetpub\wwwroot\Sensor2'
    $hostname = 'sensor2.qsys.se'
    $dataDir = 'C:\ProgramData\Qsys\Sensor2\data'
    $sourceBinding = Get-WebBinding -Name Sensor -Protocol https | Where-Object { $_.bindingInformation -like '*:443:*' } | Select-Object -First 1
    if (!$sourceBinding) { throw 'Sensor has no HTTPS 443 binding' }
    $thumb = $sourceBinding.certificateHash
    if ($thumb -is [byte[]]) { $thumb = [BitConverter]::ToString($thumb).Replace('-','') }
    $store = $sourceBinding.certificateStoreName
    $cert = Get-Item "Cert:\LocalMachine\$store\$thumb"
    if (!$cert.HasPrivateKey -or $cert.NotAfter -lt (Get-Date)) { throw 'Sensor certificate is unusable' }
    $dnsNames = @($cert.DnsNameList | ForEach-Object { $_.Unicode })
    if ($dnsNames -notcontains '*.qsys.se' -and $dnsNames -notcontains $hostname) { throw 'Certificate does not cover sensor2.qsys.se' }
    foreach ($required in @('web.config','Qsys.Motion.IisHost.dll','runtime\node.exe','app\server\index.js')) {
        if (!(Test-Path -LiteralPath (Join-Path $Stage $required))) { throw "Missing staged file: $required" }
    }
    $existing = Get-Website -Name $name -ErrorAction SilentlyContinue
    if ($existing -and $existing.physicalPath -ne $target) { throw 'Existing site uses a different directory' }
    if (!$existing -and (Test-Path -LiteralPath $target)) { throw 'Deployment directory already exists without this site' }
    $conflict = Get-Website | Where-Object { $_.name -ne $name } | ForEach-Object { $_.bindings.Collection } | Where-Object { $_.bindingInformation -eq "*:443:$hostname" }
    if ($conflict) { throw 'HTTPS binding is already in use' }
    & "$env:windir\system32\inetsrv\appcmd.exe" add backup "Sensor2-$(Get-Date -Format yyyyMMdd-HHmmss)" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'IIS backup failed' }
    if ($existing) {
        if ($existing.state -eq 'Started') { Stop-Website -Name $name }
        if ((Get-WebAppPoolState -Name $pool).Value -ne 'Stopped') { Stop-WebAppPool -Name $pool }
    }
    New-Item -ItemType Directory -Force $target,$dataDir | Out-Null
    # Copy bytes into newly created files so source EFS attributes are not inherited.
    $stageRoot = (Resolve-Path -LiteralPath $Stage).Path.TrimEnd('\')
    Get-ChildItem -LiteralPath $stageRoot -File -Recurse | ForEach-Object {
        $relative = $_.FullName.Substring($stageRoot.Length).TrimStart('\')
        $dest = Join-Path $target $relative
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($dest)) | Out-Null
        $bytes = [IO.File]::ReadAllBytes($_.FullName)
        for ($attempt = 0; ; $attempt++) {
            try { [IO.File]::WriteAllBytes($dest, $bytes); break }
            catch [IO.IOException] {
                if ($attempt -ge 30) { throw }
                Start-Sleep -Seconds 1
            }
        }
    }
    if (!(Test-Path "IIS:\AppPools\$pool")) { New-WebAppPool -Name $pool | Out-Null }
    Set-ItemProperty "IIS:\AppPools\$pool" -Name managedRuntimeVersion -Value ''
    Set-ItemProperty "IIS:\AppPools\$pool" -Name startMode -Value AlwaysRunning
    Set-ItemProperty "IIS:\AppPools\$pool" -Name processModel.idleTimeout -Value ([TimeSpan]::Zero)
    Set-ItemProperty "IIS:\AppPools\$pool" -Name processModel.maxProcesses -Value 1
    Set-ItemProperty "IIS:\AppPools\$pool" -Name recycling.disallowOverlappingRotation -Value $true
    & icacls.exe $target /grant "IIS AppPool\${pool}:(OI)(CI)(RX)" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Site ACL failed' }
    & icacls.exe $dataDir /grant "IIS AppPool\${pool}:(OI)(CI)(M)" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Data ACL failed' }
    if (!$existing) { New-Website -Name $name -PhysicalPath $target -ApplicationPool $pool -Port 443 -HostHeader $hostname -Ssl | Out-Null }
    # Use a fresh ServerManager so provider-cached binding objects cannot copy
    # the source site's hostname onto the destination binding during redeploy.
    Add-Type -Path "$env:windir\System32\inetsrv\Microsoft.Web.Administration.dll"
    $manager = New-Object Microsoft.Web.Administration.ServerManager
    try {
        $https = $manager.Sites[$name].Bindings | Where-Object { $_.Protocol -eq 'https' } | Select-Object -First 1
        $https.BindingInformation = "*:443:$hostname"
        $https.SslFlags = [Microsoft.Web.Administration.SslFlags]1
        $https.CertificateHash = $cert.GetCertHash()
        $https.CertificateStoreName = $store
        $manager.CommitChanges()
    } finally { $manager.Dispose() }
    $hostsPath = "$env:windir\System32\drivers\etc\hosts"
    $hostsText = [IO.File]::ReadAllText($hostsPath)
    if ($hostsText -notmatch '(?im)^\s*[^#\r\n]+\s+sensor2\.qsys\.se(?:\s|$)') {
        Copy-Item -LiteralPath $hostsPath -Destination "$hostsPath.sensor2-$(Get-Date -Format yyyyMMddHHmmss).bak"
        [IO.File]::AppendAllText($hostsPath, "`r`n127.0.0.1 sensor2.qsys.se # Qsys Sensor 2`r`n")
    }
    Start-WebAppPool -Name $pool
    Start-Website -Name $name
    # IIS can remove the HTTP.sys SNI registration while updating an existing
    # binding. Ensure it exists after the site configuration has committed.
    & netsh.exe http show sslcert "hostnameport=${hostname}:443" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        & netsh.exe http add sslcert "hostnameport=${hostname}:443" "certhash=$thumb" "certstorename=$store" 'appid={4dc3e181-e14b-4a21-b022-59fc669b0914}' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'HTTP.sys SNI registration failed' }
    }
    @{site=$name;url="https://$hostname";path=$target;data=$dataDir;certificate=$thumb;state=(Get-Website -Name $name).state} | ConvertTo-Json | Set-Content -LiteralPath $ResultPath -Encoding UTF8
} catch {
    @{error=$_.Exception.Message;detail=($_ | Out-String)} | ConvertTo-Json | Set-Content -LiteralPath $ResultPath -Encoding UTF8
    exit 1
}

