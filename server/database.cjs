'use strict';
const {DatabaseSync}=require('node:sqlite');
const {AsyncLocalStorage}=require('node:async_hooks');
const fs=require('node:fs'),path=require('node:path');
const collections=new Set(require('../database/collections.json'));
function openDatabase(file){
 fs.mkdirSync(path.dirname(file),{recursive:true});const sql=new DatabaseSync(file);
 sql.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS documents(collection TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(collection,id))');
 const context=new AsyncLocalStorage();let queue=Promise.resolve();
 function serialized(fn){if(context.getStore())return Promise.resolve().then(fn);const p=queue.then(()=>context.run(true,fn));queue=p.catch(()=>{});return p;}
 function valid(c){if(!collections.has(c))throw Error('Unknown collection');}
 const db={
  get:(c,k)=>serialized(()=>{valid(c);const r=sql.prepare('SELECT body FROM documents WHERE collection=? AND id=?').get(c,k);return r?JSON.parse(r.body):null}),
  put:(c,k,v)=>serialized(()=>{valid(c);if(v._id!==k)throw Error('Document identity mismatch');sql.prepare('INSERT INTO documents VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET body=excluded.body').run(c,k,JSON.stringify(v))}),
  query:(c,where)=>serialized(()=>{valid(c);return sql.prepare('SELECT body FROM documents WHERE collection=? ORDER BY id').all(c).map(r=>JSON.parse(r.body)).filter(r=>Object.entries(where).every(([k,v])=>r[k]===v))}),
  transaction:fn=>serialized(async()=>{if(sql.isTransaction)throw Error('Nested transaction');sql.exec('BEGIN IMMEDIATE');try{const result=await fn(db);sql.exec('COMMIT');return result}catch(e){sql.exec('ROLLBACK');throw e}}),
  close:()=>serialized(()=>sql.close()),
  snapshot:()=>serialized(()=>Object.fromEntries([...collections].map(c=>[c,sql.prepare('SELECT body FROM documents WHERE collection=?').all(c).map(r=>JSON.parse(r.body))])))
 };return db;
}
module.exports={openDatabase};
