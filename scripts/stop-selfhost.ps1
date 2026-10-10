$ErrorActionPreference='Stop'
$wfRoot=Split-Path $PSScriptRoot -Parent
$wfStatePath=Join-Path $wfRoot 'artifacts/selfhost-processes.json'
if(!(Test-Path $wfStatePath)){throw 'No managed process record; no process stopped.'}
$wfState=Get-Content -Raw $wfStatePath|ConvertFrom-Json
if($wfState.root -ne $wfRoot){throw 'Process record belongs to another workspace'}
foreach($wfKind in @('server','ngrok')){
 $wfPid=if($wfKind -eq 'server'){$wfState.serverPid}else{$wfState.ngrokPid}
 if(!$wfPid){continue}
 $wfProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$wfPid"
 if(!$wfProcess){continue}
 if($wfKind -eq 'server'){
  if($wfProcess.Name -ne 'node.exe' -or !$wfProcess.CommandLine.Contains((Join-Path $wfRoot 'server/index.cjs').Replace('\','/')) -and !$wfProcess.CommandLine.Contains((Join-Path $wfRoot 'server/index.cjs'))){throw 'Server PID does not match this project; not stopping'}
 }elseif($wfProcess.ExecutablePath -ne $wfState.ngrokPath){throw 'Tunnel PID does not match recorded executable; not stopping'}
 Stop-Process -Id $wfPid
}
Write-Output 'Only recorded WeFile processes stopped. Data and files retained.'
