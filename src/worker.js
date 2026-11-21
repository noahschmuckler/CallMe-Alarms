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
function validate(s) {
  if(typeof s.label!=='string'||!s.label.trim()||s.label.length>80)throw Error('Use a name from 1 to 80 characters.');
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.at)||!DAYS.includes(s.days))throw Error('Choose a valid time and repeat pattern.');
  if(typeof s.message!=='string'||!s.message.trim()||s.message.length>800)throw Error('Use a message from 1 to 800 characters.');
  if(!Number.isInteger(s.repeats)||s.repeats<1||s.repeats>5)throw Error('Message repeats must be 1 to 5.');
  if(s.days==='once') {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(s.once_date)||new Date(s.once_date+'T00:00:00Z').toISOString().slice(0,10)!==s.once_date)throw Error('Choose a valid future date.');
    const now=localParts(Date.now());
    if(s.once_date+'T'+s.at<=now.date+'T'+now.at)throw Error('Choose a future time for a one-time call.');
  }
}
export async function tick(env, when, dispatch) {
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
      WHERE s.id=? AND s.enabled=1 AND p.id=1 AND p.paused=0`).bind(key,new Date(when).toISOString(),s.id).run();
    if(!claim.meta.changes)continue;
    let result='Uncertain or failed. Not retried.', callId=null;
    try {
      callId=await dispatch(s);
      result='Call requested';
    } catch { /* Never retry an ambiguous call request. */ }
    await env.DB.prepare('UPDATE runs SET result=?,call_id=? WHERE fire_key=?').bind(result,callId,key).run();
    if(s.days==='once')await env.DB.prepare('UPDATE schedules SET enabled=0 WHERE id=?').bind(s.id).run();
  }
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
// After a request, ask the backend how the call went and record it in the
// activity log, so "Call requested" becomes e.g. "completed" or "no-answer".
async function followUp(env) {
  if(!env.CALLME_SECRET)return;
  const since=new Date(Date.now()-30*60000).toISOString();
  const open=await env.DB.prepare("SELECT fire_key,call_id,result FROM runs WHERE call_id IS NOT NULL AND started_at>=? ORDER BY started_at DESC LIMIT 5").bind(since).all();
  for(const run of open.results) {
    const base=run.result.split(' · ')[0];
    const last=(run.result.split(' · ')[1]||'').toLowerCase();
    if(FINAL.some(f=>last.startsWith(f)))continue;
    try {
      const r=await fetch(CALLME+'/v1/call/'+encodeURIComponent(run.call_id),{headers:{'Authorization':'Bearer '+env.CALLME_SECRET},signal:AbortSignal.timeout(10000)});
      if(!r.ok)continue;
      const j=await r.json();
      let status=String(j.status||'').slice(0,40);
      const ack=j.acknowledged??j.ack??j.acknowledgement;
      if(ack===true||(ack&&typeof ack==='object'))status+=status?', acknowledged':'acknowledged';
      if(status)await env.DB.prepare('UPDATE runs SET result=? WHERE fire_key=?').bind(base+' · '+status,run.fire_key).run();
    } catch { /* Status is informational only. */ }
  }
}
export default {
 async fetch(req,env) {
  if(!env.UI_PASSWORD)return new Response('Owner login is not configured.',{status:503,headers:security});
  const loginUrl=new URL(req.url);
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
    return response({callingConnected:!!env.CALLME_SECRET,paused:!settings||!!settings.paused,schedules:schedules.results,runs:runs.results});
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
    if(s.id) {
      const r=await env.DB.prepare('UPDATE schedules SET label=?,at=?,days=?,once_date=?,message=?,repeats=?,enabled=? WHERE id=?').bind(s.label.trim(),s.at,s.days,s.days==='once'?s.once_date:'',s.message.trim(),s.repeats,s.enabled===true?1:0,id).run();
      if(!r.meta.changes)return response({error:'Not found'},404);
    } else {
      const count=await env.DB.prepare('SELECT count(*) AS n FROM schedules').first();
      if(count.n>=50)return response({error:'Maximum 50 schedules. Remove an old schedule first.'},400);
      await env.DB.prepare('INSERT INTO schedules(id,label,at,days,once_date,message,repeats,enabled,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,s.label.trim(),s.at,s.days,s.days==='once'?s.once_date:'',s.message.trim(),s.repeats,s.enabled===true?1:0,new Date().toISOString()).run();
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
    await env.DB.prepare("INSERT INTO runs(fire_key,schedule_id,label,started_at,result) VALUES(?,?,?,?,'Sending')").bind(key,sched.id,'Test: '+sched.label,new Date().toISOString()).run();
    let result='Test failed. Check the CallMe backend.',callId=null;
    try {callId=await placeCall(env,sched,{test:true});result='Test call requested';} catch {}
    await env.DB.prepare('UPDATE runs SET result=?,call_id=? WHERE fire_key=?').bind(result,callId,key).run();
    return callId?response({ok:true}):response({error:result},502);
   }
   if(url.pathname==='/api/toggle') {
    await env.DB.prepare('UPDATE schedules SET enabled=1-enabled WHERE id=?').bind(s.id).run();return response({ok:true});
   }
   if(url.pathname==='/api/delete') {
    await env.DB.prepare('DELETE FROM schedules WHERE id=?').bind(s.id).run();return response({ok:true});
   }
   return response({error:'Not found'},404);
  } catch(e) {return response({error:e instanceof SyntaxError?'Invalid request':String(e.message).startsWith('Use ')||String(e.message).startsWith('Choose ')?e.message:'Could not save or load. Please try again.'},400);}
 },
 async scheduled(event,env,ctx) {
   // Scheduled dispatch is independent of the UI browser and any assistant.
   // Dispatch errors fail closed; no call retries. Cron runs can start a little
   // late, so allow up to 5 minutes before treating an event as stale. The
   // fire_key claim in tick() still stops any duplicate within a minute.
   if(Math.abs(Date.now()-event.scheduledTime)>5*60000)return;
   await tick(env,event.scheduledTime,s=>placeCall(env,s));
   await followUp(env);
   // Keep a bounded 90-day activity ledger. Schedule history is independent of
   // Railway's existing call history, which is neither copied nor modified.
   await env.DB.prepare('DELETE FROM runs WHERE started_at < ?').bind(new Date(event.scheduledTime-90*86400000).toISOString()).run();
 }
};
