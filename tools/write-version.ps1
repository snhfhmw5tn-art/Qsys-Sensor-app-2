param([string]$SourceRoot = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Stop'
$commit = & git -C $SourceRoot log -1 '--format=%H%n%cI'
if ($LASTEXITCODE -ne 0 -or $commit.Count -ne 2) { throw 'Cannot read Git version' }
@{commit=$commit[0];committedAt=$commit[1]} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $SourceRoot 'client/version.json') -Encoding utf8
