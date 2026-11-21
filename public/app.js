const $=id=>document.getElementById(id);
let state={paused:true,schedules:[],runs:[],drafts:[],followups:[],quiet:{start:'22:30',end:'05:00'}};
let busy=false;
const dayNames={'0,1,2,3,4':'Weekdays','0,1,2,3,4,5,6':'Every day','5,6':'Weekends'};
function el(tag, cls, text) { const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e; }
function error(message) {$('error').hidden=!message;$('error').textContent=message||'';}
async function api(path,data) {
 const r=await fetch('/api/'+path,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Alarm-UI':'1'},body:JSON.stringify(data)});
 if(r.status===401)throw Error('Your login is required. Reload this page to sign in.');
 const body=await r.json();if(!r.ok)throw Error(body.error||'Request failed.');return body;
}
async function refresh() { state=await api('state');render(); }
async function change(path,data) {
 if(busy)return;busy=true;error('');
 try {await api(path,data);await refresh();} catch(e){error(e.message);} finally{busy=false;}
}
function confirmAction(title,note,yes='Confirm') {
 $('confirm-title').textContent=title;$('confirm-note').textContent=note;$('confirm-yes').textContent=yes;
 return new Promise(resolve=>{
  const end=value=>{$('confirm').close();resolve(value);};
  $('confirm-yes').onclick=()=>end(true);$('confirm-no').onclick=()=>end(false);
  $('confirm').oncancel=()=>resolve(false);$('confirm').showModal();
 });
}
const FIELDS=['id','label','at','days','message','repeats','snooze_minutes','if_unacknowledged','retry_minutes','max_retries'];
const NUMS=['repeats','snooze_minutes','retry_minutes','max_retries'];
const t12=at=>{const [h,m]=at.split(':').map(Number);return `${h%12||12}:${String(m).padStart(2,'0')} ${h<12?'AM':'PM'}`;};
const longDate=d=>new Date(d+'T12:00:00Z').toLocaleDateString('en-US',{timeZone:'UTC',weekday:'long',month:'long',day:'numeric',year:'numeric'});
const shortDate=d=>new Date(d+'T12:00:00Z').toLocaleDateString('en-US',{timeZone:'UTC',weekday:'short',month:'short',day:'numeric'});
const et=iso=>new Date(iso).toLocaleString('en-US',{timeZone:'America/New_York',weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
const quiet=at=>at>=state.quiet.start||at<state.quiet.end;
function until(iso){const m=Math.round((Date.parse(iso)-Date.now())/60000);if(m<=0)return 'time has passed';const d=Math.floor(m/1440),h=Math.floor(m%1440/60),mm=m%60;return 'in '+[d&&d+' d',h&&h+' h',(!d&&mm)&&mm+' min'].filter(Boolean).join(' ');}
const mode=s=>s.until_ack?'keep_calling':s.retry_minutes?'retry':'none';
function extras(s){
 const parts=[`Message plays ${s.repeats}×`];
 parts.push(s.snooze_minutes?`press 2 snoozes ${s.snooze_minutes} min (once)`:'no snooze');
 const m=s.if_unacknowledged||mode(s), every=s.retry_every_minutes||s.retry_minutes;
 parts.push(m==='keep_calling'?`if you don't press 1, calls again every ${every} min until you do (stops at quiet hours or after 2 h)`:m==='retry'?`if you don't press 1, calls again every ${every} min up to ${s.max_retries}×`:'no repeat calls');
 if(s.late_ok||s.allow_quiet_hours)parts.push('ALLOWED during quiet hours');
 return parts.join(' · ');
}
function spokenText(s){
 const m=s.if_unacknowledged||mode(s),upd=' Press 3 to leave a spoken update.';
 if(!s.snooze_minutes&&m==='none')return s.message+upd;
 if(s.snooze_minutes)return s.message+` Press 1 if you're up. Press 2 to snooze for ${s.snooze_minutes} minutes.`+upd;
 return s.message+(m==='keep_calling'?" Press 1 when you're getting out of bed. I'll keep calling until you do.":' Press 1 to confirm.')+upd;
}
function readiness(){
 if(!state.callingConnected)return 'Calling is not connected: approved calls would be saved but cannot ring.';
 if(state.paused)return 'Master pause is ON: approved calls are saved but will not ring until you resume calling.';
 return 'Calling is on: approved calls will ring at the times shown.';
}
const STATUS={pending:'Waiting for your OK',approving:'Approving…',approved:'Approved',rejected:'Rejected',expired:'Expired'};
function renderDrafts(){
 $('drafts').replaceChildren();
 for(const d of state.drafts){
  const card=el('article','card plan'+(d.status==='pending'?' pending':''));
  const top=el('div','top');top.append(el('h2','',d.title),el('span','badge'+(d.status==='approved'?' on':''),STATUS[d.status]||d.status));
  card.append(top,el('div','muted',`Draft ${d.id} · ${d.via==='paste'?'pasted by you':'sent by Instinct'} · received ${et(d.received_at)} ET`));
  if(d.note)card.append(el('p','',d.note));
  if(d.status!=='pending'){card.append(el('p','muted',d.result||''));$('drafts').append(card);continue;}
  const list=el('ol','plan-calls');
  for(const c of d.commands){
   const li=el('li');
   if(c.action==='cancel'){
    const t=c.target;
    li.append(el('div','plan-when danger-text','CANCEL'),el('strong','',t?.label||c.reminder_id),el('div','muted',t?`${et(t.call_at)} ET · currently ${t.status==='cancelled'?'already cancelled':t.enabled?'armed':'already ran or turned off'} · revision ${t.revision??'?'} (expects ${c.expected_revision})`:'Unknown reminder'),el('div','muted','Reminder '+c.reminder_id));
   } else if(c.action==='replace'){
    const t=c.target,q=quiet(c.local.at);
    const was=t?`${et(t.call_at)} ET · ${t.status==='replaced'?'already replaced':t.status==='cancelled'?'already cancelled':t.enabled?'armed':'already ran or turned off'} · revision ${t.revision??'?'} (expects ${c.expected_revision})`:'Unknown reminder';
    li.append(el('div','plan-when','CHANGE'),
     el('div','muted','Replaces: '+(t?.label||c.reminder_id)+' · '+was),
     ...(t?.message?[el('div','muted','Old message: “'+t.message+'”')]:[]),
     el('div','plan-when',`New: ${longDate(c.local.date)} · ${t12(c.local.at)} ${c.timezone} (UTC${c.local.offset}) · ${until(c.call_at)}`),el('strong','',c.label),
     el('div','quote','“'+spokenText({...c,...c.policy})+'”'),el('div','muted',extras({...c.policy,message:c.message})),
     el('div','muted',`Calls your phone ending 0221 · new reminder ${c.new_reminder_id}`+(c.planned_text_at?` · text planned ${et(c.planned_text_at)} ET`:'')),
     el('div','muted','If a call for the old reminder is ringing when you approve, nothing changes and Instinct is told.'));
    if(q)li.append(el('div','danger-text','Quiet hours: approving this allows a call between 10:30 PM and 5:00 AM.'));
   } else {
    const q=quiet(c.local.at);
    li.append(el('div','plan-when',`${longDate(c.local.date)} · ${t12(c.local.at)} ${c.timezone} (UTC${c.local.offset}) · ${until(c.call_at)}`),el('strong','',c.label),
     el('div','quote','“'+spokenText({...c,...c.policy})+'”'),el('div','muted',extras({...c.policy,message:c.message})),
     el('div','muted',`Calls your phone ending 0221 · reminder ${c.reminder_id}`+(c.planned_text_at?` · text planned ${et(c.planned_text_at)} ET`:'')));
    if(q)li.append(el('div','danger-text','Quiet hours: approving this allows a call between 10:30 PM and 5:00 AM.'));
   }
   list.append(li);
  }
  card.append(list,el('p','muted',readiness()+' Calls whose time has passed are not scheduled. You can still edit or delete each one afterwards.'));
  const actions=el('div','actions');
  const ok=el('button','','Approve');ok.onclick=async()=>{if(await confirmAction('Approve this draft exactly as shown?',`${d.commands.length} change${d.commands.length===1?'':'s'}. New calls are turned on; cancellations take effect now.`,'Approve'))await change('draft/approve',{id:d.id,hash:d.hash});};
  const no=el('button','danger','Reject');no.onclick=async()=>{if(await confirmAction('Reject this draft?','Nothing in it is scheduled or cancelled. Instinct can send a corrected proposal.','Reject draft'))await change('draft/reject',{id:d.id,hash:d.hash});};
  actions.append(ok,no);card.append(actions);$('drafts').append(card);
 }
}
function renderFollowups(){
 $('followups').replaceChildren();
 if(!state.followups.length)return;
 const card=el('div','card');card.append(el('h2','','Coming up: snoozes and repeat calls'));
 for(const f of state.followups){
  const row=el('div','activity top');row.append(el('span','',`${f.label} · ${f.kind==='snooze'?'snoozed call':'repeat call'} at ${et(f.due_at)} ET`));
  const b=el('button','secondary','Cancel');b.onclick=async()=>{if(await confirmAction('Cancel this call?','This '+(f.kind==='snooze'?'snoozed':'repeat')+' call for '+f.label+' will not be placed, and no further ones will follow from it.','Cancel call'))await change('followup/cancel',{id:f.id});};
  row.append(b);card.append(row);
 }
 $('followups').append(card);
}
function policyFields(){
 const m=$('if_unacknowledged').value;
 $('retry-row').hidden=m==='none';$('max-retries-box').hidden=m!=='retry';
 $('policy-note').textContent=($('snooze_minutes').value!=='0'?'The call ends with "Press 1 if you\'re up. Press 2 to snooze." After the snooze, it says "Press 1 when you\'re getting out of bed." ':'')+(m==='keep_calling'?'Hanging up, voicemail or any other key counts as not pressing 1. Repeat calls stop when you press 1, at 10:30 PM unless allowed, or after 2 hours as a safety limit.':'');
}
function reset() {$('editor').reset();$('id').value='';$('form-title').textContent='New schedule';$('cancel').hidden=true;dates();}
function dates() {policyFields();$('date-row').hidden=$('days').value!=='once';$('once').required=$('days').value==='once';}
function render() {
 renderDrafts();renderFollowups();
 $('email-check').hidden=!state.emailCheck;$('braindump').disabled=!state.callingConnected;$('email-check-note').hidden=!state.emailCheck;
 $('status').textContent=!state.callingConnected?'Calling is not connected. This interface saves schedules only. Owner setup is required before calls can work.':state.paused?'All calling is paused. Schedules can be saved, but none will call until you resume calling here.':'Calling is enabled. Only schedules marked On can place calls.';
 $('global-badge').textContent=state.paused?'Paused':'Enabled';
 $('pause-note').textContent=state.paused?'You control when calling resumes. No assistant action is needed.':'Pause every schedule at once without deleting it.';
 $('pause').textContent=state.paused?'Resume calling':'Pause all calls';$('pause').disabled=!state.callingConnected;
 if(!state.callingConnected){$('pause').textContent='Calling not connected';$('pause-note').textContent='No calling credentials or live trigger have been installed. You can save schedules, but this app cannot place calls.';}
 $('schedules').replaceChildren();
 if(!state.schedules.length){const empty=el('div','card empty');empty.append(el('div','icon','◷'),el('h3','','A quieter way to plan'),el('p','muted','Start with a time and a message. Your saved alarms will appear here.'));$('schedules').append(empty);}
 for(const s of state.schedules){
  const gone=s.reminder_status&&s.reminder_status!=='active';
  const card=el('article','card'+(gone?' retired':''));const top=el('div','top');
  top.append(el('h3','',s.label),el('span','badge'+(s.enabled&&!gone?' on':''),gone?(s.reminder_status==='replaced'?'Replaced':'Cancelled'):s.enabled?'On':'Off'));
  card.append(top);
  if(gone)card.append(el('p','danger-text',s.reminder_status==='replaced'?`Replaced by reminder ${s.replaced_by}. This one will not ring.`:'Cancelled by an approved proposal. This one will not ring.'));
  card.append(el('div','time',s.at),el('div','muted',(s.days==='once'?shortDate(s.once_date)+' · One time':dayNames[s.days])+' · Eastern Time'+(s.reminder_id?` · reminder ${s.reminder_id} rev ${s.revision}`:'')),el('div','quote',spokenText(s)),el('p','muted',extras(s)));
  const actions=el('div','actions');
  const edit=el('button','secondary','Edit');edit.onclick=()=>{for(const key of ['id','label','at','days','message','repeats','snooze_minutes'])$(key).value=s[key];$('if_unacknowledged').value=mode(s);$('retry_minutes').value=s.retry_minutes||3;$('max_retries').value=s.max_retries||2;$('late_ok').checked=!!s.late_ok;$('once').value=s.once_date;$('enabled').checked=!!s.enabled;$('form-title').textContent='Edit schedule';$('cancel').hidden=false;dates();$('editor').scrollIntoView({behavior:'smooth',block:'start'});};
  const toggle=el('button','secondary',s.enabled?'Turn off':'Turn on');toggle.onclick=async()=>{if(s.enabled||await confirmAction('Turn on this schedule?',state.paused?'Master pause is still on. This schedule can call after you resume calling.':'This schedule can place a call at its next selected time. Existing call-service charges apply.','Turn on'))await change('toggle',{id:s.id});};
  const del=el('button','danger','Delete');del.onclick=async()=>{if(await confirmAction('Delete this schedule?',s.label+' at '+s.at+' will be removed. Past activity stays in your history.','Delete schedule'))await change('delete',{id:s.id});};
  const test=el('button','secondary','Test call now');test.disabled=!state.callingConnected;test.onclick=async()=>{if(await confirmAction('Call your phone now?','Places one real call with this message right away, even while calling is paused. Existing call-service charges apply.','Call now'))await change('test',{id:s.id});};
  if(gone)actions.append(del);else actions.append(edit,toggle,test,del);card.append(actions);$('schedules').append(card);
 }
 $('activity').replaceChildren();
 if(!state.runs.length)$('activity').append(el('p','muted','No scheduled calls have run yet.'));
 for(const r of state.runs){const item=el('div','activity');item.append(el('strong','',r.label),el('br'),document.createTextNode(new Date(r.started_at).toLocaleString('en-US',{timeZone:'America/New_York'})+' ET · '+r.result));$('activity').append(item);}
}
$('days').onchange=dates;
$('snooze_minutes').onchange=policyFields;$('if_unacknowledged').onchange=policyFields;
$('braindump').onclick=async()=>{if(busy)return;busy=true;error('');const b=$('braindump');b.disabled=true;
 try{await api('braindump',{});await refresh();$('status').textContent='Calling you now. Press 1 when it asks, then talk. Press # or hang up when you\'re done.';}
 catch(e){error(e.message);}finally{busy=false;b.disabled=false;}};
$('email-check').onclick=async()=>{if(busy)return;busy=true;error('');const b=$('email-check');b.disabled=true;b.textContent='Checking…';
 try{const r=await api('proposals/check',{});await refresh();
  const parts=[];if(r.staged)parts.push(`${r.staged} new proposal${r.staged>1?'s':''} staged as draft${r.staged>1?'s':''}; review at the top`);
  if(r.problems)parts.push(`${r.problems} had problems (Instinct was told what to fix)`);if(r.already)parts.push(`${r.already} already received`);
  if(r.rejected)parts.push(`${r.rejected} ignored: sender could not be verified`);
  $('status').textContent=r.busy?'A check was already running. Try again in a few seconds.':parts.length?parts.join('. ')+'.':'No new proposal emails.';}
 catch(e){error(e.message);}finally{busy=false;b.disabled=false;b.textContent='Check email now';}};
$('paste-go').onclick=async()=>{const text=$('paste').value.trim();if(!text)return;if(busy)return;busy=true;error('');
 try{const r=await api('draft/paste',{text});$('paste').value='';await refresh();$('status').textContent=r.draft_id?'Proposal staged as a draft. Review it at the top before approving.':'Already received earlier; nothing new was staged.';}catch(e){error(e.message);}finally{busy=false;}};
$('cancel').onclick=reset;
$('pause').onclick=async()=>{
 if(state.paused&&!await confirmAction('Resume calling?', 'Enabled schedules can place calls at the times you choose. Your existing call-service charges still apply. A call already being sent cannot be recalled.','Resume calling'))return;
 await change('pause',{paused:!state.paused});
};
$('editor').onsubmit=async event=>{
 event.preventDefault();if(busy)return;
 const s={};for(const key of FIELDS)s[key]=NUMS.includes(key)?Number($(key).value):$(key).value;
 s.once_date=$('once').value;s.enabled=$('enabled').checked;s.late_ok=$('late_ok').checked;
 if(s.enabled&&!state.paused&&!await confirmAction('Save an enabled schedule?', 'It can place a call at its next selected time. Existing call-service charges apply.','Save and enable'))return;
 busy=true;$('save').disabled=true;error('');
 try {await api('save',s);reset();await refresh();$('status').textContent='Schedule saved. '+(state.paused?'All calling remains paused.':'Only enabled schedules can call.');}catch(e){error(e.message);}finally{busy=false;$('save').disabled=false;}
};
refresh().catch(e=>{error(e.message);$('status').textContent='Could not load your schedules. No changes were made.';});
