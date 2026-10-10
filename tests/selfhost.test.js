const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createServer}=require('../server/index.cjs');
const {openDatabase}=require('../server/database.cjs');
const {createStorage}=require('../server/storage.cjs');
const key='local-test-only-bridge-secret-'.repeat(3),appid='wx0000000000000000';
async function harness(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wefile-real-disk-'));const config={dataDir:dir,origin:'https://localhost',appid,bridgeSecret:key,watermarkSecret:'local-test-only-watermark-secret-'.repeat(2)};
 const app=createServer(config);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+app.server.address().port;
 t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true})});
 let counter=0;
 function signed(who,event){const body=JSON.stringify({identity:appid+':'+who,event});const stamp=String(Date.now()),nonce=crypto.randomBytes(16).toString('hex');return{method:'POST',body,headers:{'content-type':'application/json','x-wefile-time':stamp,'x-wefile-nonce':nonce,'x-wefile-signature':crypto.createHmac('sha256',key).update(stamp+'\n'+nonce+'\n'+body).digest('hex')}}}
 const raw=async(who,action,payload={},requestId)=>{const response=await fetch(origin+'/bridge',signed(who,{action,payload,requestId:requestId||'test-operation-'+(++counter)}));assert.equal(response.status,200);return response.json()};
 const call=async(...args)=>{const r=await raw(...args);assert.equal(r.ok,true,JSON.stringify(r));return r.data};
 return{dir,config,app,origin,signed,raw,call};
}
test('selfhost HTTP: unsigned, forged and replayed signatures denied; no static data directory',async t=>{
 const x=await harness(t);assert.equal((await fetch(x.origin+'/bridge',{method:'POST',body:'{}'})).status,401);
 const request=x.signed('A',{action:'auth.bootstrap'});assert.equal((await fetch(x.origin+'/bridge',request)).status,200);assert.equal((await fetch(x.origin+'/bridge',request)).status,409);
 const wrong=x.signed('A',{action:'auth.bootstrap'});wrong.headers['x-wefile-signature']='0'.repeat(64);assert.equal((await fetch(x.origin+'/bridge',wrong)).status,401);
 for(const url of ['/wefile.sqlite','/files','/server-data/wefile.sqlite'])assert.notEqual((await fetch(x.origin+url)).status,200);
});
test('real SQLite rollback and persistence survive reopening',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wefile-db-')),file=path.join(dir,'data.sqlite');let db=openDatabase(file);
 try{await db.put('users','one',{_id:'one',value:1});await assert.rejects(db.transaction(async tx=>{await tx.put('users','one',{_id:'one',value:2});throw Error('rollback')}));assert.equal((await db.get('users','one')).value,1);await db.close();db=openDatabase(file);assert.equal((await db.get('users','one')).value,1)}finally{await db.close();fs.rmSync(dir,{recursive:true,force:true})}
});
test('selfhost real HTTP + SQLite + files: three test identities FIRST KEEP OVERWRITE review and access controls',async t=>{
 const x=await harness(t),users={};for(const who of ['A','B','C']){const a=await x.call(who,'auth.bootstrap');users[who]=await x.call(who,'user.update',{displayName:who,expectedRevision:a.user.revision})}
 let d=await x.call('A','project.draftOpen',{mode:'NEW'});d=await x.call('A','project.draftSave',{mode:'NEW',draftId:d.draftId,fields:{name:'Disk-backed test',description:'synthetic test data only',dueAt:Date.now()+86400000,timezone:'Asia/Shanghai'},referenceInputs:[],expectedDraftRevision:d.draftRevision});
 const p=await x.call('A','project.publish',{draftId:d.draftId,expectedDraftRevision:d.draftRevision});for(const who of ['B','C'])await x.call(who,'project.join',{code:p.inviteCode});
 const task=await x.call('A','task.publish',{projectId:p.projectId,fields:{title:'real file task',description:'private instructions',requirements:'PDF',assigneeId:users.B.userId,dueAt:Date.now()+3600000}});
 let current=await x.call('B','task.get',{taskId:task.taskId});assert.equal((await x.call('C','task.get',{taskId:task.taskId})).description,undefined);
 let previous,overwritten;for(const [index,mode] of ['FIRST','KEEP','OVERWRITE'].entries()){
  const bytes=Buffer.from('%PDF-1.7\nActual bytes '+index+'\n%%EOF');
  const plan=await x.call('B','file.beginUpload',{purpose:'TASK_DRAFT',taskId:task.taskId,name:'demo.pdf',sizeHint:bytes.length});
  const payload={uploadSessionId:plan.uploadSessionId,offset:0,base64:bytes.toString('base64')};
  assert.equal((await x.raw('C','transport.upload',payload)).ok,false);
  const uploaded=await x.call('B','transport.upload',payload);assert.deepEqual(await x.call('B','transport.upload',payload),uploaded);
  assert.equal((await x.raw('B','transport.upload',{...payload,base64:Buffer.from('wrong').toString('base64')})).ok,false);
  const sealed=await x.call('B','file.finalizeUpload',{uploadSessionId:plan.uploadSessionId,tempFileId:uploaded.tempFileId});
  assert.equal(sealed.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal((await x.raw('B','transport.upload',payload)).ok,false);
  let base={};if(mode!=='FIRST'){const versions=await x.call('B','version.list',{taskId:task.taskId});const v=versions.items.find(v=>v.visibleVersionId===current.currentSubmission.visibleVersionId);base={baseVersionId:v.visibleVersionId,expectedVersionRevision:v.versionRevision};}
  const s=await x.call('B','submission.submit',{taskId:task.taskId,revisionId:sealed.revisionId,mode,expectedTaskRevision:current.revision,...base});assert.equal(s.visibleVersion.displayNumber,mode==='FIRST'?1:2);
  const target={kind:'submission',id:s.submission.submissionId};assert.equal((await x.raw('C','file.getReadTicket',{target})).ok,false);
  const ticket=await x.call('B','file.getReadTicket',{target}),token=new URL(ticket.downloadUrl).searchParams.get('ticket');const downloaded=await x.call('B','transport.download',{ticket:token,offset:0});assert.deepEqual(Buffer.from(downloaded.base64,'base64'),bytes);assert.equal((await x.raw('C','transport.download',{ticket:token,offset:0})).ok,false);
  if(index<2){previous=await x.call('A','review.reject',{submissionId:s.submission.submissionId,expectedTaskRevision:s.task.revision,reason:'revise',revisionDueAt:null,priority:'IMPORTANT'});current=previous.task;if(index===1)overwritten=s.submission.submissionId;}
  else{const done=await x.call('A','review.approve',{submissionId:s.submission.submissionId,expectedTaskRevision:s.task.revision});assert.equal(done.task.state,'DONE')}
 }
 assert.equal((await x.raw('B','file.getReadTicket',{target:{kind:'submission',id:overwritten}})).ok,false);
 const notices=await x.call('B','notification.list',{category:'ALL'});assert.ok(notices.items.some(n=>n.eventType==='APPROVED'));
 const revisions=await x.app.db.query('file_revisions',{});assert.equal(revisions.length,3);
 for(const r of revisions){const file=path.join(x.dir,'files','objects',r.blobId.slice(8));assert.ok(fs.existsSync(file));assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),r.sha256);}
 const storage=createStorage({root:path.join(x.dir,'files'),secret:x.config.watermarkSecret,origin:x.config.origin,db:x.app.db,actor:users.B.userId});await assert.rejects(storage.seal(revisions[0].blobId.slice(8),Buffer.from('overwrite')));
});
test('selfhost upload accepts a real 20 MiB boundary file, verifies bytes and rejects overrun',async t=>{
 const x=await harness(t);const login=await x.call('A','auth.bootstrap');await x.call('A','user.update',{displayName:'test',expectedRevision:login.user.revision});
 const size=20*1024*1024,bytes=Buffer.alloc(size,97);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
 const plan=await x.call('A','file.beginUpload',{purpose:'AVATAR',name:'boundary.png',sizeHint:size});let uploaded;
 for(let offset=0;offset<size;offset+=192*1024){uploaded=await x.call('A','transport.upload',{uploadSessionId:plan.uploadSessionId,offset,base64:bytes.subarray(offset,offset+192*1024).toString('base64')})}
 assert.equal((await x.raw('A','transport.upload',{uploadSessionId:plan.uploadSessionId,offset:size,base64:'YQ=='})).ok,false);
 const r=await x.call('A','file.finalizeUpload',{uploadSessionId:plan.uploadSessionId,tempFileId:uploaded.tempFileId});assert.equal(r.size,size);assert.equal(r.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));
});
test('snapshot importer retains existing target and rolls back invalid snapshots',async()=>{
 const {importSnapshot}=require('../server/import-snapshot.cjs');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wefile-import-'));const target=path.join(dir,'db.sqlite'),file=path.join(dir,'snapshot.json');
 const snapshot=Object.fromEntries(require('../database/collections.json').map(n=>[n,[]]));snapshot.users=[{_id:'u',displayName:'original'}];fs.writeFileSync(file,JSON.stringify(snapshot));
 try{await importSnapshot(file,target);await assert.rejects(importSnapshot(file,target),/empty/);const db=openDatabase(target);try{assert.equal((await db.get('users','u')).displayName,'original')}finally{await db.close()};snapshot.file_revisions=[{_id:'unmigrated'}];fs.writeFileSync(file,JSON.stringify(snapshot));await assert.rejects(importSnapshot(file,path.join(dir,'new.sqlite')),/cloud files/)}finally{fs.rmSync(dir,{recursive:true,force:true})}
});
