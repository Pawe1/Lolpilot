[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'extension'
$destination = Join-Path $HOME '.copilot\extensions\lolpilot'

if (Test-Path -LiteralPath $destination) {
    $item = Get-Item -LiteralPath $destination -Force
    if ($item.LinkType -ne 'Junction' -or $item.Target -notcontains $source) {
        throw "Refusing to replace existing non-Lolpilot extension: $destination"
    }
    Remove-Item -LiteralPath $destination -Force
}

New-Item -ItemType Junction -Path $destination -Target $source | Out-Null
Write-Host "Installed Lolpilot development extension at $destination"
