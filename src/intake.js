// Proposal intake (command format v1, see docs/PROPOSAL_FORMAT.md).
// Intake only ever stages inert drafts. Only the owner's approval in the app,
// bound to the exact draft content, creates or cancels a schedule.
import { TZ, MAX_SNOOZES, localParts, iso, inQuietHours, KEEP_CALLING_CAP_MINUTES } from './policy.js';

export const LIMITS = { bodyBytes: 65536, commandsPerSubmission: 30, pendingDrafts: 10, commandsPerHour: 120, draftDays: 7 };
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const TIME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):00(?:\.0+)?([+-]\d{2}:\d{2})$/;
const CREATE_KEYS = ['version','action','command_id','reminder_id','label','planned_text_at','call_at','timezone','message','policy'];
const CANCEL_KEYS = ['version','action','command_id','reminder_id','expected_revision'];
const REPLACE_KEYS = [...CREATE_KEYS, 'expected_revision', 'new_reminder_id'];
const POLICY_KEYS = ['repeats','snooze_minutes','max_snoozes','if_unacknowledged','retry_every_minutes','max_retries','allow_quiet_hours'];
const ENVELOPE_KEYS = ['version','title','note','commands'];

export class IntakeError extends Error {
  constructor(status, error, problems) { super(error); this.status = status; this.error = error; this.problems = problems; }
}

async function sha256(text) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))).map(b => b.toString(16).padStart(2, '0')).join('');
}
// Stable JSON (sorted keys) so the same content always hashes the same.
export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

// Parses an RFC 3339 time with a numeric offset and checks it is a real, unambiguous
// minute in America/New_York with that offset.
export function parseInstant(text, field) {
  const m = typeof text === 'string' && TIME_RE.exec(text);
  if (!m) throw Error(`"${field}" must look like 2026-12-07T05:45:00-05:00 (seconds 00, numeric UTC offset)`);
  const ms = Date.parse(text);
  if (isNaN(ms)) throw Error(`"${field}" is not a real date and time`);
  const local = localParts(ms);
  if (local.date !== m[1] || local.at !== m[2])
    throw Error(`"${field}" ${m[2]} ${m[3]} is not a valid ${TZ} time on ${m[1]} (wrong UTC offset, or a time skipped by daylight saving)`);
  if (localParts(ms - 3600000).at === local.at || localParts(ms + 3600000).at === local.at)
    throw Error(`"${field}" falls in the repeated hour when daylight saving ends; choose another time`);
  return { ms, date: m[1], at: m[2], offset: m[3] };
}

function unknownKeys(obj, allowed, where) {
  const extra = Object.keys(obj).filter(k => !allowed.includes(k));
  if (extra.length) throw Error(`${where} has fields this version does not accept: ${extra.join(', ')}`);
}
function intIn(v, lo, hi, name) {
  if (!Number.isInteger(v) || v < lo || v > hi) throw Error(`"${name}" must be a whole number from ${lo} to ${hi}`);
  return v;
}

