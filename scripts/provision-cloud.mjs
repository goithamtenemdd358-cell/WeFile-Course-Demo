import fs from 'node:fs';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),automator=require('miniprogram-automator');
const access=JSON.parse(fs.readFileSync('artifacts/deploy-access.json','utf8'));
const manifest=JSON.parse(fs.readFileSync('artifacts/deploy/wefile_init/manifest.json','utf8'));
const mode=process.argv[2];
if(!['database','storage','configure','timer','inspect','finish'].includes(mode))throw Error('Usage: node scripts/provision-cloud.mjs database|storage|configure|timer|inspect|finish');
let jobs=[];
if(mode==='database')jobs=[...manifest.collections.map(name=>({action:'collection',name})),...manifest.indexes.map(x=>({action:'index',name:x.name,collection:x.collection})),{action:'permissions',kind:'collection'}];
else if(mode==='configure'){
 const file='artifacts/cloud-private-config.json';
 const privateConfig=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{watermarkSecret:crypto.randomBytes(32).toString('hex')};
 fs.writeFileSync(file,JSON.stringify(privateConfig));
 jobs=[{action:'functions'},...['api','reminders'].map(name=>({action:'configure',name,secret:privateConfig.watermarkSecret})),{action:'permissions',kind:'function'}];
}else if(mode==='inspect')jobs=[{action:'inspect'},{action:'storageInspect'},{action:'permissions',kind:'collection'},{action:'permissions',kind:'function'}];
else jobs=[{action:mode}];
const result={at:new Date().toISOString(),environment:access.envId,mode,steps:[],status:'RUNNING'};
let mp;const timeout=setTimeout(()=>{result.status='FAIL';result.error='Timeout; inspect cloud state before retrying';save();process.exit(1)},180000);
function save(){fs.writeFileSync(`artifacts/provision-${mode}.json`,JSON.stringify(result,null,2)+'\n')}
try{
 mp=await automator.connect({wsEndpoint:'ws://127.0.0.1:9420'});
 for(const event of jobs){
  const response=await mp.evaluate(async(env,token,event)=>{wx.cloud.init({env});return(await wx.cloud.callFunction({name:'wefile_init',data:{...event,token}})).result},access.envId,access.token,event);
  const {secret,...safeEvent}=event;result.steps.push({event:safeEvent,response});save();
  console.log(JSON.stringify({event:safeEvent,response}));
  if(!response?.ok)throw Error(response?.message||response?.code||'Invalid response');
 }
 result.status='PASS';
}catch(e){result.status='FAIL';result.error=e.message;console.error(e.message)}finally{mp?.disconnect();clearTimeout(timeout);save();process.exit(result.status==='PASS'?0:1)}
