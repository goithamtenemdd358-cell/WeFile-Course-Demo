import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),automator=require('miniprogram-automator');
const env=require('../miniprogram/config').cloudEnv||process.env.WEFILE_ENV;
assert.ok(env,'Configure cloud environment first');
const report={at:new Date().toISOString(),environment:env,scope:'Real WeChat identity, real CloudBase functions/database. Single account; file and multi-account acceptance excluded.',status:'RUNNING',checks:[]};
const stateFile='artifacts/cloud-smoke-state.json';
const state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile)):{};
let mp;const timer=setTimeout(()=>{report.status='FAIL';report.error='Cloud verification timed out';fs.writeFileSync('docs/CLOUD_TEST_RESULT.json',JSON.stringify(report,null,2)+'\n');console.error(report.error);mp?.disconnect();process.exit(1)},180000);
try{
 mp=await automator.connect({wsEndpoint:'ws://127.0.0.1:9420'});
 const call=async(action,payload={},rid)=>{
  console.log('Cloud check:',action);
  const event={action,payload,requestId:rid||`cloud-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`};
  return mp.evaluate(async(env,event)=>{wx.cloud.init({env});return(await wx.cloud.callFunction({name:'api',data:event})).result},env,event);
 };
 const ok=async(...args)=>{const r=await call(...args);assert.equal(r.ok,true,JSON.stringify(r));return r.data};
 let login=await ok('auth.bootstrap');assert.ok(login.user.userId);report.checks.push('Trusted WeChat identity bootstrap persists a real user');
 if(login.needsProfile)await ok('user.update',{displayName:'WeFile试用者',expectedRevision:login.user.revision});
 const denied=await mp.evaluate(async env=>{try{await wx.cloud.database({env}).collection('users').limit(1).get();return{denied:false}}catch(e){return{denied:true,code:e.errCode,message:e.errMsg}}},env);
 assert.equal(denied.denied,true);assert.match(denied.message,/permission|权限|denied/i);report.checks.push('Client database read denied by cloud permissions');
 if(!state.projectId){
  let draft=await ok('project.draftOpen',{mode:'NEW'});
  draft=await ok('project.draftSave',{mode:'NEW',draftId:draft.draftId,fields:{name:'云端验收示例项目',description:'自动化验收用合成数据，可用于体验；不是用户真实业务资料。',dueAt:Date.now()+7*86400000,timezone:'Asia/Shanghai'},referenceInputs:[],expectedDraftRevision:draft.draftRevision});
  const payload={draftId:draft.draftId,expectedDraftRevision:draft.draftRevision};const rid=`cloud-publish-${Date.now()}`;
  const project=await ok('project.publish',payload,rid);const replay=await ok('project.publish',payload,rid);assert.equal(project.projectId,replay.projectId);
  Object.assign(state,{projectId:project.projectId});fs.writeFileSync(stateFile,JSON.stringify(state,null,2));report.checks.push('Project draft/save/publish and exact request replay do not duplicate project');
 }
 const project=await ok('project.get',{projectId:state.projectId});assert.ok(project);await ok('project.list');await ok('home.get');report.checks.push('Project detail, project list and home read real persisted data');
 const forbidden=await call('project.get',{projectId:'f'.repeat(32)});assert.equal(forbidden.ok,false);assert.equal(forbidden.error.code,'NOT_ACCESSIBLE');report.checks.push('Unknown project returns non-disclosing access denial');
 const notices=await ok('notification.list',{category:'ALL'});assert.ok(Array.isArray(notices.items));await ok('notification.unreadCount');report.checks.push('Notification list and unread count execute on real cloud; event delivery requires second account');
 const file=await call('file.beginUpload',{purpose:'AVATAR',name:'test.png',sizeHint:30});assert.equal(file.ok,false);assert.match(file.error.message,/权限尚未配置/);report.checks.push('File upload fails closed while storage rules are unavailable');
 const timerDenied=await mp.evaluate(async env=>{try{await wx.cloud.callFunction({name:'reminders',config:{env},data:{Type:'Timer',TriggerName:'wefile-hourly'}});return{denied:false}}catch(e){return{denied:true,message:e.errMsg||e.message}}},env);
 assert.equal(timerDenied.denied,true);report.checks.push('Client cannot invoke reminders even with forged timer fields');
 report.status='PASS';
}catch(e){report.status='FAIL';report.error=e.message}
finally{mp?.disconnect();clearTimeout(timer);fs.writeFileSync('docs/CLOUD_TEST_RESULT.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));process.exit(report.status==='PASS'?0:1)}
