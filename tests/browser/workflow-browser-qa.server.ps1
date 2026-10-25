param([ValidateSet('start','stop')][string]$Mode='start',[string]$RecordId='')
$ErrorActionPreference='Stop'
$repo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$registry='C:\Users\Nikolas\Documents\Codex\server-memory'
$boot=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToString('o')
function Save-Record($path,$value){$temporary=$path+'.'+[guid]::NewGuid().ToString()+'.tmp';$value|ConvertTo-Json -Depth 20|Set-Content -LiteralPath $temporary;Move-Item -LiteralPath $temporary -Destination $path -Force}
foreach($entry in Get-ChildItem -LiteralPath $registry -Filter '*.json'){
 $r=Get-Content -LiteralPath $entry.FullName -Raw|ConvertFrom-Json
 if($r.status -in @('starting','running','unknown') -and $r.system_boot_time -and ([datetimeoffset]$r.system_boot_time) -lt ([datetimeoffset]$boot)){
  $r=Get-Content -LiteralPath $entry.FullName -Raw|ConvertFrom-Json
  if($r.status -in @('starting','running','unknown') -and $r.system_boot_time -and ([datetimeoffset]$r.system_boot_time) -lt ([datetimeoffset]$boot)){
   $r.status='stopped';$r|Add-Member -NotePropertyName stopped_at -NotePropertyValue $null -Force;$r|Add-Member -NotePropertyName stop_reason -NotePropertyValue 'system_restart' -Force;$r|Add-Member -NotePropertyName restart_detected_boot_time -NotePropertyValue $boot -Force;$r|Add-Member -NotePropertyName last_verified_at -NotePropertyValue (Get-Date).ToString('o') -Force;Save-Record $entry.FullName $r
  }
 }
}
if($Mode -eq 'stop'){
 $path=Join-Path $registry ($RecordId+'.json');$record=Get-Content -LiteralPath $path -Raw|ConvertFrom-Json
 if($record.task_identity -ne '/root/workflow_browser_qa' -or $record.repository_path -ne $repo){throw 'Not an owned QA server'}
 $process=Get-Process -Id $record.pids[0] -ErrorAction SilentlyContinue
 if($process){if($process.ProcessName -ne 'node' -or $process.StartTime.ToUniversalTime().Ticks -ne ([datetimeoffset]$record.process_start_time).UtcTicks){throw 'Process identity changed'};Stop-Process -Id $process.Id;Wait-Process -Id $process.Id -ErrorAction SilentlyContinue}
 if(Get-Process -Id $record.pids[0] -ErrorAction SilentlyContinue){throw 'Server still running'}
 $record.status='stopped';$record|Add-Member -NotePropertyName stopped_at -NotePropertyValue (Get-Date).ToString('o') -Force;$record|Add-Member -NotePropertyName stop_reason -NotePropertyValue 'browser_qa_complete' -Force;$record.last_verified_at=(Get-Date).ToString('o');Save-Record $path $record;$record|ConvertTo-Json -Depth 5;exit
}
$matching=@(Get-ChildItem -LiteralPath $registry -Filter '*.json'|ForEach-Object{Get-Content -LiteralPath $_.FullName -Raw|ConvertFrom-Json}|Where-Object{$_.repository_path -eq $repo -and $_.purpose -eq 'Review workflow rendered browser QA' -and $_.status -in @('starting','running','unknown')})
if($matching.Count){throw 'Matching active record requires reconciliation before a second server launch'}
$id=[guid]::NewGuid().ToString();$path=Join-Path $registry ($id+'.json');$now=(Get-Date).ToString('o')
$record=[ordered]@{record_id=$id;project_name='BranchWeave';repository_path=$repo;branch='codex/review-workflow';task_identity='/root/workflow_browser_qa';purpose='Review workflow rendered browser QA';launch_command='node --import tsx tests/browser/workflow-harness.ts';listening_address='127.0.0.1';ports=@();urls=@();pids=@();process_start_time=$null;terminal_session_id=$null;started_at=$now;system_boot_time=$boot;status='starting';last_verified_at=$now}
Save-Record $path $record
$evidence=Join-Path $repo '.test-host/browser-workflow';New-Item -ItemType Directory -Path $evidence -Force|Out-Null
try{
 $process=Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList @('--import','tsx','tests/browser/workflow-harness.ts') -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput (Join-Path $evidence 'workflow-server.stdout.log') -RedirectStandardError (Join-Path $evidence 'workflow-server.stderr.log') -PassThru
 $record.pids=@($process.Id);$record.process_start_time=$process.StartTime.ToString('o');Save-Record $path $record
 $launch=$null;for($i=0;$i -lt 40;$i++){Start-Sleep -Milliseconds 250;$process.Refresh();if($process.HasExited){throw (Get-Content (Join-Path $evidence 'workflow-server.stderr.log') -Raw)};$line=Get-Content (Join-Path $evidence 'workflow-server.stdout.log') -ErrorAction SilentlyContinue|Select-Object -First 1;if($line){$launch=$line|ConvertFrom-Json;break}}
 if(!$launch -or $launch.pid -ne $process.Id){throw 'No verified launch metadata'}
 $port=([uri]$launch.url).Port;$listener=Get-NetTCPConnection -State Listen -LocalPort $port|Where-Object{$_.OwningProcess -eq $process.Id -and $_.LocalAddress -eq '127.0.0.1'}
 if(!$listener){throw 'Could not verify listening process'}
 $record.ports=@($port);$record.urls=@($launch.url);$record.status='running';$record.last_verified_at=(Get-Date).ToString('o');Save-Record $path $record;$record|ConvertTo-Json -Depth 5
}catch{$record.status='failed';$record['verification_notes']=$_.Exception.Message;Save-Record $path $record;throw}