export function normalizePolicy(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw Error('"policy" is required (use {} for one call with no snooze or retry)');
  unknownKeys(p, POLICY_KEYS, 'policy');
  const out = { repeats: p.repeats === undefined ? 1 : intIn(p.repeats, 1, 5, 'policy.repeats') };
  out.snooze_minutes = p.snooze_minutes === undefined ? 0 : intIn(p.snooze_minutes, 0, 60, 'policy.snooze_minutes');
  out.max_snoozes = out.snooze_minutes ? (p.max_snoozes === undefined ? 1 : intIn(p.max_snoozes, 1, MAX_SNOOZES, 'policy.max_snoozes')) : 0;
  if (!out.snooze_minutes && p.max_snoozes) throw Error('"policy.max_snoozes" needs "snooze_minutes"');
  const mode = p.if_unacknowledged === undefined ? 'none' : p.if_unacknowledged;
  if (!['none', 'retry', 'keep_calling'].includes(mode)) throw Error('"policy.if_unacknowledged" must be "none", "retry" or "keep_calling"');
  out.if_unacknowledged = mode;
  if (mode === 'none') {
    if (p.retry_every_minutes !== undefined || p.max_retries !== undefined) throw Error('retry fields need "if_unacknowledged" "retry" or "keep_calling"');
    out.retry_every_minutes = 0; out.max_retries = 0;
  } else {
    out.retry_every_minutes = intIn(p.retry_every_minutes, 2, 30, 'policy.retry_every_minutes');
    if (mode === 'retry') out.max_retries = intIn(p.max_retries, 1, 5, 'policy.max_retries');
    else { if (p.max_retries !== undefined) throw Error('"keep_calling" has no "max_retries" (it stops when you press 1, at quiet hours, or after ' + KEEP_CALLING_CAP_MINUTES + ' minutes)'); out.max_retries = 0; }
  }
  if (p.allow_quiet_hours !== undefined && typeof p.allow_quiet_hours !== 'boolean') throw Error('"policy.allow_quiet_hours" must be true or false');
  out.allow_quiet_hours = p.allow_quiet_hours === true;
  return out;
}

function normalizeCommand(c, now) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw Error('must be an object');
  if (c.version !== 1) throw Error('"version" must be 1');
  if (typeof c.command_id !== 'string' || !ID_RE.test(c.command_id)) throw Error('"command_id" must be 1-100 letters, digits, or . _ : -');
  if (typeof c.reminder_id !== 'string' || !ID_RE.test(c.reminder_id)) throw Error('"reminder_id" must be 1-100 letters, digits, or . _ : -');
  if (c.action === 'cancel') {
    unknownKeys(c, CANCEL_KEYS, 'cancel command');
    return { action: 'cancel', command_id: c.command_id, reminder_id: c.reminder_id, expected_revision: intIn(c.expected_revision, 1, 1e6, 'expected_revision') };
  }
  if (c.action !== 'create' && c.action !== 'replace') throw Error('"action" must be "create", "cancel" or "replace"');
  const replacing = c.action === 'replace';
  unknownKeys(c, replacing ? REPLACE_KEYS : CREATE_KEYS, c.action + ' command');
  let expected_revision, new_reminder_id;
  if (replacing) {
    expected_revision = intIn(c.expected_revision, 1, 1e6, 'expected_revision');
    if (typeof c.new_reminder_id !== 'string' || !ID_RE.test(c.new_reminder_id)) throw Error('"new_reminder_id" must be 1-100 letters, digits, or . _ : -');
    if (c.new_reminder_id === c.reminder_id) throw Error('"new_reminder_id" must differ from "reminder_id" (the reminder being replaced)');
    new_reminder_id = c.new_reminder_id;
  }
  if (c.timezone !== TZ) throw Error(`"timezone" must be "${TZ}"`);
  if (typeof c.label !== 'string' || !c.label.trim() || c.label.length > 80) throw Error('"label" must be 1-80 characters');
  if (typeof c.message !== 'string' || !c.message.trim() || c.message.length > 700) throw Error('"message" must be 1-700 characters (the keypad menu is added after it)');
  const call = parseInstant(c.call_at, 'call_at');
  if (call.ms <= now + 2 * 60000) throw Error('"call_at" must be at least 2 minutes in the future');
  let planned = null;
  if (c.planned_text_at !== undefined && c.planned_text_at !== null) {
    planned = parseInstant(c.planned_text_at, 'planned_text_at');
    if (planned.ms > call.ms) throw Error('"planned_text_at" must not be after "call_at"');
  }
  const policy = normalizePolicy(c.policy);
  if (!policy.allow_quiet_hours && inQuietHours(call.at))
    throw Error(`"call_at" ${call.at} is in quiet hours (after 10:30 PM or before 5:00 AM); set "policy.allow_quiet_hours": true only if Noah agreed to it`);
  const out = {
    action: c.action, command_id: c.command_id, reminder_id: c.reminder_id, label: c.label.trim(), message: c.message.trim(),
    call_at: c.call_at, planned_text_at: planned ? c.planned_text_at : null, timezone: TZ, policy,
    local: { date: call.date, at: call.at, offset: call.offset },
  };
  if (replacing) { out.expected_revision = expected_revision; out.new_reminder_id = new_reminder_id; }
  return out;
}

