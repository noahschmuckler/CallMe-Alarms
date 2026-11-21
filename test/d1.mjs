// Minimal D1 stand-in backed by node:sqlite, enough for the worker's queries.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
export function makeDB(schemaFile){
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(schemaFile,'utf8'));
  const stmt=(sql,args=[])=>({
    bind:(...a)=>stmt(sql,a),
    first:async()=>db.prepare(sql).get(...args)??null,
    all:async()=>({results:db.prepare(sql).all(...args)}),
    run:async()=>({meta:{changes:Number(db.prepare(sql).run(...args).changes)}}),
  });
  return {raw:db,prepare:sql=>stmt(sql),batch:async list=>{db.exec('BEGIN');try{const r=[];for(const s of list)r.push(await s.run());db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
}
