[CmdletBinding()]
param(
    [string]$BrowserPath,
    [string]$KeyPath = (Join-Path $env:LOCALAPPDATA 'UniversalAuthInjector\extension.pem'),
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\dist'),
    [switch]$CreateKey
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-FullPath {
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [string]$BasePath = (Get-Location).Path
    )

    if ([System.IO.Path]::IsPathRooted($Path)) {
        return [System.IO.Path]::GetFullPath($Path)
    }

    return [System.IO.Path]::GetFullPath((Join-Path $BasePath $Path))
}

function Test-PathIsInside {
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [Parameter(Mandatory)]
        [string]$Directory
    )

    $fullPath = Get-FullPath -Path $Path
    $fullDirectory = (Get-FullPath -Path $Directory).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $directoryPrefix = $fullDirectory + [System.IO.Path]::DirectorySeparatorChar

    return $fullPath.Equals($fullDirectory, [System.StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith($directoryPrefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Find-ChromiumBrowser {
    $candidatePaths = @(
        (Join-Path $env:ProgramFiles 'Yandex\YandexBrowser\Application\browser.exe'),
        (Join-Path $env:LOCALAPPDATA 'Yandex\YandexBrowser\Application\browser.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Yandex\YandexBrowser\Application\browser.exe'),
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')
    )

    foreach ($candidatePath in $candidatePaths) {
        if (Test-Path -LiteralPath $candidatePath -PathType Leaf) {
            return $candidatePath
        }
    }

    throw 'Yandex Browser or Google Chrome was not found. Pass its executable with -BrowserPath.'
}

$repositoryRoot = Get-FullPath -Path (Join-Path $PSScriptRoot '..')
$manifestPath = Join-Path $repositoryRoot 'manifest.json'
$resolvedOutputDirectory = Get-FullPath -Path $OutputDirectory -BasePath $repositoryRoot
$resolvedKeyPath = Get-FullPath -Path $KeyPath -BasePath $repositoryRoot

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "manifest.json was not found at $manifestPath"
}

if (Test-PathIsInside -Path $resolvedKeyPath -Directory $repositoryRoot) {
    throw "The signing key must be outside the repository: $resolvedKeyPath"
}

if ($BrowserPath) {
    $resolvedBrowserPath = Get-FullPath -Path $BrowserPath -BasePath $repositoryRoot
    if (-not (Test-Path -LiteralPath $resolvedBrowserPath -PathType Leaf)) {
        throw "Browser executable was not found: $resolvedBrowserPath"
    }
} else {
    $resolvedBrowserPath = Find-ChromiumBrowser
}

$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($manifest.version)) {
    throw 'manifest.json does not contain a version.'
}

$safeVersion = $manifest.version -replace '[^0-9A-Za-z._-]', '-'
$packageBaseName = "universal-auth-injector-$safeVersion"
$stageDirectory = Join-Path $resolvedOutputDirectory $packageBaseName
$browserCrxPath = "$stageDirectory.crx"
$browserPemPath = "$stageDirectory.pem"
$artifactPath = Join-Path $resolvedOutputDirectory "$packageBaseName.crx"

if (-not (Test-Path -LiteralPath $resolvedKeyPath -PathType Leaf) -and -not $CreateKey) {
    throw "Signing key not found at $resolvedKeyPath. Restore it from backup, or use -CreateKey for the first release."
}

if ((Test-Path -LiteralPath $resolvedKeyPath) -and $CreateKey) {
    throw "Signing key already exists at $resolvedKeyPath. Run without -CreateKey."
}

New-Item -ItemType Directory -Force -Path $resolvedOutputDirectory | Out-Null

foreach ($pathToClear in @($stageDirectory, $browserCrxPath, $browserPemPath)) {
    if ((Test-Path -LiteralPath $pathToClear) -and
        -not (Test-PathIsInside -Path $pathToClear -Directory $resolvedOutputDirectory)) {
        throw "Refusing to clear a path outside the output directory: $pathToClear"
    }

    if (Test-Path -LiteralPath $pathToClear) {
        Remove-Item -LiteralPath $pathToClear -Recurse -Force
    }
}

New-Item -ItemType Directory -Path $stageDirectory | Out-Null

$rootFiles = @('manifest.json', 'background.js')
$contentDirectories = @('assets', 'content', 'popup')

foreach ($rootFile in $rootFiles) {
    $sourcePath = Join-Path $repositoryRoot $rootFile
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Required extension file is missing: $sourcePath"
    }
    Copy-Item -LiteralPath $sourcePath -Destination $stageDirectory
}

foreach ($contentDirectory in $contentDirectories) {
    $sourcePath = Join-Path $repositoryRoot $contentDirectory
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) {
        throw "Required extension directory is missing: $sourcePath"
    }
    Copy-Item -LiteralPath $sourcePath -Destination $stageDirectory -Recurse
}

$argumentList = @("--pack-extension=`"$stageDirectory`"")
if (-not $CreateKey) {
    $argumentList += "--pack-extension-key=`"$resolvedKeyPath`""
}

Write-Host "Packing extension $($manifest.version) with $resolvedBrowserPath"
$process = Start-Process -FilePath $resolvedBrowserPath -ArgumentList $argumentList -Wait -PassThru

if (-not (Test-Path -LiteralPath $browserCrxPath -PathType Leaf)) {
    throw "The browser did not create $browserCrxPath (exit code $($process.ExitCode))."
}

if ($CreateKey) {
    if (-not (Test-Path -LiteralPath $browserPemPath -PathType Leaf)) {
        throw "The browser created the CRX but did not create the expected key at $browserPemPath."
    }

    $keyDirectory = Split-Path -Parent $resolvedKeyPath
    New-Item -ItemType Directory -Force -Path $keyDirectory | Out-Null
    Move-Item -LiteralPath $browserPemPath -Destination $resolvedKeyPath
    Write-Warning "A new signing key was created at $resolvedKeyPath. Back it up in a password manager before relying on this release."
}

if (-not $browserCrxPath.Equals($artifactPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    Move-Item -LiteralPath $browserCrxPath -Destination $artifactPath -Force
}

Remove-Item -LiteralPath $stageDirectory -Recurse -Force

Write-Host "CRX created: $artifactPath"
Write-Output $artifactPath

