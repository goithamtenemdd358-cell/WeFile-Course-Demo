param([string]$NgrokPath='D:\ngrok.exe')
$ErrorActionPreference='Stop'
$wfRoot=Split-Path $PSScriptRoot -Parent
$wfConfigPath=Join-Path $wfRoot 'artifacts/selfhost-config.json'
if(!(Test-Path -LiteralPath $wfConfigPath)){throw 'Missing private server configuration. Complete server setup first.'}
$wfConfig=Get-Content -Raw -LiteralPath $wfConfigPath | ConvertFrom-Json
$wfState=[ordered]@{serverPid=$null;ngrokPid=$null;root=$wfRoot;ngrokPath=$NgrokPath}
$wfStatePath=Join-Path $wfRoot 'artifacts/selfhost-processes.json'
if(Test-Path $wfStatePath){$wfPrevious=Get-Content -Raw $wfStatePath|ConvertFrom-Json;$wfState.serverPid=$wfPrevious.serverPid;$wfState.ngrokPid=$wfPrevious.ngrokPid}
$wfHealthy=$false
try{$wfHealthy=(Invoke-RestMethod "http://127.0.0.1:$($wfConfig.port)/health" -TimeoutSec 2).service -eq 'WeFile'}catch{}
if(!$wfHealthy){
 $wfScript=Join-Path $wfRoot 'server/index.cjs'
 $wfProcess=Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList @(('"'+$wfScript+'"')) -WorkingDirectory $wfRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $wfRoot 'artifacts/selfhost.log') -RedirectStandardError (Join-Path $wfRoot 'artifacts/selfhost-error.log') -PassThru
 $wfState.serverPid=$wfProcess.Id
}
$wfTunnel=$null
try{$wfTunnel=(Invoke-RestMethod 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 2).tunnels|Where-Object{$_.config.addr -eq "http://127.0.0.1:$($wfConfig.port)"}|Select-Object -First 1}catch{}
if(!$wfTunnel){
 if(Get-Process ngrok -ErrorAction SilentlyContinue){throw 'Another ngrok session is running; preserving it. Check its tunnel configuration.'}
 $wfLog=Join-Path $wfRoot 'artifacts/ngrok-selfhost.log'
 $wfProcess=Start-Process -FilePath $NgrokPath -ArgumentList @('http',"http://127.0.0.1:$($wfConfig.port)",'--inspect=false',('--log="'+$wfLog+'"'),'--log-format=json') -WindowStyle Hidden -PassThru
 $wfState.ngrokPid=$wfProcess.Id
}
$wfState|ConvertTo-Json|Set-Content -Encoding utf8 $wfStatePath
for($wfAttempt=0;$wfAttempt -lt 20;$wfAttempt++){
 try{$wfTunnel=(Invoke-RestMethod 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 2).tunnels|Where-Object{$_.config.addr -eq "http://127.0.0.1:$($wfConfig.port)"}|Select-Object -First 1;if($wfTunnel){break}}catch{}
 Start-Sleep -Milliseconds 500
}
if(!$wfTunnel){throw 'Tunnel not ready; inspect artifacts/ngrok-selfhost.log'}
if($wfTunnel.public_url -ne $wfConfig.origin){throw 'Tunnel domain changed. Update the verified server and cloud relay configuration before use.'}
$wfHealth=Invoke-RestMethod ($wfConfig.origin+'/health') -Headers @{'ngrok-skip-browser-warning'='1'} -TimeoutSec 20
if($wfHealth.service -ne 'WeFile'){throw 'Unexpected public endpoint response'}
Write-Output 'WeFile local server and verified HTTPS tunnel are running.'