// The reminder's content (everything except which command delivered it).
const reminderContent = c => canonical({ label: c.label, message: c.message, call_at: c.call_at, planned_text_at: c.planned_text_at, policy: c.policy });

export function parseSubmission(text, now) {
  let raw = String(text).trim();
  if (!raw.startsWith('{')) { const a = raw.indexOf('{'), b = raw.lastIndexOf('}'); if (a < 0 || b < a) throw new IntakeError(400, 'invalid_proposal', ['No JSON proposal found.']); raw = raw.slice(a, b + 1); }
  let body;
  try { body = JSON.parse(raw); } catch { throw new IntakeError(400, 'invalid_proposal', ['The proposal is not valid JSON.']); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new IntakeError(400, 'invalid_proposal', ['The proposal must be a JSON object.']);
  const problems = [];
  let title = '', note = '', list;
  if (Array.isArray(body.commands)) {
    try { unknownKeys(body, ENVELOPE_KEYS, 'envelope'); } catch (e) { problems.push(e.message + '.'); }
    if (body.version !== 1) problems.push('envelope "version" must be 1.');
    if (body.title !== undefined && (typeof body.title !== 'string' || body.title.length > 100)) problems.push('"title" must be text up to 100 characters.');
    if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 1000)) problems.push('"note" must be text up to 1000 characters.');
    title = typeof body.title === 'string' ? body.title.trim() : ''; note = typeof body.note === 'string' ? body.note.trim() : '';
    list = body.commands;
    if (!list.length || list.length > LIMITS.commandsPerSubmission) problems.push(`"commands" must hold 1 to ${LIMITS.commandsPerSubmission} commands.`);
  } else list = [body];
  const commands = [], seenC = new Set(), seenR = new Set();
  list.slice(0, LIMITS.commandsPerSubmission).forEach((c, i) => {
    const where = list.length > 1 || body.commands ? `commands[${i}]` : 'command';
    try {
      const n = normalizeCommand(c, now);
      if (seenC.has(n.command_id)) throw Error(`repeats command_id "${n.command_id}"`);
      for (const r of [n.reminder_id, n.new_reminder_id].filter(Boolean)) {
        if (seenR.has(r)) throw Error(`repeats reminder_id "${r}" in the same proposal`);
        seenR.add(r);
      }
      seenC.add(n.command_id); commands.push(n);
    } catch (e) { problems.push(`${where}: ${String(e.message).replace(/\.$/, '')}.`); }
  });
  if (problems.length) throw new IntakeError(400, 'invalid_proposal', problems);
  if (!title) title = commands.length === 1
    ? (commands[0].action === 'cancel' ? 'Cancel ' + commands[0].reminder_id : commands[0].action === 'replace' ? 'Change: ' + commands[0].label : commands[0].label)
    : `${commands.length} proposed changes`;
  return { title, note, commands };
}

