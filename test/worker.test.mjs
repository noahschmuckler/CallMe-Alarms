import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDB} from './d1.mjs';
import worker,{tick,followUp,spoken,nextStep,parsePlan,approvePlan} from '../src/worker.js';

// 2026-12-01 is a Tuesday. 11:00 UTC = 6:00 AM New York (EST).
const T0=Date.parse('2026-12-01T11:00:00Z');
const MIN=60000;
function setup(schema='schema.sql'){
  const DB=makeDB(schema);
  if(schema!=='schema.sql')DB.raw.exec((await_read('migrations/0001_snooze_retry_plans.sql')));
  DB.raw.exec("UPDATE settings SET paused=0");
  return {DB,CALLME_SECRET:'x',PLAN_TOKEN:'plan-secret',UI_PASSWORD:'pw'};
}
import {readFileSync} from 'node:fs';
const await_read=f=>readFileSync(f,'utf8');
function addSchedule(env,o={}){
  const s={id:'s1',label:'Morning wake',at:'06:00',days:'0,1,2,3,4',once_date:'',message:'Good morning Noah.',repeats:1,enabled:1,created_at:'x',
    snooze_minutes:30,max_snoozes:1,retry_minutes:5,max_retries:2,source:'ui',...o};
  env.DB.raw.prepare(`INSERT INTO schedules(${Object.keys(s)}) VALUES(${Object.keys(s).map(()=>'?')})`).run(...Object.values(s));
  return s;
}
// Fake CallMe backend: records placed calls; status per call set by the test.
function backend(){
  const calls=[];const status={};
  const dispatch=async(s,chain)=>{const id='c'+calls.length;calls.push({id,message:s.message,chain});return id;};
  const fetcher=async url=>{const id=url.split('/').pop();return {ok:true,json:async()=>status[id]||{status:'in-progress'}};};
  return {calls,status,dispatch,fetcher};
}
const runs=env=>env.DB.raw.prepare('SELECT * FROM runs ORDER BY started_at,fire_key').all();
const fus=env=>env.DB.raw.prepare('SELECT * FROM followups ORDER BY due_at').all();

test('migration applies cleanly on the original production schema',()=>{
  const env=setup('test/schema-v0.sql');
  const cols=env.DB.raw.prepare("PRAGMA table_info(schedules)").all().map(c=>c.name);
  assert.ok(cols.includes('snooze_minutes')&&cols.includes('source'));
});

test('spoken menu offers snooze until the last call',()=>{
  const s={message:'Up.',snooze_minutes:30,max_snoozes:1};
  assert.match(spoken(s,0),/Press 2 to snooze for 30 minutes/);
  assert.match(spoken(s,1),/last call\. Press 1/);
  assert.equal(spoken({message:'Up.',snooze_minutes:0},0),'Up.');
});

test('press 2 -> one snooze 30 min after the original call, then press 1 ends it',async()=>{
  const env=setup();addSchedule(env);const b=backend();
  await tick(env,T0,b.dispatch);
  assert.equal(b.calls.length,1);assert.match(b.calls[0].message,/Press 2/);
  b.status.c0={status:'completed',digits:'2',acknowledged:false};
  await followUp(env,T0+MIN,b.fetcher);
  let f=fus(env);assert.equal(f.length,1);assert.equal(f[0].kind,'snooze');assert.equal(f[0].due_at,'2026-12-01T11:30:00.000Z');
  assert.match(runs(env)[0].result,/snoozed until 6:30/);
  await followUp(env,T0+2*MIN,b.fetcher);           // decided runs are not re-queued
  assert.equal(fus(env).length,1);
  await tick(env,T0+29*MIN,b.dispatch);assert.equal(b.calls.length,1);   // not yet
  await tick(env,T0+30*MIN,b.dispatch);assert.equal(b.calls.length,2);
  assert.match(b.calls[1].message,/last call/);
  assert.deepEqual([b.calls[1].chain.kind,b.calls[1].chain.snoozes],['snooze',1]);
  b.status.c1={status:'completed',digits:'2',acknowledged:false};       // pressing 2 with no snoozes left = unanswered
  await followUp(env,T0+31*MIN,b.fetcher);
  f=fus(env);assert.equal(f.length,2);assert.equal(f[1].kind,'retry');
  await tick(env,T0+36*MIN,b.dispatch);assert.equal(b.calls.length,3);
  b.status.c2={status:'completed',digits:'1',acknowledged:true};
  await followUp(env,T0+37*MIN,b.fetcher);
  assert.equal(fus(env).length,2);
  assert.match(runs(env).at(-1).result,/acknowledged/);
});

test('unanswered -> retries every 5 minutes, at most max_retries times',async()=>{
  const env=setup();addSchedule(env,{snooze_minutes:0,max_snoozes:0});const b=backend();
  await tick(env,T0,b.dispatch);
  for(let i=0;i<4;i++){
    b.status['c'+i]={status:'no-answer'};
    const t=T0+(i*6+1)*MIN;
    await followUp(env,t,b.fetcher);
    await tick(env,t+5*MIN,b.dispatch);
  }
  assert.equal(b.calls.length,3);                    // original + 2 retries
  assert.deepEqual(fus(env).map(f=>f.retries),[1,2]);
});

