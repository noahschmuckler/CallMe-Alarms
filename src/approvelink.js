// One-tap approval links for drafts (Pushover alerts).
//
//  POST /inbox/approval-link  {draft_id}   Bearer APPROVE_LINK_KEY (Noah's helper script only)
//      Runs sanity checks. Pass: returns a one-time signed link that expires with the draft.
//      Fail: returns the reasons and no link.
//  GET  /approve/<token>   Shows the draft and an Approve button. Never approves.
//  POST /approve/<token>   Approves through decideDraft(), the same function as the Approve button in
//                          the owner app. The link is claimed atomically first, so it works once.
//
// Tokens: "<link id>.<HMAC-SHA256(APPROVE_SIGNING_KEY, id|draft_id|expires)>". Only the link id is
// stored; the signature is checked in constant time before any database lookup.
import { TZ, MAX_SNOOZES, localParts, iso, inQuietHours } from './policy.js';
import { LIMITS, decideDraft } from './intake.js';

const MIN_LEAD_MS = 2 * 60000;          // a call must still be at least 2 minutes away
const CLASH_MS = 15 * 60000;            // flag calls this close to another armed or proposed call
const ODD_START = '22:00', ODD_END = '06:00';

const enc = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}
async function sameText(a, b) {   // constant-time compare of two strings
  const [x, y] = await Promise.all([a, b].map(s => crypto.subtle.digest('SHA-256', enc.encode(String(s)))));
  const u = new Uint8Array(x), v = new Uint8Array(y); let d = 0; for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i]; return d === 0;
}
const when = ms => new Date(ms).toLocaleString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function policyText(p) {
  const out = [`message plays ${p.repeats}x`];
  out.push(p.snooze_minutes ? `press 2 snoozes ${p.snooze_minutes} min (${p.max_snoozes}x)` : 'no snooze');
  if (p.if_unacknowledged === 'keep_calling') out.push(`keeps calling every ${p.retry_every_minutes} min until 1 is pressed (stops after 2 h)`);
  else if (p.if_unacknowledged === 'retry') out.push(`calls again every ${p.retry_every_minutes} min, up to ${p.max_retries}x`);
  else out.push('no repeat calls');
  if (p.allow_quiet_hours) out.push('ALLOWED IN QUIET HOURS');
  return out.join(' · ');
}

// Sanity checks before an alert. problems block the link; flags are shown but do not block.
export async function checkDraft(env, d, now) {
  const problems = [], flags = [], lines = [];
  const expires = Date.parse(d.received_at) + LIMITS.draftDays * 86400000;
  if (d.status !== 'pending') problems.push(`Draft is ${d.status}, not waiting for approval.`);
  if (expires <= now) problems.push('Draft has expired.');
  const commands = JSON.parse(d.commands);
  const armed = (await env.DB.prepare("SELECT s.label,s.at,s.once_date,s.reminder_id FROM schedules s WHERE s.enabled=1 AND s.days='once'").all()).results
    .map(s => ({ label: s.label, raw: s, ms: NaN }));
  // Resolve each armed one-time schedule to an instant (New York local time).
  for (const a of armed) {
    const guess = Date.parse(`${a.raw.once_date}T${a.raw.at}:00Z`);
    a.ms = [4, 5, 3, 6].map(h => guess + h * 3600000).find(ms => { const l = localParts(ms); return l.date === a.raw.once_date && l.at === a.raw.at; }) ?? guess;
  }
  const proposed = [];
  for (const c of commands) {
    if (c.action === 'cancel') {
      const t = await env.DB.prepare('SELECT r.status,s.revision FROM reminders r LEFT JOIN schedules s ON s.id=r.schedule_id WHERE r.reminder_id=?').bind(c.reminder_id).first();
      lines.push(`CANCEL ${c.reminder_id}`);
      if (!t || t.status !== 'active') problems.push(`Cancel target ${c.reminder_id} is ${t ? t.status : 'unknown'}.`);
      else if (t.revision !== c.expected_revision) problems.push(`Cancel target ${c.reminder_id} is at revision ${t.revision}, not ${c.expected_revision}.`);
      continue;
    }
    const ms = Date.parse(c.call_at), p = c.policy || {};
    lines.push(`${c.action === 'replace' ? 'CHANGE ' + c.reminder_id + ' to: ' : ''}${when(ms)} "${c.label}" (${policyText(p)})`);
    if (!(ms > now + MIN_LEAD_MS)) problems.push(`"${c.label}" call time ${when(ms)} is not in the future.`);
    if (!(p.repeats >= 1 && p.repeats <= 5)) problems.push(`"${c.label}": message repeats ${p.repeats} outside 1-5.`);
    if (p.snooze_minutes < 0 || p.snooze_minutes > 60 || (p.max_snoozes || 0) > MAX_SNOOZES) problems.push(`"${c.label}": snooze ${p.snooze_minutes} min x${p.max_snoozes} is over the limit (60 min, ${MAX_SNOOZES}x).`);
    if (p.if_unacknowledged === 'retry' && !(p.max_retries >= 1 && p.max_retries <= 5)) problems.push(`"${c.label}": ${p.max_retries} repeat calls is outside 1-5.`);
    if (p.if_unacknowledged !== 'none' && !(p.retry_every_minutes >= 2 && p.retry_every_minutes <= 30)) problems.push(`"${c.label}": repeat interval ${p.retry_every_minutes} min is outside 2-30.`);
    if (c.action === 'replace') {
      const t = await env.DB.prepare('SELECT r.status,s.revision FROM reminders r LEFT JOIN schedules s ON s.id=r.schedule_id WHERE r.reminder_id=?').bind(c.reminder_id).first();
      if (!t || t.status !== 'active') problems.push(`Change target ${c.reminder_id} is ${t ? t.status : 'unknown'}.`);
      else if (t.revision !== c.expected_revision) problems.push(`Change target ${c.reminder_id} is at revision ${t.revision}, not ${c.expected_revision}.`);
    }
    const at = localParts(ms).at;
    if (inQuietHours(at)) flags.push(`"${c.label}" rings in quiet hours (${when(ms)}).`);
    else if (at >= ODD_START || at < ODD_END) flags.push(`"${c.label}" rings at an unusual hour (${when(ms)}).`);
    for (const a of armed) if (Math.abs(a.ms - ms) <= CLASH_MS && a.raw.reminder_id !== c.reminder_id)
      flags.push(`"${c.label}" (${when(ms)}) is within 15 minutes of armed call "${a.label}" (${when(a.ms)}).`);
    for (const o of proposed) if (Math.abs(o.ms - ms) <= CLASH_MS) flags.push(`"${c.label}" and "${o.label}" in this draft are within 15 minutes of each other.`);
    proposed.push({ ms, label: c.label });
  }
  return { ok: !problems.length, problems, flags, lines, expires };
}

