param(
    [Parameter(Mandatory = $true)][string]$Config,
    [string]$Node = 'node.exe',
    [string]$TaskName = 'CourseArchive-WeChatRelay',
    [ValidateRange(5, 1440)][int]$IntervalMinutes = 15,
    [switch]$Disabled
)

$ErrorActionPreference = 'Stop'
$configPath = (Resolve-Path -LiteralPath $Config).Path
$nodePath = (Get-Command $Node -CommandType Application).Source
$launcher = Join-Path $PSScriptRoot 'run-wechat-relay.ps1'
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$shell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$arguments = '-NoProfile -NonInteractive -File "{0}" -Config "{1}" -Node "{2}"' -f $launcher,$configPath,$nodePath
$action = New-ScheduledTaskAction -Execute $shell -Argument $arguments -WorkingDirectory $PSScriptRoot
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $owner
$recurring = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$principal = New-ScheduledTaskPrincipal -UserId $owner -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 4) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
if ($Disabled) { $settings.Enabled = $false }
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($atLogon, $recurring) -Principal $principal -Settings $settings -Description 'Retrieve encrypted course output and deliver it using the local WeChat sender.' -Force | Out-Null
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName,State
