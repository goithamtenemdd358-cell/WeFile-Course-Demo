'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Service}=require('../cloudfunctions/api/_shared/service');
const {id}=require('../cloudfunctions/api/_shared/core');
const {openDatabase}=require('./database.cjs'),{createStorage}=require('./storage.cjs');
function createServer(config){
 if(!config.bridgeSecret||config.bridgeSecret.length<40||!config.watermarkSecret||config.watermarkSecret.length<32)throw Error('Server secrets required');
 const db=openDatabase(path.join(config.dataDir,'wefile.sqlite'));const nonces=new Map();let timerBusy=false;
 const make=(actor)=>{const storage=createStorage({root:path.join(config.dataDir,'files'),secret:config.watermarkSecret,origin:config.origin,db,actor});return{storage,service:new Service(db,storage,{secret:config.watermarkSecret,filesEnabled:true})}};
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  const json=(status,obj)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(obj))};
  try{
   const url=new URL(req.url,'http://localhost');
   if(req.method==='GET'&&url.pathname==='/health')return json(200,{ok:true,service:'WeFile',backend:'selfhost'});
   if(req.method==='GET'&&url.pathname==='/files'){
    const {file,size}=make().storage.readTicket(url.searchParams.get('ticket'));res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':size,'Content-Disposition':'attachment'});fs.createReadStream(file).on('error',()=>res.destroy()).pipe(res);return;
   }
   if(req.method!=='POST'||url.pathname!=='/bridge')return json(404,{ok:false});
   const stamp=req.headers['x-wefile-time'],nonce=req.headers['x-wefile-nonce'],signature=req.headers['x-wefile-signature'];
   if(!/^\d{13}$/.test(stamp||'')||Math.abs(Date.now()-Number(stamp))>60000||!/^[a-f0-9]{32}$/.test(nonce||'')||typeof signature!=='string'||!/^([a-f0-9]{64})$/.test(signature))return json(401,{ok:false});
   let size=0;const chunks=[];for await(const b of req){size+=b.length;if(size>400000){json(413,{ok:false});return}chunks.push(b)}const body=Buffer.concat(chunks);
   const expected=crypto.createHmac('sha256',config.bridgeSecret).update(stamp+'\n'+nonce+'\n').update(body).digest('hex');
   if(!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))return json(401,{ok:false});
   for(const[k,v]of nonces)if(v<Date.now()-120000)nonces.delete(k);if(nonces.has(nonce))return json(409,{ok:false});nonces.set(nonce,Date.now());
   const envelope=JSON.parse(body);const {identity,event}=envelope;
   if(typeof identity!=='string'||!identity.startsWith(config.appid+':')||identity.length>200||!event||typeof event.action!=='string')return json(400,{ok:false});
   const actor=id('user',identity),{service,storage}=make(actor);
   if(event.action==='transport.upload'){const data=await storage.upload(service,event.payload);return json(200,{ok:true,data})}
   if(event.action==='transport.download'){const data=await storage.download(event.payload);return json(200,{ok:true,data})}
   return json(200,await service.invoke(identity,event));
  }catch(e){if(res.headersSent)return res.destroy();json(req.method==='GET'?403:200,{ok:false,error:{code:e.code||'INTERNAL_ERROR',message:e.code?'文件不可访问或请求状态已变化':'服务暂时不可用，请稍后重试',retryable:!e.code},serverNow:Date.now()})}
 });
 server.requestTimeout=20000;server.headersTimeout=10000;
 const interval=setInterval(async()=>{if(timerBusy)return;timerBusy=true;try{await make('SYSTEM').service.reminders()}catch{console.error('reminders failed')}finally{timerBusy=false}},3600000);interval.unref();
 return{server,db,close:async()=>{clearInterval(interval);await new Promise(r=>server.close(r));await db.close()}};
}
if(require.main===module){const config=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../artifacts/selfhost-config.json'),'utf8'));const app=createServer(config);app.server.listen(config.port||18766,'127.0.0.1',()=>console.log('WeFile selfhost listening on loopback'));process.on('SIGINT',async()=>{await app.close();process.exit()})}
module.exports={createServer};
