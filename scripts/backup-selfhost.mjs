import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
const root=path.resolve(import.meta.dirname,'..');
const config=JSON.parse(fs.readFileSync(path.join(root,'artifacts/selfhost-config.json'),'utf8'));
const destination=path.join(root,'backups','selfhost-'+new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(destination,{recursive:true});
const source=new DatabaseSync(path.join(config.dataDir,'wefile.sqlite'),{readOnly:true});
try{await backup(source,path.join(destination,'wefile.sqlite'))}finally{source.close()}
const copy=new DatabaseSync(path.join(destination,'wefile.sqlite'),{readOnly:true});
try{
 if(copy.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('SQLite integrity failed');
 const revisions=copy.prepare("SELECT body FROM documents WHERE collection='file_revisions'").all().map(r=>JSON.parse(r.body));
 const files=[];
 // Back up immutable sealed objects only. In-progress uploads must be selected again after restore.
 const objects=path.join(config.dataDir,'files','objects');
 function collect(dir){if(!fs.existsSync(dir))return;for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())collect(p);else if(e.isFile()){const relative=path.relative(config.dataDir,p),target=path.join(destination,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(p,target,fs.constants.COPYFILE_EXCL);const bytes=fs.readFileSync(target);files.push({path:relative.replaceAll('\\','/'),bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')})}else throw Error('Unexpected storage entry')}}
 collect(objects);
 for(const r of revisions){if(!r.blobId)continue;if(!r.blobId.startsWith('local://sealed/'))throw Error('Unexpected non-local revision');const entry=files.find(f=>f.path==='files/objects/'+r.blobId.slice(8));if(!entry||entry.sha256!==r.sha256||entry.bytes!==r.size)throw Error('Backed-up revision bytes do not match database')}
 fs.copyFileSync(path.join(root,'artifacts/selfhost-config.json'),path.join(destination,'selfhost-config.private.json'),fs.constants.COPYFILE_EXCL);
 const result={at:new Date().toISOString(),status:'PASS',sqliteIntegrity:'ok',documents:copy.prepare('SELECT COUNT(*) AS n FROM documents').get().n,sealedFiles:files.length,revisionsChecked:revisions.length,files,restoreNote:'Stop local server, preserve current data directory, restore database and files into a new directory, update private dataDir. Incomplete uploads must restart. This backup contains private data and a private signing key; never publish.'};
 fs.writeFileSync(path.join(destination,'manifest.json'),JSON.stringify(result,null,2)+'\n');
 fs.writeFileSync(path.join(root,'docs/SELFHOST_BACKUP_RESULT.json'),JSON.stringify({at:result.at,status:'PASS',sqliteIntegrity:'ok',documents:result.documents,sealedFiles:files.length,revisionsChecked:revisions.length,scope:'Online SQLite backup opened independently, integrity checked, sealed bytes checked against revisions. No production overwrite or full service restore.'},null,2)+'\n');
 console.log('Verified private backup: '+destination);
}finally{copy.close()}