export async function mintLink(req, env, origin, now = Date.now()) {
  let body; try { body = await req.json(); } catch { return { status: 400, body: { error: 'invalid_request' } }; }
  const d = await env.DB.prepare('SELECT * FROM drafts WHERE id=?').bind(String(body.draft_id || '')).first();
  if (!d) return { status: 404, body: { ok: false, problems: ['No such draft.'] } };
  const check = await checkDraft(env, d, now);
  const base = { draft_id: d.id, title: d.title, lines: check.lines, flags: check.flags, expires_at: iso(check.expires) };
  if (!check.ok) return { status: 200, body: { ok: false, problems: check.problems, ...base } };
  const id = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const token = id + '.' + await hmac(env.APPROVE_SIGNING_KEY, `${id}|${d.id}|${check.expires}`);
  await env.DB.batch([
    env.DB.prepare("UPDATE approval_links SET revoked=1 WHERE draft_id=? AND used_at IS NULL").bind(d.id),   // one live link per draft
    env.DB.prepare('INSERT INTO approval_links(id,draft_id,draft_hash,expires_at,created_at,revoked) VALUES(?,?,?,?,?,0)').bind(id, d.id, d.hash, iso(check.expires), iso(now)),
  ]);
  return { status: 200, body: { ok: true, url: `${origin}/approve/${token}`, ...base } };
}

async function linkFor(env, token, now) {
  const m = /^([A-Za-z0-9_-]{20,40})\.([A-Za-z0-9_-]{40,50})$/.exec(token || '');
  if (!m || !env.APPROVE_SIGNING_KEY) return { error: 'This approval link is not valid.' };
  const row = await env.DB.prepare('SELECT * FROM approval_links WHERE id=?').bind(m[1]).first();
  if (!row) return { error: 'This approval link is not valid.' };
  const good = await sameText(m[2], await hmac(env.APPROVE_SIGNING_KEY, `${row.id}|${row.draft_id}|${Date.parse(row.expires_at)}`));
  if (!good) return { error: 'This approval link is not valid.' };
  if (row.used_at) return { error: 'This approval link was already used.' + (row.result ? ' ' + row.result : ''), row };
  if (row.revoked) return { error: 'This approval link was replaced by a newer one.', row };
  if (Date.parse(row.expires_at) <= now) return { error: 'This approval link has expired, along with its draft.', row };
  const d = await env.DB.prepare('SELECT * FROM drafts WHERE id=?').bind(row.draft_id).first();
  if (!d || d.status !== 'pending') return { error: `This draft was already ${d ? d.status : 'removed'}${d?.result ? ': ' + d.result : ''}.`, row };
  if (d.hash !== row.draft_hash) return { error: 'This draft changed after the link was made. Review it in CallMe.', row };
  return { row, d };
}

