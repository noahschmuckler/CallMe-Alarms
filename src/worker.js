// Owner-operated alarm UI and scheduler. A once-a-minute cron (wrangler.toml)
// calls tick(); calls are placed through the existing CallMe backend on Railway.
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
export function localParts(ms) {
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{
    timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',weekday:'short',hourCycle:'h23',
  }).formatToParts(new Date(ms)).map(p=>[p.type,p.value]));
  return {date:`${p.year}-${p.month}-${p.day}`,at:`${p.hour}:${p.minute}`,day:String(['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].indexOf(p.weekday))};
}
async function signature(text,secret){
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(text)))).map(x=>x.toString(16).padStart(2,'0')).join('');
}
const LOGIN='<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>CallMe · Sign in</title><style>body{font:16px system-ui;background:#f5f5ef;color:#23302c;padding:24px}main{max-width:360px;margin:10vh auto;background:white;border-radius:16px;padding:28px}input,button{width:100%;box-sizing:border-box;font:inherit;padding:12px;margin-top:12px;border:1px solid #cbd5cc;border-radius:8px}button{background:#245e4b;color:white}p{line-height:1.5}</style></head><body><main><h1>CallMe Alarms</h1><p>Sign in to manage your saved schedules. Calling is not connected yet.</p><form method="post" action="/login"><label for="password">Owner password</label><input id="password" type="password" name="password" required autocomplete="current-password"><button>Sign in</button></form></main></body></html>';
const LIMITS={snooze:[0,60],maxSnoozes:[0,3],retry:[0,30],maxRetries:[0,5]};
const MAX_SPOKEN=800;
function int(v,[lo,hi],what){
  if(v===undefined||v===null||v==='')return 0;
  if(!Number.isInteger(v)||v<lo||v>hi)throw Error(`Use ${what} from ${lo} to ${hi}.`);
  return v;
}
// Normalizes snooze/retry settings in place. 0 means off.
function followupSettings(s){
  s.snooze_minutes=int(s.snooze_minutes,LIMITS.snooze,'snooze minutes');
  s.max_snoozes=s.snooze_minutes?int(s.max_snoozes??1,[1,3],'snoozes'):0;
  s.retry_minutes=int(s.retry_minutes,LIMITS.retry,'retry minutes');
  if(s.retry_minutes&&s.retry_minutes<2)throw Error('Use retry minutes from 2 to 30.');
  s.max_retries=s.retry_minutes?int(s.max_retries??2,[1,5],'retries'):0;
}
// What the call actually says: the message, plus a keypad menu when snooze is on.
export function spoken(s,snoozesUsed=0){
  if(!s.snooze_minutes)return s.message;
  const more=snoozesUsed<s.max_snoozes;
  return s.message+(more?` Press 1 if you're up. Press 2 to snooze for ${s.snooze_minutes} minutes.`:` This is your last call. Press 1 if you're up.`);
}
function validate(s) {
  if(typeof s.label!=='string'||!s.label.trim()||s.label.length>80)throw Error('Use a name from 1 to 80 characters.');
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.at)||!DAYS.includes(s.days))throw Error('Choose a valid time and repeat pattern.');
  if(typeof s.message!=='string'||!s.message.trim()||s.message.length>MAX_SPOKEN)throw Error('Use a message from 1 to 800 characters.');
  if(!Number.isInteger(s.repeats)||s.repeats<1||s.repeats>5)throw Error('Message repeats must be 1 to 5.');
  followupSettings(s);
  if(spoken({...s,message:s.message.trim()}).length>MAX_SPOKEN)throw Error('Use a message from 1 to 800 characters, including the snooze menu (about 70 characters).');
  if(s.days==='once') {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(s.once_date)||isNaN(new Date(s.once_date+'T00:00:00Z'))||new Date(s.once_date+'T00:00:00Z').toISOString().slice(0,10)!==s.once_date)throw Error('Choose a valid future date.');
    const now=localParts(Date.now());
    if(s.once_date+'T'+s.at<=now.date+'T'+now.at)throw Error('Choose a future time for a one-time call.');
  }
}
const iso=ms=>new Date(ms).toISOString();
const minuteFloor=ms=>Math.floor(ms/60000)*60000;
async function cancelFollowups(env,scheduleId){
  await env.DB.prepare("UPDATE followups SET status='cancelled' WHERE schedule_id=? AND status='pending'").bind(scheduleId).run();
}
export async function tick(env, when, dispatch) {
  // Snoozes or retries more than 10 minutes overdue (downtime, or a pause) are dropped, not replayed.
  await env.DB.prepare("UPDATE followups SET status='expired' WHERE status='pending' AND due_at<?").bind(iso(when-10*60000)).run();
  const state=await env.DB.prepare('SELECT paused FROM settings WHERE id=1').first();
  if(!state || state.paused) return;
  const now=localParts(when);
  const due=await env.DB.prepare('SELECT * FROM schedules WHERE enabled=1 AND at=?').bind(now.at).all();
  for(const s of due.results) {
    if(s.days==='once' ? s.once_date!==now.date : !s.days.split(',').includes(now.day))continue;
    const key=`${s.id}|${now.date}|${now.at}`;
    // Atomic reserve rechecks owner pause/enabled state at the dispatch boundary.
    const claim=await env.DB.prepare(`INSERT OR IGNORE INTO runs(fire_key,schedule_id,label,started_at,result)
      SELECT ?,s.id,s.label,?,'Sending' FROM schedules s,settings p
      WHERE s.id=? AND s.enabled=1 AND p.id=1 AND p.paused=0`).bind(key,iso(when),s.id).run();
    if(!claim.meta.changes)continue;
    await send(env,key,s,{snoozes:0,retries:0},dispatch);
    if(s.days==='once')await env.DB.prepare('UPDATE schedules SET enabled=0 WHERE id=?').bind(s.id).run();
  }
  // Snooze and retry calls that are due now.
  const fus=await env.DB.prepare("SELECT * FROM followups WHERE status='pending' AND due_at<=? ORDER BY due_at LIMIT 10").bind(iso(when)).all();
  for(const f of fus.results){
    const claim=await env.DB.prepare(`UPDATE followups SET status='sent' WHERE id=? AND status='pending'
      AND (SELECT paused FROM settings WHERE id=1)=0`).bind(f.id).run();
    if(!claim.meta.changes)continue;
    const s=await env.DB.prepare('SELECT * FROM schedules WHERE id=?').bind(f.schedule_id).first();
    if(!s)continue;
    const key='fu|'+f.id;
    const label=s.label+(f.kind==='snooze'?` (snooze ${f.snoozes})`:` (retry ${f.retries})`);
    await env.DB.prepare("INSERT OR IGNORE INTO runs(fire_key,schedule_id,label,started_at,result,snoozes,retries) VALUES(?,?,?,?,'Sending',?,?)")
      .bind(key,s.id,label,iso(when),f.snoozes,f.retries).run();
    await send(env,key,s,f,dispatch);
  }
}
async function send(env,key,s,chain,dispatch){
  let result='Uncertain or failed. Not retried.', callId=null;
  try {
    callId=await dispatch({...s,message:spoken(s,chain.snoozes)},chain);
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
    body:JSON.stringify({to:TO,message:s.message,repeat:s.repeats,metadata:{alarm_schedule_id:s.id,...extra}}),
    signal:AbortSignal.timeout(20000),
  });
  if(r.status!==202)throw Error('Call request failed: '+r.status);
  return (await r.json()).call_id;
}
const FINAL=['completed','busy','no-answer','failed','canceled','acknowledged','error'];
const clock=ms=>new Date(ms).toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'2-digit'});
// Decide what happens after a call ends: done (pressed 1), snooze (pressed 2,
// snoozes left), retry (no confirmation, retries left), or nothing more.
export function nextStep(s,run,call,now){
  if(!s)return null;
  const acknowledged=call.acknowledged===true||String(call.digits||'')==='1';
  if(acknowledged)return null;
  if(String(call.digits||'')==='2'&&s.snooze_minutes&&run.snoozes<s.max_snoozes){
    const due=Math.max(minuteFloor(Date.parse(run.started_at))+s.snooze_minutes*60000,minuteFloor(now)+60000);
    return {kind:'snooze',due,snoozes:run.snoozes+1,retries:0};
  }
  if(s.retry_minutes&&run.retries<s.max_retries)
    return {kind:'retry',due:minuteFloor(now)+s.retry_minutes*60000,snoozes:run.snoozes,retries:run.retries+1};
  return null;
}
// After a request, ask the backend how the call went, record it in the activity
// log, and queue a snooze or retry call when the schedule asks for one.
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
    } catch { continue; /* Status is informational; try again next minute. */ }
    let status=String(j.status||'').slice(0,40);
    const final=FINAL.includes(status.toLowerCase());
    const digits=String(j.digits||'');
    if(j.acknowledged===true)status+=status?', acknowledged':'acknowledged';
    else if(digits==='2')status+=', pressed 2';
    if(!final){
      // A call that never reports an ending within 45 minutes is left alone.
      const stale=Date.parse(run.started_at)<now-45*60000;
      if(status||stale)await env.DB.prepare('UPDATE runs SET result=?,decided=? WHERE fire_key=?').bind(base+' · '+(status||'no status'),stale?1:0,run.fire_key).run();
      continue;
    }
    const s=run.fire_key.startsWith('test|')?null:await env.DB.prepare('SELECT * FROM schedules WHERE id=?').bind(run.schedule_id).first();
    const step=nextStep(s,run,j,now);
    let note='';
    if(step){
      const ins=await env.DB.prepare("INSERT OR IGNORE INTO followups(id,parent_key,schedule_id,kind,due_at,snoozes,retries,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .bind(crypto.randomUUID(),run.fire_key,s.id,step.kind,iso(step.due),step.snoozes,step.retries,iso(now)).run();
      if(ins.meta.changes)note=step.kind==='snooze'?` · snoozed until ${clock(step.due)}`:` · will call again at ${clock(step.due)}`;
    }
    await env.DB.prepare('UPDATE runs SET result=?,decided=1 WHERE fire_key=?').bind(base+' · '+status+note,run.fire_key).run();
  }
}
// ---------- Plan inbox: Instinct (or any token holder) proposes calls; only the owner approves. ----------
const REPEAT_WORDS={'weekdays':'0,1,2,3,4','every day':'0,1,2,3,4,5,6','daily':'0,1,2,3,4,5,6','weekends':'5,6'};
export function parsePlan(text){
  let raw=text.trim();
  if(!raw.startsWith('{')){const a=raw.indexOf('{'),b=raw.lastIndexOf('}');if(a<0||b<a)throw new PlanError(['No JSON plan found in the request body.']);raw=raw.slice(a,b+1);}
  let p;try{p=JSON.parse(raw);}catch{throw new PlanError(['The plan is not valid JSON.']);}
  const problems=[];
  if(!p||typeof p!=='object'||p.format!=='callme-plan/1')problems.push('"format" must be "callme-plan/1".');
  const title=typeof p?.title==='string'?p.title.trim():'';
  if(!title||title.length>100)problems.push('"title" is required, up to 100 characters.');
  const note=p?.note===undefined?'':typeof p.note==='string'&&p.note.length<=1000?p.note.trim():(problems.push('"note" must be text up to 1000 characters.'),'');
  if(!Array.isArray(p?.calls)||!p.calls.length||p.calls.length>30)problems.push('"calls" must be a list of 1 to 30 calls.');
  const calls=[];
  (Array.isArray(p?.calls)?p.calls.slice(0,30):[]).forEach((c,i)=>{
    const n=`calls[${i}]`;
    try{
      if(!c||typeof c!=='object')throw Error('must be an object');
      const days=c.date!==undefined?'once':REPEAT_WORDS[String(c.repeat||'').toLowerCase()];
      if(c.date!==undefined&&c.repeat!==undefined)throw Error('give either "date" or "repeat", not both');
      if(!days)throw Error('needs "date" (YYYY-MM-DD) or "repeat" (weekdays, every day, weekends)');
      const s={label:c.label,at:c.time,days,once_date:days==='once'?c.date:'',message:typeof c.say==='string'?c.say.trim():c.say,
        repeats:c.repeats??1,snooze_minutes:c.snooze_minutes??0,max_snoozes:c.max_snoozes,retry_minutes:c.retry_minutes??0,max_retries:c.max_retries};
      validate(s);
      s.label=s.label.trim();
      calls.push(s);
    }catch(e){problems.push(`${n}: ${String(e.message).replace(/\.$/,'')}.`);}
  });
  if(problems.length)throw new PlanError(problems);
  return {title,note,calls};
}
class PlanError extends Error{constructor(problems){super('invalid plan');this.problems=problems;}}
async function bearerOk(req,secret){
  if(!secret)return false;
  const raw=req.headers.get('Authorization')||'';
  if(!raw.startsWith('Bearer '))return false;
  const hash=async s=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));
  const [a,b]=await Promise.all([hash(raw.slice(7)),hash(secret)]);
  let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];
  return diff===0;
}
export async function receivePlan(req,env){
  if(req.method!=='POST')return response({error:'Method not allowed'},405);
  if(!await bearerOk(req,env.PLAN_TOKEN))return response({error:'Unauthorized'},401);
  const text=await req.text();
  if(text.length>65536)return response({error:'Plan too large (64 KB max).'},413);
  let plan;
  try{plan=parsePlan(text);}catch(e){return response({error:'invalid_plan',problems:e.problems||['Could not read the plan.']},400);}
  const pending=await env.DB.prepare("SELECT count(*) AS n FROM plans WHERE status='pending'").first();
  if(pending.n>=10)return response({error:'Ten plans are already waiting for review. Ask Noah to approve or reject some first.'},429);
  const id=crypto.randomUUID();
  await env.DB.prepare('INSERT INTO plans(id,received_at,title,note,calls) VALUES(?,?,?,?,?)').bind(id,iso(Date.now()),plan.title,plan.note,JSON.stringify(plan.calls)).run();
  return response({ok:true,plan_id:id,status:'pending',calls:plan.calls.length,review:'Waiting for Noah to approve it in the CallMe app. Nothing will call until he does.'},202);
}
export async function approvePlan(env,id,now=Date.now()){
  const plan=await env.DB.prepare("SELECT * FROM plans WHERE id=? AND status='pending'").bind(id).first();
  if(!plan)return {error:'This plan is no longer waiting for review.'};
  const calls=JSON.parse(plan.calls);
  const count=await env.DB.prepare('SELECT count(*) AS n FROM schedules').first();
  const stmts=[],skipped=[];
  for(const c of calls){
    try{validate({...c});}catch{skipped.push(c.label);continue;}   // e.g. the time has passed since it arrived
    if(count.n+stmts.length>=MAX_SCHEDULES){skipped.push(c.label);continue;}
    stmts.push(env.DB.prepare('INSERT INTO schedules(id,label,at,days,once_date,message,repeats,enabled,created_at,snooze_minutes,max_snoozes,retry_minutes,max_retries,source) VALUES(?,?,?,?,?,?,?,1,?,?,?,?,?,?)')
      .bind(crypto.randomUUID(),c.label,c.at,c.days,c.once_date,c.message,c.repeats,iso(now),c.snooze_minutes,c.max_snoozes,c.retry_minutes,c.max_retries,'plan:'+id));
  }
  const result=`Added ${stmts.length} of ${calls.length} call${calls.length===1?'':'s'}`+(skipped.length?`; skipped ${skipped.length} (time already passed or schedule limit): ${skipped.join(', ').slice(0,300)}`:'');
  stmts.push(env.DB.prepare("UPDATE plans SET status='approved',decided_at=?,result=? WHERE id=? AND status='pending'").bind(iso(now),result,id));
  await env.DB.batch(stmts);
  return {ok:true,result};
}
const MAX_SCHEDULES=100;
export default {
 async fetch(req,env) {
  if(!env.UI_PASSWORD)return new Response('Owner login is not configured.',{status:503,headers:security});
  const loginUrl=new URL(req.url);
  // Machine endpoint for proposed plans. Its own token; it can only queue plans for review.
  if(loginUrl.pathname==='/inbox/plan')return receivePlan(req,env);
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
    await env.DB.prepare("UPDATE plans SET status='expired',decided_at=? WHERE status='pending' AND received_at<?").bind(iso(Date.now()),iso(Date.now()-7*86400000)).run();
    const plans=await env.DB.prepare("SELECT * FROM plans WHERE status='pending' OR decided_at>=? ORDER BY received_at DESC LIMIT 15").bind(iso(Date.now()-3*86400000)).all();
    const followups=await env.DB.prepare("SELECT f.id,f.kind,f.due_at,f.snoozes,f.retries,s.label FROM followups f JOIN schedules s ON s.id=f.schedule_id WHERE f.status='pending' ORDER BY f.due_at").all();
    return response({callingConnected:!!env.CALLME_SECRET,planInbox:!!env.PLAN_TOKEN,paused:!settings||!!settings.paused,schedules:schedules.results,runs:runs.results,
      plans:plans.results.map(p=>({...p,calls:JSON.parse(p.calls)})),followups:followups.results});
   }
   if(req.method!=='POST')return response({error:'Not found'},404);
   // JSON + custom header + strict origin blocks cross-site form and fetch CSRF.
   if(req.headers.get('Origin')!==url.origin || req.headers.get('X-Alarm-UI')!=='1'||!req.headers.get('Content-Type')?.startsWith('application/json'))return response({error:'Forbidden'},403);
   if(Number(req.headers.get('Content-Length')||0)>8192)return response({error:'Request too large'},413);
   const text=await req.text(); if(text.length>8192)return response({error:'Request too large'},413);
   const s=JSON.parse(text);
   if(url.pathname==='/api/pause') {
    if(s.paused===false && !env.CALLME_SECRET)return response({error:'Calling is not connected. Owner activation is required.'},409);
    if(typeof s.paused!=='boolean')return response({error:'Invalid pause state'},400);
    await env.DB.prepare('UPDATE settings SET paused=? WHERE id=1').bind(s.paused?1:0).run();return response({ok:true});
   }
   if(url.pathname==='/api/save') {
    validate(s);const id=s.id||crypto.randomUUID();
    const f=[s.snooze_minutes,s.max_snoozes,s.retry_minutes,s.max_retries];
    if(s.id) {
      const r=await env.DB.prepare('UPDATE schedules SET label=?,at=?,days=?,once_date=?,message=?,repeats=?,enabled=?,snooze_minutes=?,max_snoozes=?,retry_minutes=?,max_retries=? WHERE id=?').bind(s.label.trim(),s.at,s.days,s.days==='once'?s.once_date:'',s.message.trim(),s.repeats,s.enabled===true?1:0,...f,id).run();
      if(!r.meta.changes)return response({error:'Not found'},404);
      await cancelFollowups(env,id);
    } else {
      const count=await env.DB.prepare('SELECT count(*) AS n FROM schedules').first();
      if(count.n>=MAX_SCHEDULES)return response({error:`Maximum ${MAX_SCHEDULES} schedules. Remove an old schedule first.`},400);
      await env.DB.prepare('INSERT INTO schedules(id,label,at,days,once_date,message,repeats,enabled,created_at,snooze_minutes,max_snoozes,retry_minutes,max_retries,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,s.label.trim(),s.at,s.days,s.days==='once'?s.once_date:'',s.message.trim(),s.repeats,s.enabled===true?1:0,new Date().toISOString(),...f,'ui').run();
    }
    return response({ok:true});
   }
   if(url.pathname==='/api/test') {
    if(!env.CALLME_SECRET)return response({error:'Calling is not connected. Owner activation is required.'},409);
    const sched=await env.DB.prepare('SELECT * FROM schedules WHERE id=?').bind(s.id).first();
    if(!sched)return response({error:'Not found'},404);
    const recent=await env.DB.prepare("SELECT count(*) AS n FROM runs WHERE fire_key LIKE 'test|%' AND started_at>=?").bind(new Date(Date.now()-60000).toISOString()).first();
    if(recent.n)return response({error:'Wait a minute between test calls.'},429);
    const key='test|'+crypto.randomUUID();
    await env.DB.prepare("INSERT INTO runs(fire_key,schedule_id,label,started_at,result,decided) VALUES(?,?,?,?,'Sending',1)").bind(key,sched.id,'Test: '+sched.label,new Date().toISOString()).run();
    let result='Test failed. Check the CallMe backend.',callId=null;
    // A test speaks the same menu, but pressing 2 or not answering never starts a snooze or retry.
    try {callId=await placeCall(env,{...sched,message:spoken(sched)},{test:true});result='Test call requested';} catch {}
    await env.DB.prepare('UPDATE runs SET result=?,call_id=? WHERE fire_key=?').bind(result,callId,key).run();
    return callId?response({ok:true}):response({error:result},502);
   }
   if(url.pathname==='/api/toggle') {
    await env.DB.prepare('UPDATE schedules SET enabled=1-enabled WHERE id=?').bind(s.id).run();
    const now=await env.DB.prepare('SELECT enabled FROM schedules WHERE id=?').bind(s.id).first();
    if(now&&!now.enabled)await cancelFollowups(env,s.id);
    return response({ok:true});
   }
   if(url.pathname==='/api/delete') {
    await cancelFollowups(env,s.id);
    await env.DB.prepare('DELETE FROM schedules WHERE id=?').bind(s.id).run();return response({ok:true});
   }
   if(url.pathname==='/api/followup/cancel') {
    await env.DB.prepare("UPDATE followups SET status='cancelled' WHERE id=? AND status='pending'").bind(s.id).run();return response({ok:true});
   }
   if(url.pathname==='/api/plan/approve') {
    const r=await approvePlan(env,String(s.id||''));
    return r.ok?response(r):response({error:r.error},409);
   }
   if(url.pathname==='/api/plan/reject') {
    await env.DB.prepare("UPDATE plans SET status='rejected',decided_at=?,result='Rejected by Noah' WHERE id=? AND status='pending'").bind(iso(Date.now()),String(s.id||'')).run();return response({ok:true});
   }
   return response({error:'Not found'},404);
  } catch(e) {return response({error:e instanceof SyntaxError?'Invalid request':/^(Use|Choose|Message) /.test(String(e.message))?e.message:'Could not save or load. Please try again.'},400);}
 },
 async scheduled(event,env,ctx) {
   // Scheduled dispatch is independent of the UI browser and any assistant.
   // Dispatch errors fail closed; no call retries. Cron runs can start a little
   // late, so allow up to 5 minutes before treating an event as stale. The
   // fire_key claim in tick() still stops any duplicate within a minute.
   if(Math.abs(Date.now()-event.scheduledTime)>5*60000)return;
   await tick(env,event.scheduledTime,(s,chain)=>placeCall(env,s,chain.kind?{kind:chain.kind,snoozes:chain.snoozes,retries:chain.retries}:{}));
   await followUp(env,event.scheduledTime);
   // One-time schedules that already ran more than two days ago are removed so plans don't pile up.
   const old=localParts(event.scheduledTime-2*86400000).date;
   await env.DB.prepare("DELETE FROM schedules WHERE days='once' AND enabled=0 AND once_date<? AND id NOT IN (SELECT schedule_id FROM followups WHERE status='pending')").bind(old).run();
   await env.DB.prepare("DELETE FROM followups WHERE status!='pending' AND created_at<?").bind(iso(event.scheduledTime-90*86400000)).run();
   // Keep a bounded 90-day activity ledger. Schedule history is independent of
   // Railway's existing call history, which is neither copied nor modified.
   await env.DB.prepare('DELETE FROM runs WHERE started_at < ?').bind(new Date(event.scheduledTime-90*86400000).toISOString()).run();
 }
};
