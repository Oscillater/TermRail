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
  # Vite owns 5173 by default, but silently moves to 5174, 5175, ... when that
  # port is taken by another project. Probe the range and open the page that
  # actually serves TermRail instead of assuming the default port.
  $ports = 5173..5183

  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    foreach ($port in $ports) {
      $url = "http://127.0.0.1:$port"
      $html = $null

      try {
        $request = [System.Net.WebRequest]::Create($url)
        $request.Proxy = $null
        $request.Timeout = 1500
        $response = $request.GetResponse()
        try {
          $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
          try {
            $html = $reader.ReadToEnd()
          } finally {
            $reader.Dispose()
          }
        } finally {
          $response.Close()
        }
      } catch {
        $html = $null
      }

      if ($null -ne $html -and $html.Contains("<title>TermRail")) {
        Start-Process $url
        return
      }
    }

    Start-Sleep -Seconds 1
  }

  Write-Warning "TermRail UI did not answer on ports 5173-5183 within 60 seconds."
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

  Start-Job -ScriptBlock ${function:Wait-And-Open} | Out-Null

  Write-Host "[TermRail] Starting backend and UI..."
  Write-Host "[TermRail] UI: opens automatically (default http://127.0.0.1:5173)."
  Write-Host "[TermRail] If that port is busy, Vite moves to 5174+ and the script follows it."
  & npm start
  exit $LASTEXITCODE
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
