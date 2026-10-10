const cloud=require('wx-server-sdk');
const CloudBase=require('@cloudbase/manager-node');
const crypto=require('crypto');
const access=require('./access.json');
const manifest=require('./manifest.json');
cloud.init({env:cloud.DYNAMIC_CURRENT_ENV});
exports.main=async event=>{
 const ctx=cloud.getWXContext();
 const hash=crypto.createHash('sha256').update(String(event.token||'')).digest('hex');
 if(Date.now()>access.expiresAt||!ctx.OPENID||ctx.APPID!==access.appid||hash!==access.tokenHash)return{ok:false,code:'FORBIDDEN'};
 const m=new CloudBase({envId:access.envId});
 try{
  let result;
  switch(event.action){
   case 'envelope': result={keys:Object.keys(event)};break;
   case 'inspect': result=await m.database.listCollections();break;
   case 'collection': {
    if(!manifest.collections.includes(event.name))throw Error('NOT_ALLOWLISTED');
    await m.database.createCollectionIfNotExists(event.name);
    result=await m.permission.modifyResourcePermission({resourceType:'collection',resource:event.name,permission:'ADMINONLY'});break;
   }
   case 'index': {
    const ix=manifest.indexes.find(x=>x.collection===event.collection&&x.name===event.name);if(!ix)throw Error('NOT_ALLOWLISTED');
    const exists=await m.database.checkIndexExists(ix.collection,ix.name);
    result=exists.Exists?{exists:true}:await m.database.updateCollection(ix.collection,{CreateIndexes:[{IndexName:ix.name,MgoKeySchema:{MgoIndexKeys:ix.keys.map(k=>({Name:k.field,Direction:k.direction==='asc'?'1':'-1'})),MgoIsUnique:ix.unique}}]});break;
   }
   case 'storageInspect': result=await m.storage.getStorageAcl({withRule:true});break;
   case 'storage': await m.storage.setStorageAcl('CUSTOM',manifest.storage);result=await m.storage.getStorageAcl({withRule:true});break;
   case 'functions': result=await m.permission.modifyResourcePermission({resourceType:'function',permission:'CUSTOM',securityRule:JSON.stringify({...manifest.functions,wefile_init:{invoke:'auth != null'}})});break;
   case 'permissions': result=await m.permission.describeResourcePermission({resourceType:event.kind==='function'?'function':'collection',...(event.kind==='function'?{}:{resources:manifest.collections})});break;
   case 'timer': {
    const info=await m.functions.getFunctionDetail('reminders');
    if(!(info.Triggers||[]).some(t=>t.TriggerName==='wefile-hourly'||t.Name==='wefile-hourly')) await m.functions.createFunctionTriggers('reminders',[{name:'wefile-hourly',type:'timer',config:'0 0 * * * * *'}]);
    const actual=await m.functions.getFunctionDetail('reminders');
    result={runtime:actual.Runtime,timeout:actual.Timeout,memorySize:actual.MemorySize,triggers:actual.Triggers};break;
   }
   case 'configure': {
    if(!['api','reminders'].includes(event.name)||typeof event.secret!=='string'||event.secret.length<40)throw Error('INVALID_CONFIG');
    const perms=await m.permission.describeResourcePermission({resourceType:'function'});
    const rows=(perms.Data||perms).PermissionList||[];
    const rule=JSON.parse(rows[0]?.SecurityRule||'{}');
    if(rule.reminders?.invoke!==false||rule['*']?.invoke!==false)throw Error('PLATFORM_RULES_NOT_LOCKED');
    result=await m.functions.updateFunctionConfig({name:event.name,timeout:60,memorySize:512,envVariables:{WATERMARK_SECRET:event.secret,WEFILE_READ_ONLY:'false',WEFILE_FILES_ENABLED:'false',REMINDERS_PLATFORM_LOCKED:'true'}});break;
   }
   case 'finish': await m.permission.modifyResourcePermission({resourceType:'function',permission:'CUSTOM',securityRule:JSON.stringify(manifest.functions)});result=await m.functions.deleteFunction('wefile_init');break;
   default:throw Error('UNKNOWN_ACTION');
  }
  return{ok:true,result};
 }catch(e){return{ok:false,code:e.code||'INIT_FAILED',message:e.message};}
};
