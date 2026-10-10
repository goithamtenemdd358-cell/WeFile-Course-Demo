'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {check,id,hash}=require('../cloudfunctions/api/_shared/core');
const MAX=20*1024*1024,CHUNK=192*1024;
function sign(data,key){const body=Buffer.from(JSON.stringify(data)).toString('base64url');return body+'.'+crypto.createHmac('sha256',key).update(body).digest('base64url')}
function verify(token,key){check(typeof token==='string'&&token.length<4096,'NOT_ACCESSIBLE');const [body,sig,...rest]=token.split('.');const expected=crypto.createHmac('sha256',key).update(body||'').digest('base64url');check(!rest.length&&sig&&sig.length===expected.length&&crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)),'NOT_ACCESSIBLE');let d;try{d=JSON.parse(Buffer.from(body,'base64url'))}catch{check(false,'NOT_ACCESSIBLE')}check(d.expiresAt>Date.now(),'NOT_ACCESSIBLE');return d}
function createStorage({root,secret,origin,db,actor}){
 fs.mkdirSync(root,{recursive:true});
 const safe=(base,relative)=>{check(typeof relative==='string'&&/^[a-zA-Z0-9_./-]+$/.test(relative)&&!relative.split('/').includes('..'),'NOT_ACCESSIBLE');const p=path.resolve(root,base,relative);check(p.startsWith(path.resolve(root,base)+path.sep),'NOT_ACCESSIBLE');return p};
 const storage={
  async upload(service,p){
   check(p&&/^[a-f0-9]{32}$/.test(p.uploadSessionId)&&Number.isInteger(p.offset)&&p.offset>=0&&typeof p.base64==='string'&&p.base64.length<=CHUNK*4/3+8,'INVALID_INPUT');
   const bytes=Buffer.from(p.base64,'base64');check(bytes.length>0&&bytes.length<=CHUNK&&bytes.toString('base64')===p.base64,'INVALID_INPUT');
   return db.transaction(async tx=>{
    const c=service.ctx(tx,actor),s=await c.get('upload_sessions',p.uploadSessionId);check(s.actorId===actor&&s.state==='OPEN'&&s.expiresAt>Date.now(),'NOT_ACCESSIBLE');await c.uploadScope(s);
    const received=s.receivedBytes||0;check(p.offset<=received&&p.offset+bytes.length<=Math.min(MAX,s.sizeHint),'INVALID_INPUT');
    const part=safe('chunks',s._id+'/'+p.offset+'.part');fs.mkdirSync(path.dirname(part),{recursive:true});
    if(fs.existsSync(part)){check(hash(fs.readFileSync(part))===hash(bytes),'IDEMPOTENCY_CONFLICT');if(p.offset<received)return{receivedBytes:received,tempFileId:'local://'+s.tempPath};}
    else{check(p.offset===received,'INVALID_INPUT');fs.writeFileSync(part,bytes,{flag:'wx',flush:true});}
    check(p.offset===received,'INVALID_INPUT');s.receivedBytes=received+bytes.length;await tx.put('upload_sessions',s._id,s);
    return{receivedBytes:s.receivedBytes,tempFileId:'local://'+s.tempPath};
   });
  },
  async readTemporary(fileId,tempPath,max){
   check(fileId==='local://'+tempPath,'NOT_ACCESSIBLE');const parts=tempPath.split('/');check(parts.length===4&&parts[0]==='staging'&&parts[1]===actor,'NOT_ACCESSIBLE');
   const session=await db.get('upload_sessions',parts[2]);check(session&&session.tempPath===tempPath&&session.actorId===actor&&session.state==='SEALING','NOT_ACCESSIBLE');
   const folder=safe('chunks',parts[2]);const chunks=fs.readdirSync(folder).filter(x=>/^\d+\.part$/.test(x)).sort((a,b)=>parseInt(a)-parseInt(b));let offset=0;const buffers=[];
   for(const name of chunks){check(parseInt(name)===offset,'UPLOAD_NOT_READY');const bytes=fs.readFileSync(path.join(folder,name));offset+=bytes.length;check(offset<=max,'FILE_TOO_LARGE');buffers.push(bytes)}
   check(offset>0&&offset===session.receivedBytes&&offset===session.sizeHint,'UPLOAD_NOT_READY');return Buffer.concat(buffers);
  },
  async seal(cloudPath,bytes){check(cloudPath.startsWith('sealed/'),'NOT_ACCESSIBLE');const f=safe('objects',cloudPath);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,bytes,{flag:'wx',flush:true});return'local://'+cloudPath},
  async ticket(blobId){check(blobId.startsWith('local://sealed/'),'NOT_ACCESSIBLE');const expiresAt=Date.now()+300000;const token=sign({blobId,actor,expiresAt},secret);return{url:origin+'/files?ticket='+encodeURIComponent(token),expiresAt}},
  readTicket(token,requestActor){const t=verify(token,secret);check(!requestActor||t.actor===requestActor,'NOT_ACCESSIBLE');check(t.blobId.startsWith('local://sealed/'),'NOT_ACCESSIBLE');const file=safe('objects',t.blobId.slice(8));return{file,size:fs.statSync(file).size}},
  async download(p){check(p&&Number.isInteger(p.offset)&&p.offset>=0,'INVALID_INPUT');const f=storage.readTicket(p.ticket,actor);check(p.offset<f.size&&f.size<=MAX,'INVALID_INPUT');const bytes=Buffer.alloc(Math.min(CHUNK,f.size-p.offset));const fd=fs.openSync(f.file,'r');try{fs.readSync(fd,bytes,0,bytes.length,p.offset)}finally{fs.closeSync(fd)}return{base64:bytes.toString('base64'),offset:p.offset,total:f.size}}
 };return storage;
}
module.exports={createStorage,sign,verify,CHUNK};
