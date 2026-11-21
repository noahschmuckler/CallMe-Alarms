import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {makeDB} from './d1.mjs';
import worker,{tick,followUp,spoken} from '../src/worker.js';
import {submit,decideDraft,receipt,parseInstant} from '../src/intake.js';

const MIN=60000;
const T0=Date.parse('2026-12-01T11:00:00Z');   // Tue Dec 1 2026, 6:00 AM New York
function setup(schema='schema.sql'){
  const DB=makeDB(schema);
  if(schema!=='schema.sql')DB.raw.exec(readFileSync('migrations/0001_snooze_retry_proposals.sql','utf8'));
  DB.raw.exec('UPDATE settings SET paused=0');
  return {DB,CALLME_SECRET:'x',PLAN_TOKEN:'plan-secret',UI_PASSWORD:'pw'};
}
function addSchedule(env,o={}){
  const s={id:'s1',label:'Morning wake',at:'06:00',days:'0,1,2,3,4',once_date:'',message:'Good morning Noah.',repeats:1,enabled:1,created_at:'x',
    snooze_minutes:30,max_snoozes:1,retry_minutes:3,max_retries:0,until_ack:1,late_ok:0,source:'ui',...o};
  env.DB.raw.prepare(`INSERT INTO schedules(${Object.keys(s)}) VALUES(${Object.keys(s).map(()=>'?')})`).run(...Object.values(s));
  return s;
}
function backend(){
  const calls=[];const status={};
  const dispatch=async(s,chain)=>{const id='c'+calls.length;calls.push({id,sid:s.id,message:s.message,chain});return id;};
  const fetcher=async url=>{const id=url.split('/').pop();return {ok:true,json:async()=>status[id]||{status:'in-progress'}};};
  return {calls,status,dispatch,fetcher};
}
const all=(env,sql,...a)=>env.DB.raw.prepare(sql).all(...a);
const fus=env=>all(env,'SELECT * FROM followups ORDER BY due_at');
// Runs one minute of the scheduler: tick then follow-up, like the cron does.
async function minute(env,b,t){await tick(env,t,b.dispatch);await followUp(env,t,b.fetcher);}

test('migration: old production schema upgrades; quiet-hour schedules stay allowed; old runs never start follow-ups',()=>{
  const DB=makeDB('test/schema-v0.sql');
  DB.raw.exec("INSERT INTO schedules(id,label,at,days,message,repeats,enabled,created_at) VALUES('a','Late','23:00','0,1,2,3,4','x',1,1,'x'),('b','Day','07:00','0,1,2,3,4','x',1,1,'x')");
  DB.raw.exec("INSERT INTO runs(fire_key,schedule_id,label,started_at,result,call_id) VALUES('k','b','Day','2026-11-20T12:00:00Z','Call requested','c')");
  DB.raw.exec(readFileSync('migrations/0001_snooze_retry_proposals.sql','utf8'));
  assert.deepEqual(DB.raw.prepare('SELECT id,late_ok,snooze_minutes,until_ack FROM schedules ORDER BY id').all().map(r=>({...r})),[{id:'a',late_ok:1,snooze_minutes:0,until_ack:0},{id:'b',late_ok:0,snooze_minutes:0,until_ack:0}]);
  assert.equal(DB.raw.prepare('SELECT decided FROM runs').get().decided,1);
});

