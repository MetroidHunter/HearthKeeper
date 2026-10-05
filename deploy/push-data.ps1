<#
.SYNOPSIS
  Windows version of push-data.sh: uploads a snapshot to the VM and installs it (verified before and after the copy).
.EXAMPLE
  .\deploy\push-data.ps1 -Snapshot C:\path\hk-prod-20261005T230819Z.sqlite.gz -Vm hearthkeeper -Zone us-west1-b
.EXAMPLE
  .\deploy\push-data.ps1 -Snapshot .\hk-prod-x.sqlite.gz -HostName you@1.2.3.4      # plain ssh/scp instead of gcloud
.NOTES
  The .manifest.json must sit next to the snapshot with the same base name. Pass -Force to replace a database that already has transactions.
  Authentication is whatever your gcloud login (or ssh key) already gives you; nothing is stored. UNTESTED on Windows: written without a PowerShell host.
#>
param(
  [Parameter(Mandatory)][string]$Snapshot,
  [string]$Vm = $env:HK_VM,
  [string]$Zone = $env:HK_ZONE,
  [string]$HostName = $env:HK_HOST,
  [switch]$Force
)
$ErrorActionPreference = 'Stop'

$gz = (Resolve-Path -LiteralPath $Snapshot).Path
if (-not $gz.EndsWith('.sqlite.gz')) { throw "Expected a .sqlite.gz snapshot, got $gz" }
$manifest = $gz.Substring(0, $gz.Length - '.sqlite.gz'.Length) + '.manifest.json'
if (-not (Test-Path -LiteralPath $manifest)) { throw "Missing manifest next to the snapshot: $manifest" }
if (-not $HostName -and -not $Vm) { throw 'Set -Vm (and -Zone) for gcloud, or -HostName user@ip for plain ssh.' }

function Run([string]$exe, [string[]]$arguments) {
  & $exe @arguments
  if ($LASTEXITCODE -ne 0) { throw "$exe failed with exit code $LASTEXITCODE" }
}

Write-Host '==> verifying locally (checksum against the manifest)'
$want = (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).gzSha256
$got = (Get-FileHash -LiteralPath $gz -Algorithm SHA256).Hash.ToLower()
if ($want -ne $got) { throw "Checksum mismatch: the snapshot differs from its manifest (expected $want, got $got)" }
Write-Host "    sha256 OK ($($got.Substring(0,12))...). The VM repeats this and also checks row counts, integrity and money invariants."

$name = Split-Path -Leaf $gz
$manifestName = Split-Path -Leaf $manifest
$forceArg = if ($Force) { '--force' } else { '' }
$remote = "sudo bash /opt/hearthkeeper/deploy/install-data.sh /tmp/$name $forceArg; rc=`$?; rm -f /tmp/$name /tmp/$manifestName; exit `$rc"

if ($HostName) {
  Write-Host "==> uploading to ${HostName}"
  Run 'scp' @($gz, $manifest, "${HostName}:/tmp/")
  Write-Host '==> installing on the VM'
  Run 'ssh' @($HostName, $remote)
} else {
  $zoneArgs = if ($Zone) { @('--zone', $Zone) } else { @() }
  Write-Host "==> uploading to $Vm"
  Run 'gcloud' (@('compute', 'scp') + $zoneArgs + @($gz, $manifest, "${Vm}:/tmp/"))
  Write-Host '==> installing on the VM'
  Run 'gcloud' (@('compute', 'ssh', $Vm) + $zoneArgs + @('--', $remote))
}
Write-Host '==> done. Delete your local copy of the snapshot when you no longer need it.'
