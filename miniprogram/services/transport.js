const CHUNK=192*1024;
const pending=new Map();
async function invoke(action,payload){
 const response=await wx.cloud.callFunction({name:'api',data:{action,payload}});const r=response.result;
 if(!r||!r.ok)throw new Error(r&&r.error?r.error.message:'文件传输失败');return r.data;
}
async function upload(file,plan,progress){
 const fs=wx.getFileSystemManager();let offset=0,last;
 while(offset<file.size){
  const length=Math.min(CHUNK,file.size-offset);
  const base64=await new Promise((resolve,reject)=>fs.readFile({filePath:file.path,position:offset,length,encoding:'base64',success:r=>resolve(r.data),fail:reject}));
  let failure;for(let n=0;n<3;n++){try{last=await invoke('transport.upload',{uploadSessionId:plan.uploadSessionId,offset,base64});failure=null;break}catch(e){failure=e}}
  if(failure)throw failure;
  if(last.receivedBytes!==offset+length)throw new Error('上传进度不一致，请重新选择文件');
  offset=last.receivedBytes;if(progress)progress(Math.round(offset/file.size*100));
 }
 return{fileID:last.tempFileId};
}
async function download(ticket){
 const key=(getApp().globalData.user||{}).userId+'-'+ticket.sha256;
 if(pending.has(key))return pending.get(key);
 const work=(async()=>{
  const fs=wx.getFileSystemManager(),ext=ticket.name.split('.').pop().toLowerCase();
  if(!/^[a-f0-9]{64}$/.test(ticket.sha256)||!/^\w{1,8}$/.test(ext)||ticket.size>20*1024*1024)throw new Error('文件信息不正确');
  const filePath=wx.env.USER_DATA_PATH+'/wefile-'+key+'.'+ext;
  const mark='?ticket=',at=ticket.downloadUrl.indexOf(mark);if(at<0)throw new Error('下载凭据无效');const token=decodeURIComponent(ticket.downloadUrl.slice(at+mark.length));
  fs.writeFileSync(filePath,'');let offset=0;
  try{
   while(offset<ticket.size){const r=await invoke('transport.download',{ticket:token,offset});const bytes=wx.base64ToArrayBuffer(r.base64);if(r.offset!==offset||r.total!==ticket.size||!bytes.byteLength||offset+bytes.byteLength>ticket.size)throw new Error('下载数据不完整');fs.appendFileSync(filePath,bytes);offset+=bytes.byteLength;}
   return filePath;
  }catch(e){try{fs.unlinkSync(filePath)}catch(ignore){}throw e}
 })();pending.set(key,work);try{return await work}finally{pending.delete(key)}
}
function clear(){const fs=wx.getFileSystemManager();for(const name of fs.readdirSync(wx.env.USER_DATA_PATH)){if(/^wefile-[a-f0-9]+-[a-f0-9]{64}\.\w{1,8}$/.test(name)){try{fs.unlinkSync(wx.env.USER_DATA_PATH+'/'+name)}catch(e){}}}}
module.exports={upload,download,clear};
