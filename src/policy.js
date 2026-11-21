// Call policy: time helpers, quiet hours, what a call says, and what happens
// after a call ends. Pure functions, so they can be tested without a database.

export const TZ = 'America/New_York';
export const QUIET_START = '22:30';   // no calls from here...
export const QUIET_END = '05:00';     // ...until here, unless the schedule is explicitly allowed
export const MAX_SNOOZES = 1;         // owner-set limit
export const KEEP_CALLING_CAP_MINUTES = 120; // safety stop for "keep calling until I press 1"

export function localParts(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, at: `${p.hour}:${p.minute}`, day: String(['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].indexOf(p.weekday)) };
}
export const iso = ms => new Date(ms).toISOString();
export const minuteFloor = ms => Math.floor(ms / 60000) * 60000;
export const inQuietHours = at => at >= QUIET_START || at < QUIET_END;
export const clock = ms => new Date(ms).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });

// What the call says: the message, plus a keypad menu when the schedule has a follow-up policy.
export function spoken(s, chain = { snoozes: 0 }) {
  const followups = s.snooze_minutes || s.until_ack || s.retry_minutes;
  if (!followups) return s.message;
  if (s.snooze_minutes && chain.snoozes < s.max_snoozes)
    return s.message + ` Press 1 if you're up. Press 2 to snooze for ${s.snooze_minutes} minutes.`;
  if (s.until_ack)
    return s.message + ` Press 1 when you're getting out of bed. I'll keep calling until you do.`;
  return s.message + ` Press 1 to confirm.`;
}

// Decide what happens after a call ends. Returns {kind, due, snoozes, retries} for one
// more call, {stop: reason} when a policy wanted another call but a limit prevents it,
// or null when nothing more is needed.
export function nextStep(s, run, call, now) {
  if (!s) return null;
  const digits = String(call.digits || '');
  if (call.acknowledged === true || digits === '1') return null;
  let step = null;
  if (digits === '2' && s.snooze_minutes && run.snoozes < s.max_snoozes) {
    step = { kind: 'snooze', due: minuteFloor(now) + s.snooze_minutes * 60000, snoozes: run.snoozes + 1, retries: 0 };
  } else if (s.until_ack && s.retry_minutes) {
    step = { kind: 'retry', due: minuteFloor(now) + s.retry_minutes * 60000, snoozes: run.snoozes, retries: run.retries + 1 };
    const started = Date.parse(run.chain_started || run.started_at);
    if (step.due > started + KEEP_CALLING_CAP_MINUTES * 60000) return { stop: 'safety_stop' };
  } else if (s.retry_minutes && run.retries < s.max_retries) {
    step = { kind: 'retry', due: minuteFloor(now) + s.retry_minutes * 60000, snoozes: run.snoozes, retries: run.retries + 1 };
  }
  if (!step) return (s.snooze_minutes || s.retry_minutes) ? { stop: 'policy_done' } : null;
  if (!s.late_ok && inQuietHours(localParts(step.due).at)) return { stop: 'quiet_hours' };
  return step;
}