// Stages a submission as one inert draft. Returns {status, body}. Never creates schedules.
export async function submit(env, text, via, now = Date.now()) {
  if (String(text).length > LIMITS.bodyBytes) throw new IntakeError(413, 'too_large', [`Proposal too large (${LIMITS.bodyBytes / 1024} KB max).`]);
  const { title, note, commands } = parseSubmission(text, now);
  const receipts = [], fresh = [], conflicts = [];
  for (const c of commands) {
    c.hash = await sha256(canonical({ ...c, local: undefined }));
    if (c.action !== 'cancel') c.content_hash = await sha256(reminderContent(c));
    const prior = await env.DB.prepare('SELECT * FROM commands WHERE command_id=?').bind(c.command_id).first();
    if (prior) {
      if (prior.hash !== c.hash) conflicts.push(`command_id "${c.command_id}" was already used for different content. Use a new command_id.`);
      else receipts.push({ ...(await receipt(env, c.command_id)), duplicate: true });
      continue;
    }
    // The reminder this command would create: its own id for a create, new_reminder_id for a replace.
    const newId = c.action === 'create' ? c.reminder_id : c.action === 'replace' ? c.new_reminder_id : null;
    if (newId) {
      const rem = await env.DB.prepare('SELECT content_hash FROM reminders WHERE reminder_id=?').bind(newId).first();
      const staged = await env.DB.prepare("SELECT content_hash FROM commands WHERE state='draft_received' AND ((action='create' AND reminder_id=?) OR (action='replace' AND new_reminder_id=?))").bind(newId, newId).first();
      const other = rem || staged;
      if (other && other.content_hash !== c.content_hash) { conflicts.push(`reminder_id "${newId}" already exists with different content. Use a new reminder_id.`); continue; }
      if (other) { conflicts.push(`reminder_id "${newId}" was already proposed with this content under another command_id; check that command's receipt instead.`); continue; }
    }
    if (c.action !== 'create') {
      const verb = c.action === 'cancel' ? 'cancel' : 'replace';
      const rem = await env.DB.prepare('SELECT r.*, s.revision AS revision FROM reminders r LEFT JOIN schedules s ON s.id=r.schedule_id WHERE r.reminder_id=?').bind(c.reminder_id).first();
      if (!rem) { conflicts.push(`reminder_id "${c.reminder_id}" is not an approved reminder; nothing to ${verb}.`); continue; }
      if (c.action === 'replace' && rem.status !== 'active') { conflicts.push(`reminder_id "${c.reminder_id}" was already ${rem.status}${rem.replaced_by ? ' by ' + rem.replaced_by : ''}; nothing to replace.`); continue; }
      if (rem.revision !== null && rem.revision !== c.expected_revision) { conflicts.push(`reminder_id "${c.reminder_id}" is at revision ${rem.revision}, not ${c.expected_revision}. Check the current receipt; nothing was changed.`); continue; }
    }
    fresh.push(c);
  }
  if (conflicts.length) throw new IntakeError(409, 'conflict', conflicts);
  if (!fresh.length) return { status: 200, body: { ok: true, draft_id: null, receipts, note: 'Already received; nothing new was staged.' } };
  const pending = await env.DB.prepare("SELECT count(*) AS n FROM drafts WHERE status='pending'").first();
  if (pending.n >= LIMITS.pendingDrafts) throw new IntakeError(429, 'too_many_pending', [`${LIMITS.pendingDrafts} drafts are already waiting for Noah's review.`]);
  const recent = await env.DB.prepare('SELECT count(*) AS n FROM commands WHERE received_at>=?').bind(iso(now - 3600000)).first();
  if (recent.n + fresh.length > LIMITS.commandsPerHour) throw new IntakeError(429, 'rate_limited', [`More than ${LIMITS.commandsPerHour} commands in an hour.`]);
  const id = 'd_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const stored = JSON.stringify(fresh);
  const hash = await sha256(stored);
  const stmts = [env.DB.prepare('INSERT INTO drafts(id,received_at,via,title,note,commands,hash) VALUES(?,?,?,?,?,?,?)').bind(id, iso(now), via, title, note, stored, hash)];
  for (const c of fresh) stmts.push(env.DB.prepare("INSERT INTO commands(command_id,hash,content_hash,action,reminder_id,new_reminder_id,draft_id,received_at,state) VALUES(?,?,?,?,?,?,?,?,'draft_received')")
    .bind(c.command_id, c.hash, c.content_hash || null, c.action, c.reminder_id, c.new_reminder_id || null, id, iso(now)));
  await env.DB.batch(stmts);
  for (const c of fresh) receipts.push(await receipt(env, c.command_id));
  return { status: 202, body: { ok: true, draft_id: id, draft_revision: 1, receipts, note: 'Staged as a draft. Nothing is scheduled until Noah approves it in CallMe.' } };
}

