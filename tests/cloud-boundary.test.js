const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('WeChat boundary ignores SDK userInfo but derives actor only from trusted context',async()=>{
 let captured;const exports={};
 const cloud={DYNAMIC_CURRENT_ENV:'dynamic',init(){},getWXContext(){return{APPID:'trusted-app',OPENID:'trusted-user'}},database(){return{}}};
 const context={exports,__dirname:'.',process:{env:{WATERMARK_SECRET:'x'.repeat(40)}},require(name){if(name==='fs')return{existsSync:()=>false};if(name==='path')return require('node:path');if(name==='wx-server-sdk')return cloud;if(name.endsWith('/service'))return{Service:class{async invoke(actor,event){captured={actor,event};return{ok:true}}}};if(name.endsWith('/cloud-adapter'))return{adapter:x=>x,storage:x=>x};throw Error(name)}};
 vm.runInNewContext(fs.readFileSync('cloudfunctions/api/index.js','utf8'),context);
 await exports.main({action:'auth.bootstrap',payload:{},userInfo:{openId:'forged',appId:'forged'},tcbContext:{openid:'forged'},extra:'keep-for-strict-validation'});
 assert.equal(captured.actor,'trusted-app:trusted-user');
 assert.equal(captured.event.userInfo,undefined);
 assert.equal(captured.event.tcbContext,undefined);
 assert.equal(captured.event.extra,'keep-for-strict-validation');
 assert.equal(captured.event.action,'auth.bootstrap');
});
