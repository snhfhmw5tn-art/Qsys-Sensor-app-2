param([string]$SourceRoot = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Stop'
$commit = & git -C $SourceRoot log -1 '--format=%H%n%cI'
if ($LASTEXITCODE -ne 0 -or $commit.Count -ne 2) { throw 'Cannot read Git version' }
$json = @{commit=$commit[0];committedAt=$commit[1]} | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $SourceRoot 'client/version.json'), $json, (New-Object Text.UTF8Encoding($false)))
