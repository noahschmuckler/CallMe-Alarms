import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {makeDB} from './d1.mjs';
import worker,{tick,followUp,spoken,placeCall} from '../src/worker.js';
import {callOptions} from '../src/policy.js';
import {buildReport,isoNY} from '../src/report.js';
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
  DB.raw.exec(readFileSync('migrations/0002_replace_command.sql','utf8'));
  assert.deepEqual(DB.raw.prepare('SELECT id,late_ok,snooze_minutes,until_ack FROM schedules ORDER BY id').all().map(r=>({...r})),[{id:'a',late_ok:1,snooze_minutes:0,until_ack:0},{id:'b',late_ok:0,snooze_minutes:0,until_ack:0}]);
  assert.equal(DB.raw.prepare('SELECT decided FROM runs').get().decided,1);
});

test('spoken menu: snooze first, then "getting out of bed" until 1 is pressed',()=>{
  const s={message:'Up.',snooze_minutes:30,max_snoozes:1,until_ack:1,retry_minutes:3};
  assert.match(spoken(s,{snoozes:0}),/Press 2 to snooze for 30 minutes/);
  assert.match(spoken(s,{snoozes:1}),/getting out of bed\. I'll keep calling/);
  assert.equal(spoken({message:'Up.'}),'Up. Press 3 to leave a spoken update.');
  assert.match(spoken(s,{snoozes:0}),/minutes\. Press 3 to leave a spoken update\.$/);
});

test('call options: snooze time only while a snooze is on offer, press 3 always, never a snooze promise on tests',()=>{
  const s={message:'Up.',snooze_minutes:30,max_snoozes:1,until_ack:1,retry_minutes:3};
  assert.deepEqual(callOptions(s,{snoozes:0}),{spoken_update:true,snooze_minutes:30});
  assert.deepEqual(callOptions(s,{snoozes:1}),{spoken_update:true});
  assert.deepEqual(callOptions(s,{snoozes:0},{test:true}),{spoken_update:true});
  assert.deepEqual(callOptions({message:'x'}),{spoken_update:true});
});

test('placeCall sends the keypad options to the backend',async()=>{
  let body;const orig=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{body=JSON.parse(init.body);return {status:202,json:async()=>({call_id:'c9'})};};
  try{await placeCall({CALLME_SECRET:'x'},{id:'s1',reminder_id:'rem-1',revision:2,message:'Hi',repeats:1,call_options:{spoken_update:true,snooze_minutes:30}});}
  finally{globalThis.fetch=orig;}
  assert.equal(body.snooze_minutes,30);assert.equal(body.spoken_update,true);assert.equal(body.metadata.alarm_schedule_id,'s1');
  assert.equal(body.metadata.reminder_id,'rem-1');assert.equal(body.metadata.schedule_revision,2);
});

test('snooze call goes out at the time the call announced',async()=>{
  const env=setup();addSchedule(env);const b=backend();
  await minute(env,b,T0);
  b.status.c0={status:'completed',digits:'2',snooze_until:'2026-12-01T11:31:00Z'};   // said "6:31 AM"
  await minute(env,b,T0+3*MIN);                              // result seen late
  assert.equal(fus(env)[0].due_at,'2026-12-01T11:31:00.000Z');
});

test('press 3 (spoken update) counts as an answer: no more calls',async()=>{
  const env=setup();addSchedule(env);const b=backend();
  await minute(env,b,T0);
  b.status.c0={status:'completed',digits:'3',acknowledged:true};
  for(let t=T0+MIN;t<T0+40*MIN;t+=MIN)await minute(env,b,t);
  assert.equal(b.calls.length,1);assert.equal(fus(env).length,0);
  assert.deepEqual(all(env,'SELECT outcome FROM events').map(e=>e.outcome),['spoken_update']);
  assert.match(all(env,'SELECT result FROM runs')[0].result,/spoken update recorded/);
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

const replace=(o={})=>({version:1,action:'replace',command_id:'chg-1',reminder_id:'rem-trash-1207',expected_revision:1,new_reminder_id:'rem-trash-1207-b',
  label:'Trash out (later)',call_at:'2026-12-07T20:15:00-05:00',timezone:'America/New_York',message:'Trash, take two.',policy:{},...o});
async function approveLatest(env,now=NOW){const d=all(env,"SELECT * FROM drafts WHERE status='pending'")[0];return decideDraft(env,d.id,d.hash,true,now);}

test('replace swaps the reminder in one step: old never rings, new one rings at the new time',async()=>{
  const env=setup();await approved(env);
  const r=await post(env,replace());assert.equal(r.status,202);assert.equal(r.body.receipts[0].state,'draft_received');
  assert.equal(all(env,'SELECT title FROM drafts WHERE status=\'pending\'')[0].title,'Change: Trash out (later)');
  assert.equal(all(env,'SELECT count(*) n FROM schedules WHERE enabled=1')[0].n,1);          // staging changes nothing
  assert.match((await approveLatest(env)).result,/changed/);
  const rc=await receipt(env,'chg-1');
  assert.deepEqual([rc.state,rc.new_reminder_id,rc.replaced_reminder_id,rc.schedule_revision,rc.call_at],['armed','rem-trash-1207-b','rem-trash-1207',1,'2026-12-07T20:15:00-05:00']);
  const old=await receipt(env,'cmd-1');assert.equal(old.state,'replaced');assert.equal(old.replaced_by,'rem-trash-1207-b');
  const b=backend();
  await minute(env,b,CALL);assert.equal(b.calls.length,0);                  // 7:30 PM: old reminder is gone
  await minute(env,b,CALL+45*MIN);assert.equal(b.calls.length,1);           // 8:15 PM: new one rings
  assert.match(b.calls[0].message,/^Trash, take two\./);
  b.status.c0={status:'completed',digits:'1',acknowledged:true};await minute(env,b,CALL+46*MIN);
  assert.equal((await receipt(env,'chg-1')).events[0].outcome,'acknowledged');
});

test('replace while the old call is ringing changes nothing and says so',async()=>{
  const env=setup();await approved(env);const b=backend();
  await minute(env,b,CALL);assert.equal(b.calls.length,1);                  // old call in progress
  await post(env,replace({call_at:'2026-12-07T21:00:00-05:00'}));
  assert.match((await approveLatest(env,CALL+10000)).result,/nothing changed/);
  const rc=await receipt(env,'chg-1');assert.equal(rc.state,'too_late');
  assert.equal(all(env,"SELECT count(*) n FROM reminders WHERE reminder_id='rem-trash-1207-b'")[0].n,0);
  assert.equal(all(env,"SELECT count(*) n FROM schedules WHERE reminder_id='rem-trash-1207-b'")[0].n,0);
  assert.equal((await receipt(env,'cmd-1')).state!=='replaced',true);
});

test('replace also stops a queued snooze or repeat call of the old reminder',async()=>{
  const env=setup();await approved(env);const b=backend();
  await minute(env,b,CALL);b.status.c0={status:'completed',digits:'2'};await minute(env,b,CALL+MIN);
  assert.equal(all(env,"SELECT count(*) n FROM followups WHERE status='pending'")[0].n,1);      // snooze queued for 8:01
  await post(env,replace({call_at:'2026-12-07T21:00:00-05:00'}));
  assert.match((await approveLatest(env,CALL+2*MIN)).result,/changed/);
  assert.equal(all(env,"SELECT count(*) n FROM followups WHERE status='pending'")[0].n,0);
  for(let t=CALL+2*MIN;t<CALL+40*MIN;t+=MIN)await minute(env,b,t);
  assert.equal(b.calls.length,1);                                           // no snooze call
});

test('replace is refused for stale revisions, unknown or already-replaced reminders, and same ids',async()=>{
  const env=setup();await approved(env);
  await rejects(post(env,replace({new_reminder_id:'rem-trash-1207'})),400,/must differ/);
  await rejects(post(env,replace({reminder_id:'nope'})),409,/nothing to replace/);
  await rejects(post(env,replace({approved:true})),400,/does not accept: approved/);
  env.DB.raw.exec('UPDATE schedules SET revision=2');
  await rejects(post(env,replace()),409,/revision 2, not 1/);
  env.DB.raw.exec('UPDATE schedules SET revision=1');
  await post(env,replace());await approveLatest(env);
  await rejects(post(env,replace({command_id:'chg-2',new_reminder_id:'rem-c'})),409,/already replaced by rem-trash-1207-b/);
  await post(env,cancel());const c=await approveLatest(env);
  assert.equal((await receipt(env,'cancel-1')).state,'nothing_pending');
  await rejects(post(env,create({command_id:'cmd-x',reminder_id:'rem-trash-1207-b'})),409,/already exists/);
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

test('Check email now asks the helper script and reports what it staged',async()=>{
  const env={...setup(),HELPER_URL:'https://script.test/exec',HELPER_KEY:'hk'};
  let sent;const orig=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{sent={url,body:JSON.parse(init.body)};return {json:async()=>({ok:true,staged:1,already:0,problems:0,rejected:0})};};
  const auth={'Authorization':'Basic '+btoa('u:pw'),'X-Alarm-UI':'1','Content-Type':'application/json','Origin':'https://x'};
  try{
    const r=await worker.fetch(new Request('https://x/api/proposals/check',{method:'POST',headers:auth,body:'{}'}),env);
    assert.equal(r.status,200);const j=await r.json();assert.equal(j.staged,1);
    assert.deepEqual(sent.body,{check_key:'hk',action:'check'});assert.equal(sent.url,'https://script.test/exec');
    const st=await (await worker.fetch(new Request('https://x/api/state',{headers:auth}),env)).json();
    assert.equal(st.emailCheck,true);
    const off=await worker.fetch(new Request('https://x/api/proposals/check',{method:'POST',headers:auth,body:'{}'}),setup());
    assert.equal(off.status,409);
  }finally{globalThis.fetch=orig;}
});

test('Brain dump button places an immediate call where press 1 records a brain dump',async()=>{
  const env={...setup()};let body;const orig=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{body=JSON.parse(init.body);return {status:202,json:async()=>({call_id:'cbd'})};};
  const auth={'Authorization':'Basic '+btoa('u:pw'),'X-Alarm-UI':'1','Content-Type':'application/json','Origin':'https://x'};
  try{
    const r=await worker.fetch(new Request('https://x/api/braindump',{method:'POST',headers:auth,body:'{}'}),env);
    assert.equal(r.status,200);
    assert.deepEqual([body.message,body.spoken_update,body.update_digit,body.update_kind,body.snooze_minutes],
      ['Brain dump. Press 1 to start recording.',true,'1','brain_dump',undefined]);
    assert.equal(body.metadata.brain_dump,true);
    const again=await worker.fetch(new Request('https://x/api/braindump',{method:'POST',headers:auth,body:'{}'}),env);
    assert.equal(again.status,429);                                   // one per minute
    const run=all(env,"SELECT * FROM runs WHERE fire_key LIKE 'dump|%'")[0];
    assert.deepEqual([run.label,run.result,run.call_id,run.decided],['Brain dump','Brain dump call requested','cbd',1]);
    await followUp(env,Date.now(),async()=>{throw Error('must not poll');});   // never starts snooze/repeat logic
  }finally{globalThis.fetch=orig;}
});

test('a replaced reminder is shown as Replaced and cannot be turned on or edited again',async()=>{
  const env=setup();await approved(env);await post(env,replace());await approveLatest(env);
  const auth={'Authorization':'Basic '+btoa('u:pw'),'X-Alarm-UI':'1','Content-Type':'application/json','Origin':'https://x'};
  const st=await (await worker.fetch(new Request('https://x/api/state',{headers:auth}),env)).json();
  const [live,old]=st.schedules;                                     // retired ones listed last
  assert.deepEqual([live.reminder_status,live.enabled],['active',1]);
  assert.deepEqual([old.reminder_status,old.replaced_by,old.enabled],['replaced','rem-trash-1207-b',0]);
  const on=await worker.fetch(new Request('https://x/api/toggle',{method:'POST',headers:auth,body:JSON.stringify({id:old.id})}),env);
  assert.equal(on.status,409);
  assert.equal(all(env,'SELECT enabled FROM schedules WHERE id=?',old.id)[0].enabled,0);
  const ed=await worker.fetch(new Request('https://x/api/save',{method:'POST',headers:auth,body:JSON.stringify({...old,enabled:true})}),env);
  assert.equal(ed.status,409);
  const off=await worker.fetch(new Request('https://x/api/toggle',{method:'POST',headers:auth,body:JSON.stringify({id:live.id})}),env);
  assert.equal(off.status,200);                                     // the live one still works normally
});

const snapshot=env=>JSON.stringify(['settings','schedules','runs','followups','drafts','commands','reminders','events'].map(tb=>all(env,`SELECT * FROM ${tb} ORDER BY 1`)));

test('status report: empty database is a valid report with nothing pending or armed',async()=>{
  const env=setup();const {report,text}=await buildReport(env,NOW);
  assert.equal(report.version,1);assert.match(report.report_id,/^rpt_/);assert.match(report.generated_at,/-05:00$/);
  assert.deepEqual([report.pending_drafts.length,report.schedules.length,report.recent_calls.length,report.exceptions.length],[0,0,0,0]);
  assert.match(text,/Waiting for Noah's decision \(0\):\n- none/);assert.match(text,/Will ring \(0\)/);
});

test('status report covers drafts, armed and replaced reminders, queued snoozes, call outcomes and exceptions, and changes nothing',async()=>{
  const env=setup();await approved(env);                                  // armed 7:30 PM Dec 7
  await post(env,replace({policy:{snooze_minutes:30}}));await approveLatest(env);   // replaced by 8:15 PM reminder with snooze
  await post(env,create({command_id:'cmd-p',reminder_id:'rem-p',call_at:'2026-12-07T20:20:00-05:00',label:'Pending one'}));   // waiting, 5 min after the 8:15 one
  await post(env,cancel({command_id:'cancel-old',expected_revision:1}));  // targets the already-replaced reminder
  const b=backend();const T=Date.parse('2026-12-08T01:15:00Z');            // 8:15 PM: replacement rings
  await minute(env,b,T);b.status.c0={status:'completed',digits:'2'};await minute(env,b,T+MIN);   // pressed 2: snooze queued
  const before=snapshot(env);
  const {report,text}=await buildReport(env,T+2*MIN);
  assert.equal(snapshot(env),before);                                     // strictly read-only
  assert.equal(report.pending_drafts.length,2);
  const pend=report.pending_drafts.find(d=>d.commands[0].command_id==='cmd-p');assert.equal(pend.commands[0].call_at,'2026-12-07T20:20:00-05:00');
  const old=report.schedules.find(s=>s.reminder_id==='rem-trash-1207');assert.deepEqual([old.state,old.lineage.replaced_by],['replaced','rem-trash-1207-b']);
  const neu=report.schedules.find(s=>s.reminder_id==='rem-trash-1207-b');assert.equal(neu.lineage.replaces,'rem-trash-1207');
  assert.equal(report.queued_follow_ups[0].kind,'snooze');assert.equal(report.queued_follow_ups[0].reminder_id,'rem-trash-1207-b');
  const call=report.recent_calls[0];assert.deepEqual([call.keypad,call.app_action,call.derived.summary],['2','snoozed','answered, pressed 2']);
  assert.ok(call.next_call&&call.next_call.status==='pending');
  assert.ok(report.exceptions.some(e=>/cancel targets rem-trash-1207, which was already replaced by rem-trash-1207-b/.test(e)));
  assert.match(text,/CallMe status report rpt_/);assert.match(text,/Dispatched does not mean answered/);
});

test('status report flags unknown outcomes, close armed calls and pause; route sends via the helper only',async()=>{
  const env=setup();await approved(env);
  await post(env,create({command_id:'cmd-2',reminder_id:'rem-2',call_at:'2026-12-07T19:40:00-05:00',label:'Close one'}));await approveLatest(env);
  env.DB.raw.exec('UPDATE settings SET paused=1');
  let {report}=await buildReport(env,NOW);
  assert.ok(report.exceptions[0].startsWith('Master pause is ON'));
  env.DB.raw.exec('UPDATE settings SET paused=0');
  ({report}=await buildReport(env,NOW));
  assert.ok(report.exceptions.some(e=>/within 15 minutes/.test(e)));
  const b=backend();await minute(env,b,CALL);                             // dispatched, never reports back
  ({report}=await buildReport(env,CALL+20*MIN));
  assert.ok(report.exceptions.some(e=>/outcome still unknown/.test(e)));
  const env2={...env,HELPER_URL:'https://script.test/exec',HELPER_KEY:'hk'};let sent;const orig=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{sent=JSON.parse(init.body);return {json:async()=>({ok:true,sent:true})};};
  const auth={'Authorization':'Basic '+btoa('u:pw'),'X-Alarm-UI':'1','Content-Type':'application/json','Origin':'https://x'};
  try{
    const before=snapshot(env);
    const r=await worker.fetch(new Request('https://x/api/report',{method:'POST',headers:auth,body:'{}'}),env2);
    assert.equal(r.status,200);assert.equal(snapshot(env),before);
    assert.deepEqual([sent.action,sent.report_key,typeof sent.json],['report','hk','string']);assert.equal(sent.key,undefined);
    assert.match(sent.subject,/^CallMe status report rpt_/);assert.equal(JSON.parse(sent.json).report_id,(await r.json()).report_id);
    globalThis.fetch=async()=>({json:async()=>({ok:false,error:'unauthorized'})});        // an older helper refuses
    const bad=await worker.fetch(new Request('https://x/api/report',{method:'POST',headers:auth,body:'{}'}),env2);
    assert.equal(bad.status,502);
  }finally{globalThis.fetch=orig;}
});
