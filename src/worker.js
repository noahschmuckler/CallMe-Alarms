// Owner-operated alarm UI and scheduler. A once-a-minute cron (wrangler.toml)
// calls tick(); calls are placed through the existing CallMe backend on Railway.
import { localParts, iso, minuteFloor, inQuietHours, spoken, callOptions, nextStep, clock, QUIET_START, QUIET_END, MAX_SNOOZES } from './policy.js';
import { submit, decideDraft, receipt, expireDrafts, IntakeError } from './intake.js';
export { localParts, spoken, nextStep };
const DAYS = ['0,1,2,3,4', '0,1,2,3,4,5,6', '5,6', 'once'];
const security = {
  'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};
function response(data, status=200) {
  return new Response(JSON.stringify(data), {status,headers:{...security,'Content-Type':'application/json'}});
}
async function authorized(req, env) {
  if (!env.UI_PASSWORD) return false;
  const cookie=(req.headers.get('Cookie')||'').split('; ').find(x=>x.startsWith('alarm_session='))?.slice(14);
  if(cookie){
    const [expires,sig]=cookie.split('.');
    if(Number(expires)>Date.now() && sig===await signature(expires,env.UI_PASSWORD))return true;
  }
  const raw = req.headers.get('Authorization') || '';
  if (!raw.startsWith('Basic ')) return false;
  let value;
  try { const text=atob(raw.slice(6)); value=text.slice(text.indexOf(':')+1); } catch { return false; }
  const hash=async s=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));
  const [a,b]=await Promise.all([hash(value),hash(env.UI_PASSWORD)]);
  let diff=0; for(let i=0;i<a.length;i++)diff|=a[i]^b[i];
  return diff===0;
}
async function signature(text,secret){
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(text)))).map(x=>x.toString(16).padStart(2,'0')).join('');
}
const LOGIN='<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>CallMe · Sign in</title><style>body{font:16px system-ui;background:#f5f5ef;color:#23302c;padding:24px}main{max-width:360px;margin:10vh auto;background:white;border-radius:16px;padding:28px}input,button{width:100%;box-sizing:border-box;font:inherit;padding:12px;margin-top:12px;border:1px solid #cbd5cc;border-radius:8px}button{background:#245e4b;color:white}p{line-height:1.5}</style></head><body><main><h1>CallMe Alarms</h1><p>Sign in to manage your saved schedules. Calling is not connected yet.</p><form method="post" action="/login"><label for="password">Owner password</label><input id="password" type="password" name="password" required autocomplete="current-password"><button>Sign in</button></form></main></body></html>';
const MAX_SCHEDULES=100;
const MODES=['none','retry','keep_calling'];
function validate(s) {
  if(typeof s.label!=='string'||!s.label.trim()||s.label.length>80)throw Error('Use a name from 1 to 80 characters.');
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.at)||!DAYS.includes(s.days))throw Error('Choose a valid time and repeat pattern.');
  if(!Number.isInteger(s.repeats)||s.repeats<1||s.repeats>5)throw Error('Message repeats must be 1 to 5.');
  const snooze=s.snooze_minutes??0, mode=s.if_unacknowledged??'none';
  if(!Number.isInteger(snooze)||snooze<0||snooze>60)throw Error('Choose a snooze length from 0 to 60 minutes.');
  if(!MODES.includes(mode))throw Error('Choose what happens if you don\'t press 1.');
  s.snooze_minutes=snooze; s.max_snoozes=snooze?MAX_SNOOZES:0;
  s.until_ack=mode==='keep_calling'?1:0;
  if(mode==='none'){s.retry_minutes=0;s.max_retries=0;}
  else {
    if(!Number.isInteger(s.retry_minutes)||s.retry_minutes<2||s.retry_minutes>30)throw Error('Choose a call-again interval from 2 to 30 minutes.');
    if(mode==='retry'){if(!Number.isInteger(s.max_retries)||s.max_retries<1||s.max_retries>5)throw Error('Choose 1 to 5 more calls.');}
    else s.max_retries=0;
  }
  const hasPolicy=snooze||mode!=='none';
  if(typeof s.message!=='string'||!s.message.trim()||s.message.length>(hasPolicy?700:800))throw Error(`Use a message from 1 to ${hasPolicy?700:800} characters${hasPolicy?' (the keypad menu is added after it)':''}.`);
  s.late_ok=s.late_ok===true?1:0;
  if(inQuietHours(s.at)&&!s.late_ok)throw Error('Choose a time outside quiet hours (10:30 PM to 5:00 AM), or tick "Allow this call during quiet hours".');
  if(s.days==='once') {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(s.once_date)||isNaN(new Date(s.once_date+'T00:00:00Z'))||new Date(s.once_date+'T00:00:00Z').toISOString().slice(0,10)!==s.once_date)throw Error('Choose a valid future date.');
    const now=localParts(Date.now());
    if(s.once_date+'T'+s.at<=now.date+'T'+now.at)throw Error('Choose a future time for a one-time call.');
  }
}
// Stops a schedule's pending snooze/repeat calls, and any that a call still in progress would start.
async function cancelFollowups(env,scheduleId){
  await env.DB.batch([
    env.DB.prepare("UPDATE followups SET status='cancelled' WHERE schedule_id=? AND status='pending'").bind(scheduleId),
    env.DB.prepare('UPDATE runs SET halt=1 WHERE schedule_id=? AND decided=0').bind(scheduleId),
  ]);
}
export async function tick(env, when, dispatch) {
  // Snoozes or repeat calls more than 10 minutes overdue (downtime, or a pause) are dropped, never replayed.
  await env.DB.prepare("UPDATE followups SET status='expired' WHERE status='pending' AND due_at<?").bind(iso(when-10*60000)).run();
  const state=await env.DB.prepare('SELECT paused FROM settings WHERE id=1').first();
  if(!state || state.paused) return;
  const now=localParts(when);
  const due=await env.DB.prepare('SELECT * FROM schedules WHERE enabled=1 AND at=?').bind(now.at).all();
  for(const s of due.results) {
    if(s.days==='once' ? s.once_date!==now.date : !s.days.split(',').includes(now.day))continue;
    const key=`${s.id}|${now.date}|${now.at}`;
    const quiet=inQuietHours(now.at)&&!s.late_ok;
    // Atomic reserve rechecks owner pause/enabled state at the dispatch boundary.
    const claim=await env.DB.prepare(`INSERT OR IGNORE INTO runs(fire_key,schedule_id,label,started_at,result,chain_started,decided)
      SELECT ?,s.id,s.label,?,?,?,? FROM schedules s,settings p
      WHERE s.id=? AND s.enabled=1 AND p.id=1 AND p.paused=0`).bind(key,iso(when),quiet?'Skipped: quiet hours, not allowed for this schedule':'Sending',iso(when),quiet?1:0,s.id).run();
    if(!claim.meta.changes)continue;
    if(!quiet)await send(env,key,s,{snoozes:0,retries:0},dispatch);
    if(s.days==='once')await env.DB.prepare('UPDATE schedules SET enabled=0 WHERE id=?').bind(s.id).run();
  }
  // Snooze and repeat calls that are due now.
  const fus=await env.DB.prepare("SELECT * FROM followups WHERE status='pending' AND due_at<=? ORDER BY due_at LIMIT 10").bind(iso(when)).all();
  for(const f of fus.results){
    const s=await env.DB.prepare('SELECT * FROM schedules WHERE id=?').bind(f.schedule_id).first();
    if(!s||(inQuietHours(now.at)&&!s.late_ok)){await env.DB.prepare("UPDATE followups SET status='cancelled' WHERE id=? AND status='pending'").bind(f.id).run();continue;}
    const claim=await env.DB.prepare(`UPDATE followups SET status='sent' WHERE id=? AND status='pending'
      AND (SELECT paused FROM settings WHERE id=1)=0`).bind(f.id).run();
    if(!claim.meta.changes)continue;
    const key='fu|'+f.id;
    const label=s.label+(f.kind==='snooze'?' (snoozed call)':` (call ${f.retries+f.snoozes+1})`);
    await env.DB.prepare("INSERT OR IGNORE INTO runs(fire_key,schedule_id,label,started_at,result,snoozes,retries,chain_started) VALUES(?,?,?,?,'Sending',?,?,?)")
      .bind(key,s.id,label,iso(when),f.snoozes,f.retries,f.chain_started).run();
    await send(env,key,s,f,dispatch);
  }
}
async function send(env,key,s,chain,dispatch){
  let result='Uncertain or failed. Not retried.', callId=null;
  try {
    callId=await dispatch({...s,message:spoken(s,chain),call_options:callOptions(s,chain)},chain);
    result='Call requested';
  } catch { /* Never retry an ambiguous call request. */ }
  await env.DB.prepare('UPDATE runs SET result=?,call_id=?,decided=? WHERE fire_key=?').bind(result,callId,callId?0:1,key).run();
}
const CALLME='https://callme-server-production-f24a.up.railway.app';
const TO='+16107240221';
// Ask the existing Railway CallMe backend (which owns the Twilio credentials) to
// place one call now. Returns the backend's call_id, or throws.
export async function placeCall(env,s,extra={}) {
  if(!env.CALLME_SECRET)throw Error('Calling is not configured');
  const r=await fetch(CALLME+'/v1/call',{
    method:'POST',headers:{'Authorization':'Bearer '+env.CALLME_SECRET,'Content-Type':'application/json'},
    body:JSON.stringify({to:TO,message:s.message,repeat:s.repeats,...(s.call_options||{}),metadata:{alarm_schedule_id:s.id,...(s.reminder_id?{reminder_id:s.reminder_id}:{}),...(s.revision?{schedule_revision:s.revision}:{}),...extra}}),
    signal:AbortSignal.timeout(20000),
  });
  if(r.status!==202)throw Error('Call request failed: '+r.status);
  return (await r.json()).call_id;
}
const FINAL=['completed','busy','no-answer','failed','canceled','acknowledged','error'];
const STOPS={quiet_hours:'stopped: quiet hours',safety_stop:'stopped: 2-hour safety limit',policy_done:'no more calls in this schedule\'s policy'};
// After a request, ask the backend how the call went, record a response event,
// and queue a snooze or repeat call when the schedule's policy asks for one.
export async function followUp(env,now=Date.now(),fetcher=fetch) {
  if(!env.CALLME_SECRET)return;
  const open=await env.DB.prepare("SELECT * FROM runs WHERE call_id IS NOT NULL AND decided=0 AND started_at>=? ORDER BY started_at DESC LIMIT 10").bind(iso(now-60*60000)).all();
  for(const run of open.results) {
    const base=run.result.split(' · ')[0];
    let j;
    try {
      const r=await fetcher(CALLME+'/v1/call/'+encodeURIComponent(run.call_id),{headers:{'Authorization':'Bearer '+env.CALLME_SECRET},signal:AbortSignal.timeout(10000)});
      if(!r.ok)continue;
      j=await r.json();
    } catch { continue; /* Try again next minute. */ }
    let status=String(j.status||'').slice(0,40);
    const final=FINAL.includes(status.toLowerCase());
    const digits=String(j.digits||'').slice(0,5);
    if(j.acknowledged===true)status+=status?', acknowledged':'acknowledged';
    else if(digits)status+=`, pressed ${digits}`;
    if(!final){
      // A call that never reports an ending within 45 minutes is left alone.
      const stale=Date.parse(run.started_at)<now-45*60000;
      if(status||stale)await env.DB.prepare('UPDATE runs SET result=?,decided=? WHERE fire_key=?').bind(base+' · '+(status||'no status'),stale?1:0,run.fire_key).run();
      continue;
    }
    const s=run.fire_key.startsWith('test|')?null:await env.DB.prepare('SELECT * FROM schedules WHERE id=?').bind(run.schedule_id).first();
    const step=nextStep(s,run,j,now);
    const acknowledged=j.acknowledged===true||digits==='1'||digits==='3';
    let note=digits==='3'?' · spoken update recorded':'',outcome=digits==='3'?'spoken_update':acknowledged?'acknowledged':'not_acknowledged';
    if(step&&!step.stop){
      // Atomic: no follow-up if the schedule was cancelled or turned off while this call was in progress.
      const ins=await env.DB.prepare(`INSERT OR IGNORE INTO followups(id,parent_key,schedule_id,kind,due_at,snoozes,retries,chain_started,created_at)
        SELECT ?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM runs WHERE fire_key=? AND halt=1)`)
        .bind(crypto.randomUUID(),run.fire_key,s.id,step.kind,iso(step.due),step.snoozes,step.retries,run.chain_started||run.started_at,iso(now),run.fire_key).run();
      if(ins.meta.changes){note=step.kind==='snooze'?` · snoozed until ${clock(step.due)}`:` · calling again at ${clock(step.due)}`;outcome=step.kind==='snooze'?'snoozed':'calling_again';}
      else {note=' · stopped: cancelled or turned off';outcome='cancelled';}
    } else if(step?.stop){note=' · '+STOPS[step.stop];outcome=step.stop;}
    const batch=[env.DB.prepare('UPDATE runs SET result=?,decided=1 WHERE fire_key=? AND decided=0').bind(base+' · '+status+note,run.fire_key)];
    if(s)batch.push(env.DB.prepare('INSERT INTO events(at,schedule_id,reminder_id,fire_key,call_id,kind,call_status,digits,outcome) VALUES(?,?,?,?,?,?,?,?,?)')
      .bind(iso(now),s.id,s.reminder_id||null,run.fire_key,run.call_id,'call_ended',String(j.status||'').slice(0,40),digits,outcome));
    await env.DB.batch(batch);
  }
}
// ---------- proposal intake (machine side): stages drafts only ----------
async function bearerOk(req,secret){
  if(!secret)return false;
  const raw=req.headers.get('Authorization')||'';
  if(!raw.startsWith('Bearer '))return false;
  const hash=async s=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));
  const [a,b]=await Promise.all([hash(raw.slice(7)),hash(secret)]);
  let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];
  return diff===0;
}
async function inbox(req,env,url){
  if(!await bearerOk(req,env.PLAN_TOKEN))return response({error:'unauthorized'},401);
  try{
    if(url.pathname==='/inbox/proposal'&&req.method==='POST'){
      const text=await req.text();
      const r=await submit(env,text,'transport');
      return response(r.body,r.status);
    }
    if(url.pathname==='/inbox/receipt'&&req.method==='GET'){
      const r=await receipt(env,url.searchParams.get('command_id')||'');
      return r?response(r):response({error:'not_found',problems:['No command with that command_id was received.']},404);
    }
    return response({error:'not_found'},404);
  }catch(e){
    if(e instanceof IntakeError)return response({error:e.error,problems:e.problems},e.status);
    return response({error:'server_error',problems:['Status unknown. Resending the same command_id is safe.']},500);
  }
}
async function draftsForUI(env){
  await expireDrafts(env);
  const rows=(await env.DB.prepare("SELECT * FROM drafts WHERE status IN ('pending','approving') OR decided_at>=? ORDER BY received_at DESC LIMIT 15").bind(iso(Date.now()-3*86400000)).all()).results;
  for(const d of rows){
    d.commands=JSON.parse(d.commands);
    for(const c of d.commands){
      if(c.action!=='cancel')continue;
      const r=await env.DB.prepare('SELECT r.call_at,r.status,s.label,s.revision,s.enabled FROM reminders r LEFT JOIN schedules s ON s.id=r.schedule_id WHERE r.reminder_id=?').bind(c.reminder_id).first();
      c.target=r||null;
    }
  }
  return rows;
}
export default {
 async fetch(req,env) {
  const loginUrl=new URL(req.url);
  // Machine endpoints for proposals. Own token; they can only stage drafts and read receipts.
  if(loginUrl.pathname.startsWith('/inbox/'))return inbox(req,env,loginUrl);
  if(!env.UI_PASSWORD)return new Response('Owner login is not configured.',{status:503,headers:security});
  if(loginUrl.pathname==='/logout')return new Response(null,{status:303,headers:{...security,Location:'/login','Set-Cookie':'alarm_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'}});
  if(loginUrl.pathname==='/login'){
   if(req.method==='GET')return new Response(LOGIN,{headers:{...security,'Referrer-Policy':'same-origin','Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}});
   if(req.method==='POST'){
    if(req.headers.get('Origin')!==loginUrl.origin)return response({error:'Forbidden'},403);
    const form=await req.formData();
    const test=new Request(req.url,{headers:{Authorization:'Basic '+btoa('owner:'+String(form.get('password')||''))}});
    if(!await authorized(test,env))return new Response('Password not accepted. Go back and try again.',{status:401,headers:security});
    const expires=String(Date.now()+12*3600000);
    return new Response(null,{status:303,headers:{...security,Location:'/', 'Set-Cookie':'alarm_session='+expires+'.'+await signature(expires,env.UI_PASSWORD)+'; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200'}});
   }
  }
  if(!await authorized(req,env) && !loginUrl.pathname.startsWith('/api/') && !req.headers.has('Authorization'))return new Response(null,{status:303,headers:{...security,Location:'/login'}});
  if(!await authorized(req,env))return new Response('Owner login required',{status:401,headers:{...security,'WWW-Authenticate':'Basic realm="CallMe Alarms", charset="UTF-8"'}});
  const url=new URL(req.url);
  if(!url.pathname.startsWith('/api/')) {
    if(!['GET','HEAD'].includes(req.method))return response({error:'Method not allowed'},405);
    if(!['/','/app.js','/style.css'].includes(url.pathname))return response({error:'Not found'},404);
    const asset=await env.ASSETS.fetch(req);
    const r=new Response(asset.body,asset);Object.entries(security).forEach(([k,v])=>r.headers.set(k,v));return r;
  }
  try {
   if(req.method==='GET'&&url.pathname==='/api/state') {
    const settings=await env.DB.prepare('SELECT paused FROM settings WHERE id=1').first();
    const schedules=await env.DB.prepare('SELECT * FROM schedules ORDER BY at,label').all();
    const runs=await env.DB.prepare('SELECT label,started_at,result FROM runs ORDER BY started_at DESC LIMIT 20').all();
    const followups=await env.DB.prepare("SELECT f.id,f.kind,f.due_at,f.snoozes,f.retries,s.label FROM followups f JOIN schedules s ON s.id=f.schedule_id WHERE f.status='pending' ORDER BY f.due_at").all();
    return response({callingConnected:!!env.CALLME_SECRET,proposalInbox:!!env.PLAN_TOKEN,paused:!settings||!!settings.paused,quiet:{start:QUIET_START,end:QUIET_END},
      schedules:schedules.results,runs:runs.results,drafts:await draftsForUI(env),followups:followups.results,serverTime:iso(Date.now())});
   }
   if(req.method!=='POST')return response({error:'Not found'},404);
   // JSON + custom header + strict origin blocks cross-site form and fetch CSRF.
   if(req.headers.get('Origin')!==url.origin || req.headers.get('X-Alarm-UI')!=='1'||!req.headers.get('Content-Type')?.startsWith('application/json'))return response({error:'Forbidden'},403);
   if(Number(req.headers.get('Content-Length')||0)>70000)return response({error:'Request too large'},413);
   const text=await req.text(); if(text.length>70000)return response({error:'Request too large'},413);
   const s=JSON.parse(text);
   if(url.pathname==='/api/pause') {
    if(s.paused===false && !env.CALLME_SECRET)return response({error:'Calling is not connected. Owner activation is required.'},409);
    if(typeof s.paused!=='boolean')return response({error:'Invalid pause state'},400);
    await env.DB.prepare('UPDATE settings SET paused=? WHERE id=1').bind(s.paused?1:0).run();return response({ok:true});
   }
   if(url.pathname==='/api/save') {
    validate(s);const id=s.id||crypto.randomUUID();
    const f=[s.snooze_minutes,s.max_snoozes,s.retry_minutes,s.max_retries,s.until_ack,s.late_ok];
    const cols='label=?,at=?,days=?,once_date=?,message=?,repeats=?,enabled=?,snooze_minutes=?,max_snoozes=?,retry_minutes=?,max_retries=?,until_ack=?,late_ok=?';
    const vals=[s.label.trim(),s.at,s.days,s.days==='once'?s.once_date:'',s.message.trim(),s.repeats,s.enabled===true?1:0,...f];
    if(s.id) {
      const r=await env.DB.prepare(`UPDATE schedules SET ${cols},revision=revision+1 WHERE id=?`).bind(...vals,id).run();
      if(!r.meta.changes)return response({error:'Not found'},404);
      await cancelFollowups(env,id);
    } else {
      const count=await env.DB.prepare('SELECT count(*) AS n FROM schedules').first();
      if(count.n>=MAX_SCHEDULES)return response({error:`Maximum ${MAX_SCHEDULES} schedules. Remove an old schedule first.`},400);
      await env.DB.prepare('INSERT INTO schedules(label,at,days,once_date,message,repeats,enabled,snooze_minutes,max_snoozes,retry_minutes,max_retries,until_ack,late_ok,id,created_at,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .bind(...vals,id,iso(Date.now()),'ui').run();
    }
    return response({ok:true});
   }
   if(url.pathname==='/api/test') {
    if(!env.CALLME_SECRET)return response({error:'Calling is not connected. Owner activation is required.'},409);
    const sched=await env.DB.prepare('SELECT * FROM schedules WHERE id=?').bind(s.id).first();
    if(!sched)return response({error:'Not found'},404);
    const recent=await env.DB.prepare("SELECT count(*) AS n FROM runs WHERE fire_key LIKE 'test|%' AND started_at>=?").bind(iso(Date.now()-60000)).first();
    if(recent.n)return response({error:'Wait a minute between test calls.'},429);
    const key='test|'+crypto.randomUUID();
    await env.DB.prepare("INSERT INTO runs(fire_key,schedule_id,label,started_at,result,decided) VALUES(?,?,?,?,'Sending',1)").bind(key,sched.id,'Test: '+sched.label,iso(Date.now())).run();
    let result='Test failed. Check the CallMe backend.',callId=null;
    // A test speaks the same menu, but its keypresses never start a snooze or repeat call.
    try {callId=await placeCall(env,{...sched,message:spoken(sched),call_options:callOptions(sched,{snoozes:0},{test:true})},{test:true});result='Test call requested';} catch {}
    await env.DB.prepare('UPDATE runs SET result=?,call_id=? WHERE fire_key=?').bind(result,callId,key).run();
    return callId?response({ok:true}):response({error:result},502);
   }
   if(url.pathname==='/api/toggle') {
    await env.DB.prepare('UPDATE schedules SET enabled=1-enabled WHERE id=?').bind(s.id).run();
    const row=await env.DB.prepare('SELECT enabled FROM schedules WHERE id=?').bind(s.id).first();
    if(row&&!row.enabled)await cancelFollowups(env,s.id);
    return response({ok:true});
   }
   if(url.pathname==='/api/delete') {
    await cancelFollowups(env,s.id);
    await env.DB.prepare('DELETE FROM schedules WHERE id=?').bind(s.id).run();return response({ok:true});
   }
   if(url.pathname==='/api/followup/cancel') {
    await env.DB.prepare("UPDATE followups SET status='cancelled' WHERE id=? AND status='pending'").bind(s.id).run();return response({ok:true});
   }
   if(url.pathname==='/api/draft/paste') {
    try { const r=await submit(env,String(s.text||''),'paste'); return response({ok:true,...r.body}); }
    catch(e){ if(e instanceof IntakeError)return response({error:e.problems.join(' ')},e.status); throw e; }
   }
   if(url.pathname==='/api/draft/approve'||url.pathname==='/api/draft/reject') {
    const r=await decideDraft(env,String(s.id||''),String(s.hash||''),url.pathname.endsWith('approve'));
    return r.ok?response(r):response({error:r.error},409);
   }
   return response({error:'Not found'},404);
  } catch(e) {return response({error:e instanceof SyntaxError?'Invalid request':/^(Use|Choose|Message) /.test(String(e.message))?e.message:'Could not save or load. Please try again.'},400);}
 },
 async scheduled(event,env,ctx) {
   // Scheduled dispatch is independent of the UI browser and any assistant.
   // Dispatch errors fail closed; ambiguous call requests are never retried. Cron runs can
   // start a little late, so allow up to 5 minutes before treating an event as stale.
   if(Math.abs(Date.now()-event.scheduledTime)>5*60000)return;
   await tick(env,event.scheduledTime,(s,chain)=>placeCall(env,s,chain.kind?{kind:chain.kind,snoozes:chain.snoozes,retries:chain.retries}:{}));
   await followUp(env,event.scheduledTime);
   const t=event.scheduledTime;
   // Bounded history: 90 days of activity and events. One-time schedules are removed two
   // days after they ran (their reminder receipts stay).
   await env.DB.batch([
     env.DB.prepare('DELETE FROM runs WHERE started_at < ?').bind(iso(t-90*86400000)),
     env.DB.prepare('DELETE FROM events WHERE at < ?').bind(iso(t-90*86400000)),
     env.DB.prepare("DELETE FROM followups WHERE status!='pending' AND created_at<?").bind(iso(t-90*86400000)),
     env.DB.prepare("DELETE FROM schedules WHERE days='once' AND enabled=0 AND once_date<? AND id NOT IN (SELECT schedule_id FROM followups WHERE status='pending')").bind(localParts(t-2*86400000).date),
   ]);
 }
};
