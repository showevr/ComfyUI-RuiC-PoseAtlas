#Requires -Version 5.1
<#
.SYNOPSIS
    Download RuiC-PoseAtlas portrait images without Node.js (Windows PowerShell).

.DESCRIPTION
    Reads data/faces.json and downloads the full-size PNGs into portrait/img/
    plus any missing 400x500 thumbnails into portrait/thumbs/.
    Already-complete files are skipped, so the script can be re-run to resume.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\fetch-faces.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\fetch-faces.ps1 -ThumbsOnly

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\fetch-faces.ps1 -Limit 5 -Threads 4
#>
param(
    [string]$Root = "",
    [int]$Limit = 0,
    [int]$Threads = 6,
    [switch]$ThumbsOnly,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Split-Path -Parent $PSScriptRoot
}
$Root = (Resolve-Path -LiteralPath $Root).Path

$dataPath = Join-Path $Root 'data\faces.json'
if (-not (Test-Path -LiteralPath $dataPath)) {
    throw "Missing $dataPath - run this script from a complete RuiC-PoseAtlas folder."
}

$data = Get-Content -LiteralPath $dataPath -Raw -Encoding UTF8 | ConvertFrom-Json
$images = @($data.images)
if ($images.Count -eq 0) { throw "No image records in $dataPath" }

$thumbDir = Join-Path $Root 'portrait\thumbs'
$fullDir = Join-Path $Root 'portrait\img'
New-Item -ItemType Directory -Force -Path $thumbDir | Out-Null
if (-not $ThumbsOnly) { New-Item -ItemType Directory -Force -Path $fullDir | Out-Null }

function Get-RelPath([string]$rel) { return ($rel -replace '/', '\') }

function Test-JobDone([string]$file, [long]$minBytes, [bool]$exact) {
    if ($Force) { return $false }
    if (-not (Test-Path -LiteralPath $file)) { return $false }
    $len = (Get-Item -LiteralPath $file).Length
    if ($exact) { return ($len -eq $minBytes) }
    return ($len -ge $minBytes)
}

$jobs = New-Object System.Collections.Generic.List[object]
$seen = 0
foreach ($img in $images) {
    if ($Limit -gt 0 -and $seen -ge $Limit) { break }
    $seen += 1
    $thumbFile = Join-Path $Root (Get-RelPath $img.thumb)
    if (-not (Test-JobDone $thumbFile 1024 $false)) {
        $jobs.Add([pscustomobject]@{ Url = $img.thumb_remote; File = $thumbFile; Min = 1024; Exact = $false })
    }
    if ($ThumbsOnly) { continue }
    $fullFile = Join-Path $Root (Get-RelPath $img.full)
    if (-not (Test-JobDone $fullFile ([long]$img.bytes) $true)) {
        $jobs.Add([pscustomobject]@{ Url = $img.full_remote; File = $fullFile; Min = [long]$img.bytes; Exact = $true })
    }
}

if ($jobs.Count -eq 0) {
    Write-Host "Nothing to do - every image in this selection is already complete." -ForegroundColor Green
    exit 0
}

$total = $jobs.Count
$mb = [math]::Round(($jobs | Measure-Object -Property Min -Sum).Sum / 1MB, 1)
Write-Host ("Downloading {0} file(s), about {1} MB, {2} at a time ..." -f $total, $mb, $Threads)
Write-Host "Target: $fullDir"
Write-Host ""

$curl = Get-Command curl.exe -ErrorAction SilentlyContinue
$useParallel = $false
$retryAll = $false
if ($curl) {
    $help = & $curl.Source --help all 2>$null | Out-String
    if ($help -match '--parallel-max') { $useParallel = $true }
    if ($help -match '--retry-all-errors') { $retryAll = $true }
}

if ($useParallel) {
    # curl handles several URLs per call; keep batches small enough for the
    # Windows command-line limit (~32k chars) and print progress per batch.
    $batchSize = 100
    $index = 0
    while ($index -lt $jobs.Count) {
        $batch = $jobs.GetRange($index, [Math]::Min($batchSize, $jobs.Count - $index))
        $curlArgs = @(
            '--parallel', '--parallel-max', $Threads,
            '--silent', '--show-error', '--fail', '--location',
            '--retry', '5', '--retry-delay', '2',
            '--connect-timeout', '30', '--max-time', '300',
            '--create-dirs'
        )
        if ($retryAll) { $curlArgs += '--retry-all-errors' }
        foreach ($job in $batch) {
            $curlArgs += @('--url', $job.Url, '--output', $job.File)
        }
        & $curl.Source @curlArgs
        if ($LASTEXITCODE -ne 0) {
            Write-Host ("  some transfers in this batch reported errors (curl {0}); continuing ..." -f $LASTEXITCODE) -ForegroundColor Yellow
        }
        $index += $batch.Count
        Write-Host ("[{0}/{1}] requested" -f $index, $total)
    }
}
else {
    Write-Host "curl.exe with --parallel not found, falling back to sequential download." -ForegroundColor Yellow
    $i = 0
    foreach ($job in $jobs) {
        $i += 1
        $tmp = "$($job.File).part"
        $ok = $false
        for ($attempt = 1; $attempt -le 3 -and -not $ok; $attempt += 1) {
            try {
                $client = New-Object System.Net.WebClient
                $client.Headers.Add('User-Agent', 'RuiC-PoseAtlas/1.2')
                $client.DownloadFile($job.Url, $tmp)
                if ((Get-Item -LiteralPath $tmp).Length -ge $job.Min) {
                    Move-Item -LiteralPath $tmp -Destination $job.File -Force
                    $ok = $true
                }
            }
            catch {
                Start-Sleep -Seconds (2 * $attempt)
            }
            finally {
                if ($client) { $client.Dispose() }
            }
        }
        if (-not $ok -and (Test-Path -LiteralPath $tmp)) {
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        }
        if ($i % 25 -eq 0 -or $i -eq $total) { Write-Host ("[{0}/{1}]" -f $i, $total) }
    }
}

# ---- verify -----------------------------------------------------------------
$missing = 0
foreach ($job in $jobs) {
    $good = (Test-Path -LiteralPath $job.File) -and ((Get-Item -LiteralPath $job.File).Length -ge $job.Min)
    if (-not $good) {
        $missing += 1
        if ($missing -le 10) { Write-Host ("  FAILED " + $job.Url) -ForegroundColor Red }
    }
}

Write-Host ""
if ($missing -eq 0) {
    Write-Host ("Done - {0} file(s) ready in portrait/img and portrait/thumbs." -f $total) -ForegroundColor Green
    exit 0
}

Write-Host ("{0} of {1} file(s) failed. Re-run the same command to resume (finished files are skipped)." -f $missing, $total) -ForegroundColor Yellow
exit 1
