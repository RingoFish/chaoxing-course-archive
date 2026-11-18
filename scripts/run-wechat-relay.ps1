param(
    [Parameter(Mandatory = $true)][string]$Config,
    [string]$Node = 'node.exe'
)

$ErrorActionPreference = 'Stop'
$configPath = (Resolve-Path -LiteralPath $Config).Path
$directory = Split-Path -Parent $configPath
$log = Join-Path $directory 'latest.log'
$previous = Join-Path $directory 'previous-error.log'
$script = Join-Path $PSScriptRoot 'wechat-relay.mjs'
$runLock = Join-Path $directory 'task.lock'
try { $guard = [IO.File]::Open($runLock, 'OpenOrCreate', 'ReadWrite', 'None') }
catch [IO.IOException] { exit 1 }
try {
    $err = Join-Path $directory 'latest.stderr.log'
    $arguments = '"{0}" --config "{1}"' -f $script,$configPath
    $process = Start-Process -FilePath $Node -ArgumentList $arguments -NoNewWindow -Wait -PassThru -RedirectStandardOutput $log -RedirectStandardError $err
    if ($process.ExitCode -ne 0) { Copy-Item -LiteralPath $err -Destination $previous -Force }
    exit $process.ExitCode
} finally { $guard.Dispose() }