const PAGE_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" };
const page = (title, inner, status = 200) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>body{font:16px system-ui;background:#f5f5ef;color:#23302c;margin:0;padding:18px}main{max-width:520px;margin:auto;background:#fff;border:1px solid #dfe4da;border-radius:16px;padding:22px}h1{font-size:21px;margin:0 0 6px}li{margin:10px 0;line-height:1.45}.muted{color:#65746c;font-size:13px}.flag{background:#fff3d8;border:1px solid #e7d4a8;border-radius:10px;padding:10px 12px;font-size:14px;margin:12px 0}.quote{border-left:2px solid #d9e5d9;padding-left:10px;color:#53635a;font-size:14px}button{width:100%;margin-top:18px;padding:15px;border:0;border-radius:10px;background:#245e4b;color:#fff;font:inherit;font-weight:600;font-size:17px}a{color:#245e4b}</style></head><body><main>${inner}</main></body></html>`, { status, headers: PAGE_HEADERS });

export async function approvePage(req, env, url, now = Date.now()) {
  const token = decodeURIComponent(url.pathname.slice('/approve/'.length));
  const found = await linkFor(env, token, now);
  if (found.error) return page('CallMe', `<h1>Nothing to approve</h1><p>${esc(found.error)}</p><p><a href="/">Open CallMe</a></p>`, 410);
  const { row, d } = found;
  if (req.method === 'POST') {
    if (req.headers.get('Origin') !== url.origin) return page('CallMe', '<h1>Not approved</h1><p>Use the Approve button on the approval page.</p>', 403);
    // Claim the link first: a second tap, a retry or a second tab gets "already used", never a second approval.
    const claim = await env.DB.prepare('UPDATE approval_links SET used_at=? WHERE id=? AND used_at IS NULL AND revoked=0 AND expires_at>?').bind(iso(now), row.id, iso(now)).run();
    if (!claim.meta.changes) return page('CallMe', '<h1>Already used</h1><p>This approval link was already used.</p><p><a href="/">Open CallMe</a></p>', 409);
    const r = await decideDraft(env, d.id, row.draft_hash, true, now);   // same path as the app's Approve button
    const result = r.ok ? r.result : r.error;
    await env.DB.prepare('UPDATE approval_links SET result=? WHERE id=?').bind(String(result).slice(0, 500), row.id).run();
    return page('CallMe', r.ok ? `<h1>Approved</h1><p>${esc(d.title)}</p><p class="quote">${esc(result)}</p><p class="muted">Instinct gets the usual receipt. To change anything, use CallMe.</p><p><a href="/">Open CallMe</a></p>`
      : `<h1>Not approved</h1><p>${esc(result)}</p><p><a href="/">Open CallMe</a></p>`, r.ok ? 200 : 409);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return page('CallMe', '<h1>Not allowed</h1>', 405);
  const check = await checkDraft(env, d, now);
  const cmds = JSON.parse(d.commands).map(c => c.action === 'cancel' ? `<li><b>Cancel</b> reminder ${esc(c.reminder_id)}</li>`
    : `<li><b>${c.action === 'replace' ? 'Change ' + esc(c.reminder_id) + ' to ' : ''}${esc(when(Date.parse(c.call_at)))}</b>: ${esc(c.label)}<div class="quote">“${esc(c.message)}”</div><div class="muted">${esc(policyText(c.policy || {}))}</div></li>`).join('');
  const flags = check.flags.map(f => `<div class="flag">${esc(f)}</div>`).join('');
  const blocked = check.ok ? '' : `<div class="flag"><b>Cannot approve:</b> ${esc(check.problems.join(' '))}</div>`;
  return page('Approve: ' + d.title, `<h1>${esc(d.title)}</h1><p class="muted">From ${d.via === 'paste' ? 'you (pasted)' : 'Instinct'} · draft ${esc(d.id)} · link expires ${esc(when(Date.parse(row.expires_at)))}</p>${d.note ? `<p>${esc(d.note)}</p>` : ''}<ol>${cmds}</ol>${flags}${blocked}${check.ok ? `<form method="post"><button>Approve</button></form><p class="muted">Approves exactly what is shown, once. Opening this page does not approve anything.</p>` : ''}<p class="muted"><a href="/">Review in CallMe instead</a></p>`);
}