test('master pause blocks follow-ups; they expire after 10 minutes',async()=>{
  const env=setup();addSchedule(env);const b=backend();
  await tick(env,T0,b.dispatch);b.status.c0={status:'completed',digits:'2'};
  await followUp(env,T0+MIN,b.fetcher);
  env.DB.raw.exec('UPDATE settings SET paused=1');
  await tick(env,T0+30*MIN,b.dispatch);
  env.DB.raw.exec('UPDATE settings SET paused=0');
  await tick(env,T0+41*MIN,b.dispatch);
  assert.equal(b.calls.length,1);assert.equal(fus(env)[0].status,'expired');
});

test('turning a schedule off cancels its pending snooze',async()=>{
  const env=setup();addSchedule(env);const b=backend();
  await tick(env,T0,b.dispatch);b.status.c0={status:'completed',digits:'2'};
  await followUp(env,T0+MIN,b.fetcher);
  const req=(path,body)=>new Request('https://x.dev'+path,{method:'POST',headers:{Authorization:'Basic '+btoa('owner:pw'),Origin:'https://x.dev','X-Alarm-UI':'1','Content-Type':'application/json'},body:JSON.stringify(body)});
  const r=await worker.fetch(req('/api/toggle',{id:'s1'}),env);assert.equal(r.status,200);
  assert.equal(fus(env)[0].status,'cancelled');
});

test('a one-time schedule still gets its snooze after it disables itself',async()=>{
  const env=setup();addSchedule(env,{days:'once',once_date:'2026-12-01'});const b=backend();
  await tick(env,T0,b.dispatch);b.status.c0={status:'completed',digits:'2'};
  await followUp(env,T0+MIN,b.fetcher);
  await tick(env,T0+30*MIN,b.dispatch);assert.equal(b.calls.length,2);
});

const plan={format:'callme-plan/1',title:'Week of Dec 7',note:'Clinic Mon, drive Tue.',calls:[
  {label:'Clinic wake',date:'2027-12-07',time:'05:45',say:'Clinic day. First patient at 8.',repeats:2,snooze_minutes:30,retry_minutes:5},
  {label:'Wind down',repeat:'weekdays',time:'22:00',say:'Time to wind down and tell Leslie good night.'},
]};

test('plan inbox: token required, problems listed, valid plan queued as pending',async()=>{
  const env=setup();
  const post=(body,token='plan-secret',type='application/json')=>worker.fetch(new Request('https://x.dev/inbox/plan',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':type},body}),env);
  assert.equal((await post(JSON.stringify(plan),'wrong')).status,401);
  const bad=await post(JSON.stringify({...plan,calls:[{label:'x',time:'25:00',say:'hi',date:'2027-01-01'}]}));
  assert.equal(bad.status,400);assert.match((await bad.json()).problems.join(' '),/calls\[0\]/);
  const ok=await post('Here is the plan:\n'+JSON.stringify(plan)+'\nThanks','plan-secret','text/plain');
  assert.equal(ok.status,202);
  const {plan_id}=await ok.json();
  const row=env.DB.raw.prepare('SELECT * FROM plans WHERE id=?').get(plan_id);
  assert.equal(row.status,'pending');
  assert.equal(env.DB.raw.prepare('SELECT count(*) n FROM schedules').get().n,0);   // nothing scheduled before approval
  const r=await approvePlan(env,plan_id,Date.parse('2027-12-01T12:00:00Z'));
  assert.match(r.result,/Added 2 of 2/);
  const s=env.DB.raw.prepare("SELECT * FROM schedules ORDER BY at").all();
  assert.deepEqual(s.map(x=>[x.at,x.days,x.enabled,x.snooze_minutes,x.max_snoozes,x.max_retries]),[['05:45','once',1,30,1,2],['22:00','0,1,2,3,4',1,0,0,0]]);
  assert.equal((await approvePlan(env,plan_id)).error!==undefined,true);   // only once
});

test('plan approval skips calls whose time has passed',async()=>{
  const env=setup();
  const p=parsePlan(JSON.stringify({...plan,calls:[{label:'Soon',date:'2099-01-01',time:'06:00',say:'Hi'}]}));
  env.DB.raw.prepare("INSERT INTO plans(id,received_at,title,note,calls) VALUES('p1','x','t','',?)").run(JSON.stringify([{...p.calls[0],once_date:'2020-01-01'}]));
  const r=await approvePlan(env,'p1');assert.match(r.result,/Added 0 of 1.*skipped 1/);
});

test('nextStep ignores test calls and acknowledged calls',()=>{
  assert.equal(nextStep(null,{},{status:'no-answer'},0),null);
  assert.equal(nextStep({retry_minutes:5,max_retries:2},{snoozes:0,retries:0},{digits:'1'},0),null);
});