// Approve or reject a whole draft. `hash` must match the content the owner reviewed.
export async function decideDraft(env, id, hash, approve, now = Date.now()) {
  const d = await env.DB.prepare('SELECT * FROM drafts WHERE id=?').bind(id).first();
  if (!d || d.status !== 'pending') return { error: 'This draft is no longer waiting for review. Reload to see its current state.' };
  if (d.hash !== hash) return { error: 'This draft changed since you opened it. Reload and review it again.' };
  if (Date.parse(d.received_at) < now - LIMITS.draftDays * 86400000) {
    await env.DB.batch([env.DB.prepare("UPDATE drafts SET status='expired',decided_at=? WHERE id=? AND status='pending'").bind(iso(now), id),
      env.DB.prepare("UPDATE commands SET state='expired',detail='Draft expired before review',decided_at=? WHERE draft_id=? AND state='draft_received'").bind(iso(now), id)]);
    return { error: 'This draft expired. Ask for a fresh proposal.' };
  }
  const commands = JSON.parse(d.commands);
  if (!approve) {
    await env.DB.batch([env.DB.prepare("UPDATE drafts SET status='rejected',decided_at=?,result='Rejected by Noah' WHERE id=? AND status='pending'").bind(iso(now), id),
      env.DB.prepare("UPDATE commands SET state='rejected',detail='Rejected by Noah',decided_at=? WHERE draft_id=? AND state='draft_received'").bind(iso(now), id)]);
    return { ok: true, result: 'Rejected. Nothing was scheduled or cancelled.' };
  }
  // Claim the draft first so a double click or a second tab cannot approve it twice.
  const claim = await env.DB.prepare("UPDATE drafts SET status='approving' WHERE id=? AND status='pending' AND hash=?").bind(id, hash).run();
  if (!claim.meta.changes) return { error: 'This draft is no longer waiting for review.' };
  const results = [];
  for (const c of commands) results.push(c.action === 'create' ? await approveCreate(env, d, c, now)
    : c.action === 'replace' ? await approveReplace(env, d, c, now) : await approveCancel(env, c, now));
  const summary = results.map(r => `${r.label}: ${r.text}`).join('; ');
  await env.DB.prepare("UPDATE drafts SET status='approved',decided_at=?,result=? WHERE id=?").bind(iso(now), summary.slice(0, 2000), id).run();
  return { ok: true, result: summary };
}

