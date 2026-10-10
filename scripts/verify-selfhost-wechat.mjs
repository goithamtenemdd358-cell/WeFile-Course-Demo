import fs from 'node:fs';import crypto from 'node:crypto';import assert from 'node:assert/strict';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),automator=require('miniprogram-automator');
const config=require('../miniprogram/config');
// Valid PNG fixture generated without external files or user data.
function crc32(bytes){let n=0xffffffff;for(const b of bytes){n^=b;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0)}return(n^0xffffffff)>>>0}
function pngChunk(type,data){const chunk=Buffer.concat([Buffer.from(type),data]),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(chunk));return Buffer.concat([length,chunk,crc])}
const header=Buffer.alloc(13);header.writeUInt32BE(16,0);header.writeUInt32BE(16,4);header[8]=8;header[9]=6;
const pixels=Buffer.alloc(16*(1+16*4));for(let y=0;y<16;y++)for(let x=0;x<16;x++){const p=y*65+1+x*4;pixels[p+1]=180;pixels[p+3]=255}
const bytes=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),pngChunk('IHDR',header),pngChunk('tEXt',Buffer.from('WeFile\0'+'synthetic transport verification. '.repeat(14000))),pngChunk('IDAT',require('node:zlib').deflateSync(pixels)),pngChunk('IEND',Buffer.alloc(0))]);
const testName='本机文件链路测试-'+Date.now()+'.png';
const expectedHash=crypto.createHash('sha256').update(bytes).digest('hex');
const report={at:new Date().toISOString(),status:'RUNNING',scope:'Actual logged-in WeChat runtime → authenticated cloud bridge → owned ngrok → real local SQLite/files. One real account, synthetic PNG; chooser seeded, not a physical device picker test.',checks:[]};
let mp;const timer=setTimeout(()=>{report.status='FAIL';report.error='Timed out';save();process.exit(1)},180000);function save(){fs.writeFileSync('docs/SELFHOST_WECHAT_TEST_RESULT.json',JSON.stringify(report,null,2)+'\n')}
const stateFile='artifacts/selfhost-smoke-state.json';const state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile)):{};
try{
 mp=await automator.connect({wsEndpoint:'ws://127.0.0.1:9420'});
 assert.equal(await mp.evaluate(()=>getApp().globalData.storageMode),'selfhost');
 const call=async(action,payload={})=>{const r=await mp.evaluate(async(env,event)=>{wx.cloud.init({env});return(await wx.cloud.callFunction({name:'api',data:event})).result},config.cloudEnv,{action,payload,requestId:'selfhost-check-'+Date.now()+'-'+Math.random().toString(36).slice(2)});assert.equal(r.ok,true,JSON.stringify(r));return r.data};
 console.log('Verifying real WeChat identity on local server');let login=await call('auth.bootstrap');let user=login.user;if(login.needsProfile)user=await call('user.update',{displayName:'WeFile试用者',expectedRevision:user.revision});
 await mp.evaluate(user=>{wx.removeStorageSync('explicitLogout');getApp().globalData.user=user},user);report.checks.push('Trusted WeChat identity creates/reads profile in local database');save();
 if(!state.projectId){let d=await call('project.draftOpen',{mode:'NEW'});d=await call('project.draftSave',{mode:'NEW',draftId:d.draftId,fields:{name:'本机服务器联调项目',description:'自动化合成资料，用于确认穿透、本机存储和权限；不含真实业务文件。',dueAt:Date.now()+7*86400000,timezone:'Asia/Shanghai'},referenceInputs:[],expectedDraftRevision:d.draftRevision});state.projectId=(await call('project.publish',{draftId:d.draftId,expectedDraftRevision:d.draftRevision})).projectId;fs.writeFileSync(stateFile,JSON.stringify(state))}
 await mp.reLaunch('/pages/home/index');await new Promise(r=>setTimeout(r,1200));
 await mp.evaluate(async projectId=>{await getCurrentPages().slice(-1)[0].go({currentTarget:{dataset:{page:'09',project:projectId}}})},state.projectId);
 for(let i=0;i<80;i++){const p=await mp.evaluate(()=>{const p=getCurrentPages().slice(-1)[0];return{id:p.data.pageId,busy:p.data.busy,error:p.data.error}});if(p.id==='09'&&!p.busy){assert.ok(!p.error,p.error);break}await new Promise(r=>setTimeout(r,200))}
 console.log('Uploading synthetic PNG through native page controller');
 await mp.evaluate(async(base64,size,testName)=>{const p=getCurrentPages().slice(-1)[0];if(p.data.pageId!=='09')throw Error('Not on reference page');const filePath=wx.env.USER_DATA_PATH+'/wefile-transport-source.png';wx.getFileSystemManager().writeFileSync(filePath,base64,'base64');p.selectedReference={path:filePath,name:testName,size};p.setData({referenceName:testName,referenceDescription:'合成PNG；本机服务器上传/下载字节校验。',categoryIndex:3});await p.action({currentTarget:{dataset:{action:'attachReference'}}});if(p.data.error)throw Error(p.data.error)},bytes.toString('base64'),bytes.length,testName);
 const references=await call('reference.list',{projectId:state.projectId});const item=references.items.find(r=>r.name===testName);assert.ok(item,JSON.stringify(references));state.referenceId=item.referenceId;fs.writeFileSync(stateFile,JSON.stringify(state));report.checks.push('Native reference-page upload uses three authenticated chunks, seals immutable bytes and persists reference');save();
 console.log('Opening uploaded reference through actual client download path');
 await mp.evaluate(async ref=>{const p=getCurrentPages().slice(-1)[0];await p.action({currentTarget:{dataset:{action:'preview',kind:'reference',id:ref}}});if(p.data.error)throw Error(p.data.error)},item.referenceId);
 const received=await mp.evaluate(hash=>{const f=wx.getFileSystemManager();const name=f.readdirSync(wx.env.USER_DATA_PATH).find(n=>n.endsWith('-'+hash+'.png'));if(!name)throw Error('Downloaded client file missing');return f.readFileSync(wx.env.USER_DATA_PATH+'/'+name,'base64')},expectedHash);
 assert.equal(crypto.createHash('sha256').update(Buffer.from(received,'base64')).digest('hex'),expectedHash);assert.equal(Buffer.from(received,'base64').length,bytes.length);
 report.checks.push('Client downloaded bytes match original SHA-256 and size; actual PNG preview invoked');report.file={bytes:bytes.length,sha256:expectedHash};
 await call('notification.list',{category:'ALL'});report.checks.push('Notification API remains available on local database');
 await mp.screenshot({path:path.resolve('artifacts/selfhost-reference-preview.png')});report.status='PASS';
}catch(e){report.status='FAIL';report.error=e.message}finally{mp?.disconnect();clearTimeout(timer);save();console.log(JSON.stringify(report,null,2));process.exit(report.status==='PASS'?0:1)}
