'use strict';
const https=require('https'),crypto=require('crypto');
function forward(config,identity,event){
 const origin=new URL(config.origin);if(origin.protocol!=='https:'||origin.username||origin.password)throw Error('HTTPS relay origin required');
 const body=Buffer.from(JSON.stringify({identity,event}));if(body.length>400000)return Promise.resolve({ok:false,error:{code:'INVALID_INPUT',message:'单次传输过大',retryable:false}});
 const stamp=String(Date.now()),nonce=crypto.randomBytes(16).toString('hex');
 const signature=crypto.createHmac('sha256',config.bridgeSecret).update(stamp+'\n'+nonce+'\n').update(body).digest('hex');
 return new Promise(resolve=>{
  const fail=()=>resolve({ok:false,error:{code:'INTERNAL_ERROR',message:'本机服务器暂时无法连接，请检查电脑和穿透服务是否运行',retryable:true},requestId:event.requestId||null,serverNow:Date.now()});
  const request=https.request(new URL('/bridge',origin),{method:'POST',headers:{'content-type':'application/json','content-length':body.length,'x-wefile-time':stamp,'x-wefile-nonce':nonce,'x-wefile-signature':signature,'ngrok-skip-browser-warning':'1'}},response=>{
   if(response.statusCode!==200){response.resume();return fail()}let size=0;const chunks=[];response.on('data',b=>{size+=b.length;if(size>2*1024*1024){response.destroy();fail()}else chunks.push(b)});response.on('error',fail);response.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString()))}catch{fail()}});
  });request.setTimeout(25000,()=>request.destroy());request.on('error',fail);request.end(body);
 });
}
module.exports={forward};
