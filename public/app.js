const $=id=>document.getElementById(id);
let state={paused:true,schedules:[],runs:[]};
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
function reset() {$('editor').reset();$('id').value='';$('form-title').textContent='New schedule';$('cancel').hidden=true;dates();}
function dates() {$('date-row').hidden=$('days').value!=='once';$('once').required=$('days').value==='once';}
function render() {
 $('status').textContent=!state.callingConnected?'Calling is not connected. This interface saves schedules only. Owner setup is required before calls can work.':state.paused?'All calling is paused. Schedules can be saved, but none will call until you resume calling here.':'Calling is enabled. Only schedules marked On can place calls.';
 $('global-badge').textContent=state.paused?'Paused':'Enabled';
 $('pause-note').textContent=state.paused?'You control when calling resumes. No assistant action is needed.':'Pause every schedule at once without deleting it.';
 $('pause').textContent=state.paused?'Resume calling':'Pause all calls';$('pause').disabled=!state.callingConnected;
 if(!state.callingConnected){$('pause').textContent='Calling not connected';$('pause-note').textContent='No calling credentials or live trigger have been installed. You can save schedules, but this app cannot place calls.';}
 $('schedules').replaceChildren();
 if(!state.schedules.length){const empty=el('div','card empty');empty.append(el('div','icon','◷'),el('h3','','A quieter way to plan'),el('p','muted','Start with a time and a message. Your saved alarms will appear here.'));$('schedules').append(empty);}
 for(const s of state.schedules){
  const card=el('article','card');const top=el('div','top');top.append(el('h3','',s.label),el('span','badge'+(s.enabled?' on':''),s.enabled?'On':'Off'));
  card.append(top,el('div','time',s.at),el('div','muted',(s.days==='once'?s.once_date+' · One time':dayNames[s.days])+' · Eastern Time'),el('div','quote',s.message),el('p','muted',`Message repeats ${s.repeats} time${s.repeats>1?'s':''} in one call. No retry or snooze.`));
  const actions=el('div','actions');
  const edit=el('button','secondary','Edit');edit.onclick=()=>{for(const key of ['id','label','at','days','message','repeats'])$(key).value=s[key];$('once').value=s.once_date;$('enabled').checked=!!s.enabled;$('form-title').textContent='Edit schedule';$('cancel').hidden=false;dates();$('editor').scrollIntoView({behavior:'smooth',block:'start'});};
  const toggle=el('button','secondary',s.enabled?'Turn off':'Turn on');toggle.onclick=async()=>{if(s.enabled||await confirmAction('Turn on this schedule?',state.paused?'Master pause is still on. This schedule can call after you resume calling.':'This schedule can place a call at its next selected time. Existing call-service charges apply.','Turn on'))await change('toggle',{id:s.id});};
  const del=el('button','danger','Delete');del.onclick=async()=>{if(await confirmAction('Delete this schedule?',s.label+' at '+s.at+' will be removed. Past activity stays in your history.','Delete schedule'))await change('delete',{id:s.id});};
  const test=el('button','secondary','Test call now');test.disabled=!state.callingConnected;test.onclick=async()=>{if(await confirmAction('Call your phone now?','Places one real call with this message right away, even while calling is paused. Existing call-service charges apply.','Call now'))await change('test',{id:s.id});};
  actions.append(edit,toggle,test,del);card.append(actions);$('schedules').append(card);
 }
 $('activity').replaceChildren();
 if(!state.runs.length)$('activity').append(el('p','muted','No scheduled calls have run yet.'));
 for(const r of state.runs){const item=el('div','activity');item.append(el('strong','',r.label),el('br'),document.createTextNode(new Date(r.started_at).toLocaleString('en-US',{timeZone:'America/New_York'})+' ET · '+r.result));$('activity').append(item);}
}
$('days').onchange=dates;$('cancel').onclick=reset;
$('pause').onclick=async()=>{
 if(state.paused&&!await confirmAction('Resume calling?', 'Enabled schedules can place calls at the times you choose. Your existing call-service charges still apply. A call already being sent cannot be recalled.','Resume calling'))return;
 await change('pause',{paused:!state.paused});
};
$('editor').onsubmit=async event=>{
 event.preventDefault();if(busy)return;
 const s={};for(const key of ['id','label','at','days','message'])s[key]=$(key).value;
 s.once_date=$('once').value;s.repeats=Number($('repeats').value);s.enabled=$('enabled').checked;
 if(s.enabled&&!state.paused&&!await confirmAction('Save an enabled schedule?', 'It can place a call at its next selected time. Existing call-service charges apply.','Save and enable'))return;
 busy=true;$('save').disabled=true;error('');
 try {await api('save',s);reset();await refresh();$('status').textContent='Schedule saved. '+(state.paused?'All calling remains paused.':'Only enabled schedules can call.');}catch(e){error(e.message);}finally{busy=false;$('save').disabled=false;}
};
refresh().catch(e=>{error(e.message);$('status').textContent='Could not load your schedules. No changes were made.';});
