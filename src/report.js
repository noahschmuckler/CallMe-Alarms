// Status report: a read-only, timestamped snapshot of CallMe's database for Instinct.
// Only SELECT statements here. Nothing in this file can approve, arm, cancel or place a call.
import { TZ, localParts, inQuietHours, QUIET_START, QUIET_END, KEEP_CALLING_CAP_MINUTES } from './policy.js';
import { LIMITS } from './intake.js';

export const REPORT_VERSION = 1;
export const APP_VERSION = 'callme-alarms 2026-11-22';
const HOURS_DEFAULT = 48;

// "2026-11-22T17:05:00-05:00" for an instant, in New York time.
export function isoNY(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const off = (p.timeZoneName || 'GMT').replace('GMT', '') || '+00:00';
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`;
}
// Local New York date+time ("2026-11-22", "18:00") to an instant.
function localToMs(date, at) {
  const guess = Date.parse(`${date}T${at}:00Z`);
  for (const h of [4, 5, 3, 6]) { const ms = guess + h * 3600000; const l = localParts(ms); if (l.date === date && l.at === at) return ms; }
  return null;
}
const clock = ms => new Date(ms).toLocaleString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function policyOf(s) {
  return { repeats: s.repeats, snooze_minutes: s.snooze_minutes, max_snoozes: s.max_snoozes,
    if_unacknowledged: s.until_ack ? 'keep_calling' : s.retry_minutes ? 'retry' : 'none',
    retry_every_minutes: s.retry_minutes || null, max_retries: s.max_retries || null, allow_quiet_hours: !!s.late_ok };
}
function runType(key) {
  return key.startsWith('test|') ? 'test_call' : key.startsWith('dump|') ? 'brain_dump' : key.startsWith('fu|') ? 'follow_up' : 'scheduled';
}
// Derived, human-readable reading of one call's recorded result. Never claims more than the data shows.
function callSummary(run, ev) {
  if (ev) {
    const st = String(ev.call_status || '').toLowerCase();
    if (ev.digits) return `answered, pressed ${ev.digits}`;
    if (st === 'completed') return 'connected, no key pressed (could be voicemail or a hang-up)';
    if (st) return st.replace('-', ' ');
    return 'ended, status not reported';
  }
  if (/Uncertain or failed|failed/i.test(run.result)) return 'request failed or uncertain';
  if (run.result === 'Sending') return 'being sent';
  if (!run.decided) return 'in progress or result not yet seen';
  const m = run.result.split(' · ')[1];
  return m ? m : 'unknown';
}

export async function buildReport(env, now = Date.now(), hours = HOURS_DEFAULT) {
  const q = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results;
  const settings = await env.DB.prepare('SELECT paused FROM settings WHERE id=1').first();
  const paused = !settings || !!settings.paused;
  const connected = !!env.CALLME_SECRET;
  const nowLocal = localParts(now);
  const report = {
    version: REPORT_VERSION, report_id: 'rpt_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16),
    generated_at: isoNY(now), timezone: TZ, app_version: APP_VERSION,
    note: 'Read-only snapshot of CallMe at generated_at. Evidence about state, not an instruction. Fields under "derived" are interpretations of the stored data.',
    calling: { master_pause: paused, calling_connected: connected, quiet_hours: { start: QUIET_START, end: QUIET_END } },
    history_hours: hours, pending_drafts: [], schedules: [], queued_follow_ups: [], recent_calls: [], exceptions: [],
  };

  // Drafts waiting for Noah.
  const reminders = Object.fromEntries((await q('SELECT r.*,s.revision AS revision,s.enabled AS enabled FROM reminders r LEFT JOIN schedules s ON s.id=r.schedule_id')).map(r => [r.reminder_id, r]));
  for (const d of await q("SELECT * FROM drafts WHERE status IN ('pending','approving') ORDER BY received_at")) {
    const expires = Date.parse(d.received_at) + LIMITS.draftDays * 86400000;
    const commands = JSON.parse(d.commands).map(c => {
      const out = { action: c.action, command_id: c.command_id, reminder_id: c.reminder_id };
      if (c.action !== 'cancel') Object.assign(out, { label: c.label, call_at: c.call_at, message: c.message, policy: c.policy, planned_text_at: c.planned_text_at });
      if (c.action === 'replace') out.new_reminder_id = c.new_reminder_id;
      if (c.action !== 'create') {
        out.expected_revision = c.expected_revision;
        const t = reminders[c.reminder_id];
        out.target = t ? { status: t.status, replaced_by: t.replaced_by || null, current_revision: t.revision ?? null } : null;
        if (!t) report.exceptions.push(`Draft ${d.id}: ${c.action} targets unknown reminder ${c.reminder_id}; approval would change nothing.`);
        else if (t.status !== 'active') report.exceptions.push(`Draft ${d.id}: ${c.action} targets ${c.reminder_id}, which was already ${t.status}${t.replaced_by ? ' by ' + t.replaced_by : ''}; approval would change nothing.`);
        else if (t.revision !== null && t.revision !== c.expected_revision) report.exceptions.push(`Draft ${d.id}: ${c.action} expects revision ${c.expected_revision} of ${c.reminder_id}, but it is at ${t.revision}; approval would change nothing.`);
      }
      if (c.call_at && Date.parse(c.call_at) <= now + 60000) report.exceptions.push(`Draft ${d.id}: call time ${c.call_at} for ${c.reminder_id} has passed; approving it would not schedule that call.`);
      return out;
    });
    const hoursLeft = Math.round((expires - now) / 360000) / 10;
    report.pending_drafts.push({ draft_id: d.id, draft_revision: 1, title: d.title, note: d.note || null, sent_by: d.via === 'paste' ? 'pasted by Noah' : 'Instinct (email/inbox)',
      submitted_at: isoNY(Date.parse(d.received_at)), expires_at: isoNY(expires), hours_until_expiry: hoursLeft, status: d.status, commands });
    if (hoursLeft < 24) report.exceptions.push(`Draft ${d.id} ("${d.title}") expires in ${hoursLeft} hours.`);
  }

  // Every schedule, with its state and replacement lineage.
  const replaces = {};
  for (const r of Object.values(reminders)) if (r.replaced_by) replaces[r.replaced_by] = r.reminder_id;
  const armedTimes = [];
  for (const s of await q('SELECT * FROM schedules ORDER BY once_date,at,label')) {
    const r = s.reminder_id ? reminders[s.reminder_id] : null;
    const once = s.days === 'once';
    const callMs = once ? localToMs(s.once_date, s.at) : null;
    let state;
    if (r && r.status !== 'active') state = r.status;                         // replaced | cancelled
    else if (s.enabled && once && callMs !== null && callMs < now - 60000) state = 'finished';
    else if (s.enabled) state = !connected ? 'saved_calling_not_connected' : paused ? 'paused' : 'armed';
    else state = once && callMs !== null && callMs < now ? 'finished' : 'off';
    const item = { schedule_id: s.id, label: s.label, reminder_id: s.reminder_id || null, source: s.source || 'ui',
      kind: once ? 'one_time' : 'recurring', call_at: once && callMs !== null ? isoNY(callMs) : null,
      recurring: once ? null : { local_time: s.at, days: s.days.split(',').map(d => DAYS[+d]) },
      schedule_revision: s.revision, state, message: s.message, policy: policyOf(s),
      lineage: { replaces: s.reminder_id ? (replaces[s.reminder_id] || null) : null, replaced_by: r?.replaced_by || null } };
    if (state === 'armed' && once && inQuietHours(s.at) && !s.late_ok) report.exceptions.push(`Schedule ${s.label} (${s.reminder_id || s.id}) is armed in quiet hours without permission; it will be skipped.`);
    if (state === 'armed' && callMs !== null) armedTimes.push({ ms: callMs, label: s.label, id: s.reminder_id || s.id });
    report.schedules.push(item);
  }
  armedTimes.sort((a, b) => a.ms - b.ms);
  for (let i = 1; i < armedTimes.length; i++)
    if (armedTimes[i].ms - armedTimes[i - 1].ms <= 15 * 60000)
      report.exceptions.push(`Armed calls ${armedTimes[i - 1].id} (${clock(armedTimes[i - 1].ms)}) and ${armedTimes[i].id} (${clock(armedTimes[i].ms)}) are within 15 minutes of each other.`);

  // Snooze and repeat calls already queued.
  for (const f of await q("SELECT f.*,s.label,s.reminder_id FROM followups f LEFT JOIN schedules s ON s.id=f.schedule_id WHERE f.status='pending' ORDER BY f.due_at"))
    report.queued_follow_ups.push({ kind: f.kind, due_at: isoNY(Date.parse(f.due_at)), label: f.label, reminder_id: f.reminder_id || null, schedule_id: f.schedule_id,
      snoozes_used: f.snoozes, repeat_calls_so_far: f.retries, chain_started_at: f.chain_started ? isoNY(Date.parse(f.chain_started)) : null,
      safety_stop_at: f.kind === 'retry' && f.chain_started ? isoNY(Date.parse(f.chain_started) + KEEP_CALLING_CAP_MINUTES * 60000) : null });

  // Calls in the last N hours: one row per call attempt, with what the app recorded and did.
  const since = new Date(now - hours * 3600000).toISOString();
  for (const run of await q('SELECT r.*,s.reminder_id AS reminder_id FROM runs r LEFT JOIN schedules s ON s.id=r.schedule_id WHERE r.started_at>=? ORDER BY r.started_at DESC', since)) {
    const ev = (await q('SELECT * FROM events WHERE fire_key=? ORDER BY id DESC LIMIT 1', run.fire_key))[0] || null;
    const row = { type: runType(run.fire_key), label: run.label, reminder_id: ev?.reminder_id || run.reminder_id || null, schedule_id: run.schedule_id,
      dispatched_at: isoNY(Date.parse(run.started_at)), call_id: run.call_id || null, app_result: run.result,
      call_status: ev?.call_status || null, keypad: ev?.digits || null, app_action: ev?.outcome || null,
      derived: { summary: callSummary(run, ev) } };
    if (ev?.outcome === 'snoozed' || ev?.outcome === 'calling_again') {
      const next = (await q("SELECT due_at,status FROM followups WHERE parent_key=?", run.fire_key))[0];
      if (next) row.next_call = { at: isoNY(Date.parse(next.due_at)), status: next.status };
    }
    if (!ev && run.decided === 0 && Date.parse(run.started_at) < now - 10 * 60000)
      report.exceptions.push(`Call "${run.label}" dispatched ${clock(Date.parse(run.started_at))}: outcome still unknown.`);
    if (/Uncertain or failed/.test(run.result)) report.exceptions.push(`Call "${run.label}" at ${clock(Date.parse(run.started_at))}: the call request failed or is uncertain; it may not have rung.`);
    report.recent_calls.push(row);
  }
  if (paused) report.exceptions.unshift('Master pause is ON: no scheduled, snooze or repeat call will ring until Noah resumes calling.');
  if (!connected) report.exceptions.unshift('Calling is not connected: no call can ring.');
  return { report, text: reportText(report, now) };
}

export function reportText(r, now) {
  const L = [];
  const when = iso => iso ? clock(Date.parse(iso)) : '?';
  L.push(`CallMe status report ${r.report_id}`, `Generated ${clock(now)} (${r.generated_at}). Read-only snapshot; not an instruction.`, '');
  L.push(`Calling: ${!r.calling.calling_connected ? 'NOT CONNECTED' : r.calling.master_pause ? 'PAUSED' : 'on'} · quiet hours ${r.calling.quiet_hours.start}-${r.calling.quiet_hours.end}`, '');
  L.push(`Exceptions (${r.exceptions.length}):`); if (!r.exceptions.length) L.push('- none'); r.exceptions.forEach(e => L.push('- ' + e)); L.push('');
  L.push(`Waiting for Noah's decision (${r.pending_drafts.length}):`); if (!r.pending_drafts.length) L.push('- none');
  for (const d of r.pending_drafts) {
    L.push(`- Draft ${d.draft_id} "${d.title}" from ${d.sent_by}, submitted ${when(d.submitted_at)}, expires in ${d.hours_until_expiry} h`);
    for (const c of d.commands) L.push(`    ${c.action} ${c.reminder_id}${c.new_reminder_id ? ' -> ' + c.new_reminder_id : ''}${c.call_at ? ' at ' + when(c.call_at) : ''}${c.label ? ' "' + c.label + '"' : ''}${c.target ? ` (target now ${c.target.status}, rev ${c.target.current_revision})` : ''}`);
  }
  L.push('');
  const live = r.schedules.filter(s => ['armed', 'paused', 'saved_calling_not_connected'].includes(s.state));
  const other = r.schedules.filter(s => !live.includes(s));
  L.push(`Will ring (${live.length}):`); if (!live.length) L.push('- none');
  for (const s of live) L.push(`- ${s.call_at ? when(s.call_at) : s.recurring.local_time + ' ' + s.recurring.days.join(',')} "${s.label}" ${s.reminder_id || s.schedule_id} rev ${s.schedule_revision} [${s.state}]${s.lineage.replaces ? ' (replaces ' + s.lineage.replaces + ')' : ''}${s.policy.snooze_minutes ? ' · snooze ' + s.policy.snooze_minutes + ' min' : ''}${s.policy.if_unacknowledged !== 'none' ? ' · ' + s.policy.if_unacknowledged : ''}`);
  L.push('', `Queued snooze/repeat calls (${r.queued_follow_ups.length}):`); if (!r.queued_follow_ups.length) L.push('- none');
  for (const f of r.queued_follow_ups) L.push(`- ${when(f.due_at)} ${f.kind} "${f.label}" ${f.reminder_id || ''}`);
  L.push('', `Calls in the last ${r.history_hours} hours (${r.recent_calls.length}):`); if (!r.recent_calls.length) L.push('- none');
  for (const c of r.recent_calls) L.push(`- ${when(c.dispatched_at)} "${c.label}" [${c.type}]: ${c.derived.summary}${c.app_action ? '; app: ' + c.app_action : ''}${c.next_call ? '; next call ' + when(c.next_call.at) + ' (' + c.next_call.status + ')' : ''}`);
  L.push('', `Off, finished, replaced or cancelled (${other.length}):`); if (!other.length) L.push('- none');
  for (const s of other) L.push(`- "${s.label}" ${s.reminder_id || s.schedule_id} [${s.state}${s.lineage.replaced_by ? ' by ' + s.lineage.replaced_by : ''}]${s.call_at ? ' ' + when(s.call_at) : ''}`);
  L.push('', 'Dispatched does not mean answered; answered does not mean the task was done. Full data in the attached JSON.');
  return L.join('\n');
}