async function approveCreate(env, d, c, now) {
  const label = c.label;
  const setState = (state, detail, extra = []) => env.DB.batch([...extra,
    env.DB.prepare('UPDATE commands SET state=?,detail=?,decided_at=?,schedule_revision=? WHERE command_id=?').bind(state, detail, iso(now), state === 'approved' ? 1 : null, c.command_id)]);
  if (Date.parse(c.call_at) <= now + 60000) { await setState('expired', 'Call time passed before approval; not scheduled (no catch-up call).'); return { label, text: 'not scheduled, time already passed' }; }
  if (await env.DB.prepare('SELECT 1 FROM reminders WHERE reminder_id=?').bind(c.reminder_id).first()) { await setState('conflict', 'reminder_id already exists'); return { label, text: 'not scheduled, reminder already exists' }; }
  const count = await env.DB.prepare('SELECT count(*) AS n FROM schedules').first();
  if (count.n >= 100) { await setState('rejected', 'Schedule limit (100) reached'); return { label, text: 'not scheduled, schedule limit reached' }; }
  const sid = crypto.randomUUID(), p = c.policy;
  await setState('approved', 'Approved by Noah', [
    env.DB.prepare(`INSERT INTO schedules(id,label,at,days,once_date,message,repeats,enabled,created_at,snooze_minutes,max_snoozes,retry_minutes,max_retries,until_ack,late_ok,revision,reminder_id,source)
      VALUES(?,?,?,'once',?,?,?,1,?,?,?,?,?,?,?,1,?,?)`).bind(sid, label, c.local.at, c.local.date, c.message, p.repeats, iso(now), p.snooze_minutes, p.max_snoozes,
      p.retry_every_minutes, p.max_retries, p.if_unacknowledged === 'keep_calling' ? 1 : 0, p.allow_quiet_hours ? 1 : 0, c.reminder_id, 'proposal:' + d.id),
    env.DB.prepare("INSERT INTO reminders(reminder_id,content_hash,schedule_id,command_id,call_at,planned_text_at,status,created_at) VALUES(?,?,?,?,?,?,'active',?)")
      .bind(c.reminder_id, c.content_hash, sid, c.command_id, c.call_at, c.planned_text_at, iso(now)),
  ]);
  return { label, text: 'scheduled' };
}

async function approveCancel(env, c, now) {
  const label = 'Cancel ' + c.reminder_id;
  const done = async (state, detail) => { await env.DB.prepare('UPDATE commands SET state=?,detail=?,decided_at=? WHERE command_id=?').bind(state, detail, iso(now), c.command_id).run(); return { label, text: detail }; };
  const rem = await env.DB.prepare('SELECT * FROM reminders WHERE reminder_id=?').bind(c.reminder_id).first();
  if (!rem) return done('conflict', 'Unknown reminder; nothing changed.');
  if (rem.status === 'cancelled') return done('cancelled', 'Already cancelled.');
  if (rem.status === 'replaced') return done('nothing_pending', `Already replaced by ${rem.replaced_by}; cancel that reminder instead. Nothing changed.`);
  const s = await env.DB.prepare('SELECT * FROM schedules WHERE id=?').bind(rem.schedule_id).first();
  if (s && s.revision !== c.expected_revision) return done('conflict', `Reminder is at revision ${s.revision}, not ${c.expected_revision}; nothing changed.`);
  if (!s) return done('nothing_pending', 'The schedule was already deleted in CallMe. Nothing changed.');
  const count = async sql => (await env.DB.prepare(sql).bind(rem.schedule_id).first()).n;
  const pendingCalls = await count("SELECT count(*) AS n FROM followups WHERE schedule_id=? AND status='pending'");
  const before = await count('SELECT count(*) AS n FROM runs WHERE schedule_id=?');
  if (!s.enabled && !pendingCalls && !await count('SELECT count(*) AS n FROM runs WHERE schedule_id=? AND decided=0'))
    return done('nothing_pending', 'No pending call to cancel (it already finished or was turned off). Nothing changed.');
  // One atomic step: the dispatcher only claims enabled schedules and pending follow-ups.
  await env.DB.batch([
    env.DB.prepare('UPDATE schedules SET enabled=0 WHERE id=?').bind(rem.schedule_id),
    env.DB.prepare("UPDATE followups SET status='cancelled' WHERE schedule_id=? AND status='pending'").bind(rem.schedule_id),
    env.DB.prepare('UPDATE runs SET halt=1 WHERE schedule_id=? AND decided=0').bind(rem.schedule_id),
    env.DB.prepare("UPDATE reminders SET status='cancelled' WHERE reminder_id=?").bind(c.reminder_id),
  ]);
  if (await count('SELECT count(*) AS n FROM runs WHERE schedule_id=? AND decided=0'))
    return done('cancel_too_late', 'Too late to guarantee cancellation: a call was already sent or ringing. No further calls will be placed.');
  return done('cancelled', before.n ? 'Cancelled. Further snooze or repeat calls stopped.' : 'Cancelled before it called.');
}

