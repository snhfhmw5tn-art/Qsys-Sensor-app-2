param([Parameter(Mandatory=$true)][string]$NodePath)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
& "$PSScriptRoot\write-version.ps1" -SourceRoot $repo
$stage = Join-Path $repo "data\iis-stage-$(Get-Date -Format yyyyMMddHHmmss)"
dotnet publish "$repo\hosting\Qsys.Motion.IisHost\Qsys.Motion.IisHost.csproj" -c Release -o $stage
if ($LASTEXITCODE -ne 0) { throw 'Publish failed' }
New-Item -ItemType Directory -Force "$stage\app\node_modules", "$stage\runtime" | Out-Null
foreach ($part in @('client','server','shared','vendor','sw.js','package.json')) {
    Copy-Item -LiteralPath (Join-Path $repo $part) -Destination "$stage\app" -Recurse
}
$dependency = "$repo\node_modules\.pnpm\geographiclib-geodesic@2.2.0\node_modules\geographiclib-geodesic"
Copy-Item -LiteralPath $dependency -Destination "$stage\app\node_modules" -Recurse
Copy-Item -LiteralPath $NodePath -Destination "$stage\runtime\node.exe"
[xml]$config = Get-Content "$stage\web.config"
$vars = $config.CreateElement('environmentVariables')
$variable = $config.CreateElement('environmentVariable')
$variable.SetAttribute('name','MOTION_DATA_DIR')
$variable.SetAttribute('value','C:\ProgramData\Qsys\Sensor2\data')
$vars.AppendChild($variable) | Out-Null
$config.configuration.location.'system.webServer'.aspNetCore.AppendChild($vars) | Out-Null
$config.Save("$stage\web.config")
$result = Join-Path $repo 'data\iis-install-result.json'
@{error='Installer did not finish';detail='Check the Windows elevation prompt and rerun deployment.'} | ConvertTo-Json | Set-Content -LiteralPath $result
$installer = Join-Path $PSScriptRoot 'install-iis-stage.ps1'
Start-Process -FilePath "$env:windir\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$installer`" -Stage `"$stage`" -ResultPath `"$result`"" -Verb RunAs -WindowStyle Hidden -Wait
$status = Get-Content -LiteralPath $result -Raw | ConvertFrom-Json
if ($status.error) { throw $status.detail }
$status
for ($attempt = 0; ; $attempt++) {
    try { Invoke-RestMethod 'https://prototyp.qsys.se/api/health' -NoProxy; break }
    catch { if ($attempt -ge 20) { throw }; Start-Sleep -Seconds 1 }
}
