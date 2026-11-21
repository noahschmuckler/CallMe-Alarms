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

export const UPDATE_PROMPT = ' Press 3 to leave a spoken update.';
const offersSnooze = (s, chain) => !!(s.snooze_minutes && chain.snoozes < s.max_snoozes);

// What the call says: the message, plus a keypad menu when the schedule has a follow-up
// policy. Every call offers press 3 (a recorded spoken update, transcribed after the call).
export function spoken(s, chain = { snoozes: 0 }) {
  const followups = s.snooze_minutes || s.until_ack || s.retry_minutes;
  if (!followups) return s.message + UPDATE_PROMPT;
  if (offersSnooze(s, chain))
    return s.message + ` Press 1 if you're up. Press 2 to snooze for ${s.snooze_minutes} minutes.` + UPDATE_PROMPT;
  if (s.until_ack)
    return s.message + ` Press 1 when you're getting out of bed. I'll keep calling until you do.` + UPDATE_PROMPT;
  return s.message + ` Press 1 to confirm.` + UPDATE_PROMPT;
}

// Keypad options the phone backend needs for this call: with snooze_minutes it says the
// call-back time after press 2; with spoken_update, press 3 records an update.
// Test calls never start a snooze, so they don't promise one.
export function callOptions(s, chain = { snoozes: 0 }, { test = false } = {}) {
  const o = { spoken_update: true };
  if (!test && offersSnooze(s, chain)) o.snooze_minutes = s.snooze_minutes;
  return o;
}

// The snooze call goes out at the time the call announced, when the backend reports one.
function snoozeDue(s, call, now) {
  const fallback = minuteFloor(now) + s.snooze_minutes * 60000;
  const promised = Date.parse(call.snooze_until || '');
  if (!Number.isFinite(promised)) return fallback;
  if (promised < now - 15 * 60000 || promised > now + (s.snooze_minutes + 15) * 60000) return fallback;
  return Math.max(promised, minuteFloor(now));
}

// Decide what happens after a call ends. Returns {kind, due, snoozes, retries} for one
// more call, {stop: reason} when a policy wanted another call but a limit prevents it,
// or null when nothing more is needed.
export function nextStep(s, run, call, now) {
  if (!s) return null;
  const digits = String(call.digits || '');
  if (call.acknowledged === true || digits === '1' || digits === '3') return null;
  let step = null;
  if (digits === '2' && s.snooze_minutes && run.snoozes < s.max_snoozes) {
    step = { kind: 'snooze', due: snoozeDue(s, call, now), snoozes: run.snoozes + 1, retries: 0 };
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
