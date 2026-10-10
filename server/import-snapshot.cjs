'use strict';
const fs=require('node:fs'),path=require('node:path');
const {openDatabase}=require('./database.cjs');
async function importSnapshot(file,target){
 const snapshot=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));const names=require('../database/collections.json');
 if(!names.every(n=>Array.isArray(snapshot[n])))throw Error('All collection snapshots are required');
 if(snapshot.file_revisions.length||snapshot.upload_sessions.length)throw Error('Snapshot contains cloud files/upload sessions; migrate their bytes and references before importing');
 const db=openDatabase(target);try{await db.transaction(async tx=>{
  for(const name of names){if((await tx.query(name,{})).length)throw Error('Target must be empty; existing data will not be replaced')}
  for(const name of names)for(const row of snapshot[name]){if(!row||typeof row._id!=='string')throw Error('Invalid document');if(await tx.get(name,row._id))throw Error('Duplicate document');await tx.put(name,row._id,row)}
 });return Object.fromEntries(names.map(n=>[n,snapshot[n].length]));}finally{await db.close()}
}
if(require.main===module){const config=JSON.parse(fs.readFileSync('artifacts/selfhost-config.json'));importSnapshot(process.argv[2],path.join(config.dataDir,'wefile.sqlite')).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1})}
module.exports={importSnapshot};
