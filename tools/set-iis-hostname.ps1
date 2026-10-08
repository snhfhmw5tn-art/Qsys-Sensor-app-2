param([string]$ResultPath)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -Path "$env:windir\System32\inetsrv\Microsoft.Web.Administration.dll"
    $manager = New-Object Microsoft.Web.Administration.ServerManager
    try {
        $site = $manager.Sites['sensor 2']
        if (!$site) { throw 'IIS site sensor 2 does not exist' }
        $binding = $site.Bindings | Where-Object { $_.Protocol -eq 'https' -and $_.EndPoint.Port -eq 443 } | Select-Object -First 1
        if (!$binding) { throw 'HTTPS 443 binding not found' }
        $hash = [BitConverter]::ToString($binding.CertificateHash).Replace('-','')
        $store = $binding.CertificateStoreName
        $certificate = Get-Item "Cert:\LocalMachine\$store\$hash"
        if (!$certificate.HasPrivateKey -or $certificate.NotAfter -lt (Get-Date)) { throw 'Certificate is unusable' }
        $names = @($certificate.DnsNameList | ForEach-Object { $_.Unicode })
        if ($names -notcontains '*.qsys.se' -and $names -notcontains 'prototyp.qsys.se') { throw 'Certificate does not cover prototyp.qsys.se' }
        foreach ($other in $manager.Sites) {
            if ($other.Name -ne 'sensor 2' -and ($other.Bindings | Where-Object { $_.BindingInformation -eq '*:443:prototyp.qsys.se' })) { throw 'Hostname is already bound to another site' }
            if ($other.Name -ne 'sensor 2' -and ($other.Bindings | Where-Object { $_.Protocol -eq 'http' -and $_.BindingInformation -eq '*:80:prototyp.qsys.se' })) { throw 'HTTP hostname is already bound to another site' }
        }
        & "$env:windir\System32\inetsrv\appcmd.exe" add backup "Sensor2-Hostname-$(Get-Date -Format yyyyMMdd-HHmmss)" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'IIS backup failed' }
        $binding.BindingInformation = '*:443:prototyp.qsys.se'
        $binding.SslFlags = [Microsoft.Web.Administration.SslFlags]1
        $binding.CertificateHash = $certificate.GetCertHash()
        $binding.CertificateStoreName = $store
        if (!($site.Bindings | Where-Object { $_.Protocol -eq 'http' -and $_.BindingInformation -eq '*:80:prototyp.qsys.se' })) {
            $site.Bindings.Add('*:80:prototyp.qsys.se','http') | Out-Null
        }
        $manager.CommitChanges()
    } finally { $manager.Dispose() }
    & netsh.exe http show sslcert 'hostnameport=prototyp.qsys.se:443' | Out-Null
    if ($LASTEXITCODE -ne 0) {
        & netsh.exe http add sslcert 'hostnameport=prototyp.qsys.se:443' "certhash=$hash" "certstorename=$store" 'appid={4dc3e181-e14b-4a21-b022-59fc669b0914}' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'SNI registration failed' }
    }
    $hostsPath = "$env:windir\System32\drivers\etc\hosts"
    if ([IO.File]::ReadAllText($hostsPath) -notmatch '(?im)^\s*[^#\r\n]+\s+prototyp\.qsys\.se(?:\s|$)') {
        Copy-Item -LiteralPath $hostsPath -Destination "$hostsPath.prototyp-$(Get-Date -Format yyyyMMddHHmmss).bak"
        [IO.File]::AppendAllText($hostsPath, "`r`n127.0.0.1 prototyp.qsys.se # Qsys Sensor 2`r`n")
    }
    @{url='https://prototyp.qsys.se';site='sensor 2';certificate=$hash} | ConvertTo-Json | Set-Content -LiteralPath $ResultPath -Encoding UTF8
} catch {
    @{error=($_ | Out-String)} | ConvertTo-Json | Set-Content -LiteralPath $ResultPath -Encoding UTF8
    exit 1
}
