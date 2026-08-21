Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Require-Command {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Name,
    [Parameter(Mandatory = $true)]
    [string] $InstallHint
  )

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name was not found. $InstallHint"
  }
}

function Wait-And-Open {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Url
  )

  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
        Start-Process $Url
        return
      }
    } catch {
      Start-Sleep -Seconds 1
    }
  }

  Write-Warning "TermRail started, but $Url did not respond within 60 seconds."
}

try {
  Require-Command "node" "Install Node.js 18, 20, or 22+ from https://nodejs.org/."
  Require-Command "npm" "Install npm with Node.js, then reopen this terminal."

  $nodeVersion = (& node -p "process.versions.node").Trim()
  $nodeMajor = [int]($nodeVersion.Split(".")[0])
  if ($nodeMajor -lt 18 -or $nodeMajor -eq 19 -or $nodeMajor -eq 21) {
    throw "Node.js $nodeVersion is not supported. Use Node.js 18.x, 20.x, or 22+."
  }

  if (-not (Test-Path -LiteralPath (Join-Path $root "node_modules"))) {
    Write-Host "[TermRail] Installing dependencies..."
    & npm install
    if ($LASTEXITCODE -ne 0) {
      throw "npm install failed with exit code $LASTEXITCODE."
    }
  }

  if ($env:AUTH_TOKEN -and -not $env:VITE_AUTH_TOKEN) {
    $env:VITE_AUTH_TOKEN = $env:AUTH_TOKEN
  }

  $url = "http://127.0.0.1:5173"
  Start-Job -ScriptBlock ${function:Wait-And-Open} -ArgumentList $url | Out-Null

  Write-Host "[TermRail] Starting backend and UI..."
  Write-Host "[TermRail] UI: $url"
  & npm start
  exit $LASTEXITCODE
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