test('spoken menu: snooze first, then "getting out of bed" until 1 is pressed',()=>{
  const s={message:'Up.',snooze_minutes:30,max_snoozes:1,until_ack:1,retry_minutes:3};
  assert.match(spoken(s,{snoozes:0}),/Press 2 to snooze for 30 minutes/);
  assert.match(spoken(s,{snoozes:1}),/getting out of bed\. I'll keep calling/);
  assert.equal(spoken({message:'Up.'}),'Up.');
});

test('press 2 snoozes once; then hang-ups, voicemail and 2 keep it calling until 1 is pressed',async()=>{
  const env=setup();addSchedule(env);const b=backend();
  await minute(env,b,T0);                                   // call c0 at 6:00
  b.status.c0={status:'completed',digits:'2'};
  await minute(env,b,T0+MIN);
  assert.equal(fus(env)[0].kind,'snooze');assert.equal(fus(env)[0].due_at,'2026-12-01T11:31:00.000Z');   // 30 min after the keypress was seen
  for(let t=T0+2*MIN;t<T0+31*MIN;t+=MIN)await minute(env,b,t);
  assert.equal(b.calls.length,1);
  await minute(env,b,T0+31*MIN);assert.equal(b.calls.length,2);   // snoozed call
  assert.match(b.calls[1].message,/getting out of bed/);
  b.status.c1={status:'completed'};                         // hung up, no key
  await minute(env,b,T0+32*MIN);
  await minute(env,b,T0+35*MIN);assert.equal(b.calls.length,3);   // every 3 minutes
  b.status.c2={status:'completed',digits:'2'};              // 2 again: no snooze left, keeps calling
  await minute(env,b,T0+36*MIN);
  await minute(env,b,T0+39*MIN);assert.equal(b.calls.length,4);
  b.status.c3={status:'no-answer'};
  await minute(env,b,T0+40*MIN);
  await minute(env,b,T0+43*MIN);assert.equal(b.calls.length,5);
  b.status.c4={status:'completed',digits:'1',acknowledged:true};
  await minute(env,b,T0+44*MIN);
  for(let t=T0+45*MIN;t<T0+60*MIN;t+=MIN)await minute(env,b,t);
  assert.equal(b.calls.length,5);
  assert.deepEqual(all(env,'SELECT outcome FROM events ORDER BY id').map(e=>e.outcome),['snoozed','calling_again','calling_again','calling_again','acknowledged']);
});

test('keep calling stops after the 2-hour safety limit',async()=>{
  const env=setup();addSchedule(env,{snooze_minutes:0,max_snoozes:0,retry_minutes:10});const b=backend();
  for(let t=T0;t<=T0+150*MIN;t+=MIN){await minute(env,b,t);for(const c of b.calls)b.status[c.id]??={status:'no-answer'};}
  assert.equal(b.calls.length,11);                          // 6:00, then every 11 min (10 + 1 to see the result) until the 2-hour mark
  assert.equal(all(env,'SELECT outcome FROM events ORDER BY id DESC LIMIT 1')[0].outcome,'safety_stop');
});

test('quiet hours: repeat calls stop at 10:30 PM; root calls in quiet hours need explicit approval',async()=>{
  const env=setup();addSchedule(env,{at:'22:20',snooze_minutes:0,max_snoozes:0});
  addSchedule(env,{id:'s2',at:'23:00',until_ack:0,retry_minutes:0,snooze_minutes:0,max_snoozes:0});
  addSchedule(env,{id:'s3',at:'23:05',until_ack:0,retry_minutes:0,snooze_minutes:0,max_snoozes:0,late_ok:1});
  const b=backend();const t0=Date.parse('2026-12-02T03:20:00Z');   // Tue 10:20 PM
  for(let t=t0;t<=t0+50*MIN;t+=MIN){await minute(env,b,t);for(const c of b.calls)b.status[c.id]??={status:'no-answer'};}
  assert.equal(b.calls.filter(c=>c.sid==='s1').length,3);   // 10:20, 10:24, 10:28 PM; the 10:32 repeat is stopped
  assert.equal(all(env,"SELECT outcome FROM events WHERE schedule_id='s1' ORDER BY id DESC LIMIT 1")[0].outcome,'quiet_hours');
  assert.ok(all(env,"SELECT result FROM runs WHERE schedule_id='s2'")[0].result.startsWith('Skipped: quiet hours'));
  assert.equal(all(env,"SELECT count(*) n FROM runs WHERE schedule_id='s3' AND call_id IS NOT NULL")[0].n,1);
});

test('master pause blocks follow-ups; overdue ones expire instead of catching up',async()=>{
  const env=setup();addSchedule(env);const b=backend();
  await minute(env,b,T0);b.status.c0={status:'completed',digits:'2'};await minute(env,b,T0+MIN);
  env.DB.raw.exec('UPDATE settings SET paused=1');
  await minute(env,b,T0+31*MIN);
  env.DB.raw.exec('UPDATE settings SET paused=0');
  await minute(env,b,T0+42*MIN);
  assert.equal(b.calls.length,1);assert.equal(fus(env)[0].status,'expired');
});

test('"call again a few times" is bounded',async()=>{
  const env=setup();addSchedule(env,{snooze_minutes:0,max_snoozes:0,until_ack:0,retry_minutes:5,max_retries:2});const b=backend();
  for(let t=T0;t<=T0+40*MIN;t+=MIN){await minute(env,b,t);for(const c of b.calls)b.status[c.id]??={status:'no-answer'};}
  assert.equal(b.calls.length,3);
});

// ---------- proposals ----------
const NOW=Date.parse('2026-12-05T15:00:00Z');
const create=(o={})=>({version:1,action:'create',command_id:'cmd-1',reminder_id:'rem-trash-1207',label:'Trash out',
  call_at:'2026-12-07T19:30:00-05:00',timezone:'America/New_York',message:'You planned to take out the trash.',
  policy:{snooze_minutes:30,max_snoozes:1,if_unacknowledged:'keep_calling',retry_every_minutes:3},...o});
const post=(env,body)=>submit(env,typeof body==='string'?body:JSON.stringify(body),'transport',NOW);
async function rejects(p,status,re){try{await p;assert.fail('accepted');}catch(e){if(e.code==='ERR_ASSERTION')throw e;assert.equal(e.status,status);if(re)assert.match(e.problems.join(' '),re);}}

test('times: offset must match New York; DST gaps and repeated hours rejected',()=>{
  assert.equal(parseInstant('2026-12-07T19:30:00-05:00','t').at,'19:30');
  assert.throws(()=>parseInstant('2026-12-07T19:30:00-04:00','t'),/not a valid America\/New_York time/);
  assert.throws(()=>parseInstant('2027-03-14T02:30:00-05:00','t'),/not a valid/);      // spring-forward gap
  assert.throws(()=>parseInstant('2026-11-01T01:30:00-04:00','t'),/repeated hour/);     // fall-back overlap
  assert.throws(()=>parseInstant('2026-12-07T19:30:00Z','t'),/numeric UTC offset/);
});

test('intake rejects forged approval fields, quiet hours, extra snoozes and past times; stages nothing',async()=>{
  const env=setup();
  await rejects(post(env,create({approved:true})),400,/does not accept: approved/);
  await rejects(post(env,create({policy:{snooze_minutes:30,max_snoozes:2}})),400,/max_snoozes/);
  await rejects(post(env,create({call_at:'2026-12-07T23:00:00-05:00'})),400,/quiet hours/);
  await rejects(post(env,create({call_at:'2026-12-05T09:00:00-05:00'})),400,/future/);
  await rejects(post(env,create({policy:undefined})),400,/policy/);
  await rejects(post(env,create({message:'x',policy:{},destination:'+15550001111'})),400,/destination/);
  assert.equal(all(env,'SELECT count(*) n FROM drafts')[0].n,0);
  const ok=await post(env,create({call_at:'2026-12-07T23:00:00-05:00',policy:{allow_quiet_hours:true}}));
  assert.equal(ok.status,202);
});

test('intake stages an inert draft; duplicates converge; reused ids with new content conflict',async()=>{
  const env=setup();
  const r=await post(env,create());
  assert.equal(r.status,202);assert.equal(r.body.receipts[0].state,'draft_received');
  assert.equal(all(env,'SELECT count(*) n FROM schedules')[0].n,0);
  const again=await submit(env,'Proposal below\n'+JSON.stringify(create()),'paste',NOW);   // same command pasted by hand
  assert.equal(again.status,200);assert.equal(again.body.receipts[0].duplicate,true);
  assert.equal(all(env,'SELECT count(*) n FROM drafts')[0].n,1);
  await rejects(post(env,create({message:'Changed'})),409,/command_id "cmd-1" was already used/);
  await rejects(post(env,create({command_id:'cmd-2',message:'Changed'})),409,/reminder_id "rem-trash-1207" already exists/);
});

test('approval binds to the reviewed content, runs once, and gives an honest receipt',async()=>{
  const env=setup();
  const {body}=await post(env,{version:1,title:'Monday',commands:[create(),create({command_id:'cmd-b',reminder_id:'rem-b',call_at:'2026-12-08T06:00:00-05:00',label:'Wake'})]});
  const d=all(env,'SELECT * FROM drafts')[0];
  assert.match((await decideDraft(env,d.id,'wrong-hash',true,NOW)).error,/changed since you opened it/);
  env.DB.raw.exec('UPDATE settings SET paused=1');
  const a=await decideDraft(env,d.id,d.hash,true,NOW);assert.ok(a.ok);
  assert.match((await decideDraft(env,d.id,d.hash,true,NOW)).error,/no longer waiting/);    // double click
  const s=all(env,"SELECT * FROM schedules WHERE reminder_id='rem-trash-1207'")[0];
  assert.deepEqual([s.once_date,s.at,s.enabled,s.snooze_minutes,s.until_ack,s.retry_minutes,s.late_ok],['2026-12-07','19:30',1,30,1,3,0]);
  assert.equal((await receipt(env,'cmd-1')).state,'saved_inactive');
  env.DB.raw.exec('UPDATE settings SET paused=0');
  const rc=await receipt(env,'cmd-1');assert.equal(rc.state,'armed');assert.equal(rc.schedule_revision,1);
  assert.equal(body.draft_id,d.id);
});

test('expired drafts and past-due calls are never scheduled or caught up',async()=>{
  const env=setup();
  await post(env,create());const d=all(env,'SELECT * FROM drafts')[0];
  const late=Date.parse('2026-12-08T01:00:00Z');                 // after 7:30 PM on Dec 7
  await decideDraft(env,d.id,d.hash,true,late);
  assert.equal(all(env,'SELECT count(*) n FROM schedules')[0].n,0);
  assert.equal((await receipt(env,'cmd-1')).state,'expired');
  const env2=setup();await post(env2,create());const d2=all(env2,'SELECT * FROM drafts')[0];
  assert.match((await decideDraft(env2,d2.id,d2.hash,true,NOW+8*86400000)).error,/expired/);
});

async function approved(env){
  await post(env,create());const d=all(env,"SELECT * FROM drafts WHERE status='pending'")[0];await decideDraft(env,d.id,d.hash,true,NOW);
}
const cancel=(o={})=>({version:1,action:'cancel',command_id:'cancel-1',reminder_id:'rem-trash-1207',expected_revision:1,...o});
const CALL=Date.parse('2026-12-08T00:30:00Z');                    // Dec 7, 7:30 PM

test('cancel before the call wins: it never rings; duplicate cancel is safe',async()=>{
  const env=setup();await approved(env);
  await post(env,cancel());const d=all(env,"SELECT * FROM drafts WHERE status='pending'")[0];
  await decideDraft(env,d.id,d.hash,true,NOW);
  assert.equal((await receipt(env,'cancel-1')).state,'cancelled');
  assert.equal((await receipt(env,'cmd-1')).state,'cancelled');
  const b=backend();await minute(env,b,CALL);assert.equal(b.calls.length,0);
  const dup=await post(env,cancel());assert.equal(dup.status,200);
});

test('cancel with a stale revision or unknown reminder changes nothing',async()=>{
  const env=setup();await approved(env);
  await rejects(post(env,cancel({reminder_id:'nope'})),409,/not an approved reminder/);
  env.DB.raw.exec("UPDATE schedules SET revision=2");               // Noah edited it in the app
  await rejects(post(env,cancel()),409,/revision 2, not 1/);
  assert.equal(all(env,'SELECT enabled FROM schedules')[0].enabled,1);
});

test('cancel while the call is ringing reports "too late", and stops further calls',async()=>{
  const env=setup();await approved(env);const b=backend();
  await minute(env,b,CALL);assert.equal(b.calls.length,1);         // call sent, not finished
  await post(env,cancel());const d=all(env,"SELECT * FROM drafts WHERE status='pending'")[0];
  await decideDraft(env,d.id,d.hash,true,NOW);
  assert.equal((await receipt(env,'cancel-1')).state,'cancel_too_late');
  b.status.c0={status:'no-answer'};
  for(let t=CALL+MIN;t<CALL+20*MIN;t+=MIN)await minute(env,b,t);
  assert.equal(b.calls.length,1);
});

test('receipt reports what happened on the call',async()=>{
  const env=setup();await approved(env);const b=backend();
  await minute(env,b,CALL);b.status.c0={status:'completed',digits:'1',acknowledged:true};await minute(env,b,CALL+MIN);
  const r=await receipt(env,'cmd-1');
  assert.equal(r.state,'called');assert.equal(r.events[0].outcome,'acknowledged');assert.equal(r.events[0].digits,'1');
});

test('inbox endpoint needs its token and never exposes the owner UI',async()=>{
  const env=setup();
  const req=(path,o={})=>worker.fetch(new Request('https://x.dev'+path,o),env);
  assert.equal((await req('/inbox/proposal',{method:'POST',body:'{}'})).status,401);
  assert.equal((await req('/inbox/proposal',{method:'POST',headers:{Authorization:'Bearer wrong'},body:'{}'})).status,401);
  const r=await req('/inbox/proposal',{method:'POST',headers:{Authorization:'Bearer plan-secret'},body:JSON.stringify(create({call_at:'2027-06-07T19:30:00-04:00'}))});
  assert.equal(r.status,202);
  const rc=await req('/inbox/receipt?command_id=cmd-1',{headers:{Authorization:'Bearer plan-secret'}});
  assert.equal((await rc.json()).state,'draft_received');
  assert.equal((await req('/api/state',{headers:{Authorization:'Bearer plan-secret'}})).status,401);
});

test('turning a schedule off in the app, even mid-call, stops all further calls',async()=>{
  const env=setup();addSchedule(env);const b=backend();
  await minute(env,b,T0);
  const req=new Request('https://x.dev/api/toggle',{method:'POST',headers:{Authorization:'Basic '+btoa('owner:pw'),Origin:'https://x.dev','X-Alarm-UI':'1','Content-Type':'application/json'},body:JSON.stringify({id:'s1'})});
  assert.equal((await worker.fetch(req,env)).status,200);
  b.status.c0={status:'no-answer'};
  for(let t=T0+MIN;t<T0+20*MIN;t+=MIN)await minute(env,b,t);
  assert.equal(b.calls.length,1);
});

test('owner form: quiet-hour times need the explicit checkbox',async()=>{
  const env=setup();
  const save=body=>worker.fetch(new Request('https://x.dev/api/save',{method:'POST',headers:{Authorization:'Basic '+btoa('owner:pw'),Origin:'https://x.dev','X-Alarm-UI':'1','Content-Type':'application/json'},
    body:JSON.stringify({label:'Late',at:'23:00',days:'0,1,2,3,4',message:'Hi',repeats:1,snooze_minutes:0,if_unacknowledged:'none',enabled:true,...body})}),env);
  const r=await save({});assert.equal(r.status,400);assert.match((await r.json()).error,/quiet hours/);
  assert.equal((await save({late_ok:true})).status,200);
});