// Replace = cancel the old reminder and create the new one in a single database transaction,
// and only if no call for the old reminder is in progress. Otherwise nothing changes.
async function approveReplace(env, d, c, now) {
  const label = 'Change ' + c.label;
  const done = async (state, detail) => { await env.DB.prepare('UPDATE commands SET state=?,detail=?,decided_at=? WHERE command_id=?').bind(state, detail, iso(now), c.command_id).run(); return { label, text: detail }; };
  if (Date.parse(c.call_at) <= now + 60000) return done('expired', 'New call time passed before approval; nothing changed.');
  const rem = await env.DB.prepare('SELECT * FROM reminders WHERE reminder_id=?').bind(c.reminder_id).first();
  if (!rem) return done('conflict', 'Unknown reminder; nothing changed.');
  if (rem.status !== 'active') return done('conflict', `Reminder was already ${rem.status}${rem.replaced_by ? ' by ' + rem.replaced_by : ''}; nothing changed.`);
  if (await env.DB.prepare('SELECT 1 FROM reminders WHERE reminder_id=?').bind(c.new_reminder_id).first()) return done('conflict', 'new_reminder_id already exists; nothing changed.');
  const s = await env.DB.prepare('SELECT * FROM schedules WHERE id=?').bind(rem.schedule_id).first();
  if (!s) return done('nothing_pending', 'The old schedule was deleted in CallMe. Nothing changed; send a create instead.');
  if (s.revision !== c.expected_revision) return done('conflict', `Reminder is at revision ${s.revision}, not ${c.expected_revision}; nothing changed.`);
  const inFlight = sql => env.DB.prepare(sql).bind(rem.schedule_id).first();
  const pending = (await inFlight("SELECT count(*) AS n FROM followups WHERE schedule_id=? AND status='pending'")).n;
  if (!s.enabled && !pending && !(await inFlight('SELECT count(*) AS n FROM runs WHERE schedule_id=? AND decided=0')).n)
    return done('nothing_pending', 'The old reminder already finished or was turned off. Nothing changed; send a create instead.');
  const count = await env.DB.prepare('SELECT count(*) AS n FROM schedules').first();
  if (count.n >= 100) return done('rejected', 'Schedule limit (100) reached; nothing changed.');
  // Every statement carries the same guard, so a call that starts in between makes the whole change a no-op.
  const idle = 'NOT EXISTS (SELECT 1 FROM runs WHERE schedule_id=? AND decided=0)';
  const sid = crypto.randomUUID(), p = c.policy, old = rem.schedule_id;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO schedules(id,label,at,days,once_date,message,repeats,enabled,created_at,snooze_minutes,max_snoozes,retry_minutes,max_retries,until_ack,late_ok,revision,reminder_id,source)
      SELECT ?,?,?,'once',?,?,?,1,?,?,?,?,?,?,?,1,?,? WHERE ${idle}`).bind(sid, c.label, c.local.at, c.local.date, c.message, p.repeats, iso(now), p.snooze_minutes, p.max_snoozes,
      p.retry_every_minutes, p.max_retries, p.if_unacknowledged === 'keep_calling' ? 1 : 0, p.allow_quiet_hours ? 1 : 0, c.new_reminder_id, 'proposal:' + d.id, old),
    env.DB.prepare(`INSERT INTO reminders(reminder_id,content_hash,schedule_id,command_id,call_at,planned_text_at,status,created_at) SELECT ?,?,?,?,?,?,'active',? WHERE ${idle}`)
      .bind(c.new_reminder_id, c.content_hash, sid, c.command_id, c.call_at, c.planned_text_at, iso(now), old),
    env.DB.prepare(`UPDATE schedules SET enabled=0 WHERE id=? AND ${idle}`).bind(old, old),
    env.DB.prepare(`UPDATE followups SET status='cancelled' WHERE schedule_id=? AND status='pending' AND ${idle}`).bind(old, old),
    env.DB.prepare(`UPDATE reminders SET status='replaced',replaced_by=? WHERE reminder_id=? AND ${idle}`).bind(c.new_reminder_id, c.reminder_id, old),
    env.DB.prepare(`UPDATE commands SET state='approved',detail=?,decided_at=?,schedule_revision=1 WHERE command_id=? AND ${idle}`)
      .bind(`Approved by Noah: replaced ${c.reminder_id}`, iso(now), c.command_id, old),
  ]);
  if (!await env.DB.prepare('SELECT 1 FROM reminders WHERE reminder_id=?').bind(c.new_reminder_id).first())
    return done('too_late', 'A call for the old reminder is in progress or just ended; nothing changed. Send the change again in a few minutes.');
  return { label, text: 'changed' };
}

// The current, authoritative state of one command, for the assistant and for the app.
export async function receipt(env, commandId) {
  const c = await env.DB.prepare('SELECT * FROM commands WHERE command_id=?').bind(commandId).first();
  if (!c) return null;
  const out = { command_id: c.command_id, reminder_id: c.reminder_id, action: c.action, draft_id: c.draft_id, draft_revision: 1,
    state: c.state, detail: c.detail || null, received_at: c.received_at, decided_at: c.decided_at || null, server_time: iso(Date.now()) };
  if (c.action === 'replace') { out.new_reminder_id = c.new_reminder_id; out.replaced_reminder_id = c.reminder_id; }
  if (c.action !== 'cancel' && c.state === 'approved') {
    const rid = c.action === 'replace' ? c.new_reminder_id : c.reminder_id;
    const r = await env.DB.prepare('SELECT * FROM reminders WHERE reminder_id=?').bind(rid).first();
    const s = r && await env.DB.prepare('SELECT * FROM schedules WHERE id=?').bind(r.schedule_id).first();
    const settings = await env.DB.prepare('SELECT paused FROM settings WHERE id=1').first();
    out.call_at = r?.call_at; out.timezone = TZ; out.schedule_revision = s?.revision ?? null;
    const runs = s ? (await env.DB.prepare('SELECT count(*) AS n FROM runs WHERE schedule_id=?').bind(s.id).first()).n : 0;
    if (r?.status === 'cancelled') out.state = 'cancelled';
    else if (r?.status === 'replaced') { out.state = 'replaced'; out.replaced_by = r.replaced_by; out.detail = 'Replaced by ' + r.replaced_by; }
    else if (!s) out.state = r && (await env.DB.prepare('SELECT 1 FROM events WHERE reminder_id=?').bind(rid).first()) ? 'called' : 'deleted_by_owner';
    else if (s.enabled) out.state = (!settings || settings.paused || !env.CALLME_SECRET) ? 'saved_inactive' : 'armed';
    else out.state = runs ? 'called' : 'turned_off_by_owner';
    if (out.state === 'saved_inactive') out.detail = !env.CALLME_SECRET ? 'Approved, but calling is not connected.' : 'Approved, but master pause is on; it will not ring until Noah resumes calling.';
    out.events = (await env.DB.prepare('SELECT at,kind,call_status,digits,outcome FROM events WHERE reminder_id=? ORDER BY id').bind(rid).all()).results;
  }
  return out;
}

export async function expireDrafts(env, now = Date.now()) {
  const cutoff = iso(now - LIMITS.draftDays * 86400000);
  await env.DB.batch([
    env.DB.prepare("UPDATE commands SET state='expired',detail='Draft expired before review',decided_at=? WHERE state='draft_received' AND draft_id IN (SELECT id FROM drafts WHERE status='pending' AND received_at<?)").bind(iso(now), cutoff),
    env.DB.prepare("UPDATE drafts SET status='expired',decided_at=? WHERE status='pending' AND received_at<?").bind(iso(now), cutoff),
  ]);
}
