# CallMe Alarms

Cloudflare Worker (`callme-alarms`) with a password-protected UI for scheduling wake-up phone calls.

## How it works
- A once-a-minute cron runs `tick()`, which finds enabled schedules due this minute (America/New_York),
  claims each one in the D1 `runs` table (so it fires once), and asks the existing **CallMe backend on Railway**
  to place the call (`POST /v1/call`). That backend holds the Twilio credentials and speaks the message.
- After a request, the cron polls `GET /v1/call/<id>` for up to 30 minutes and writes the outcome into the activity log.
- A "Test call now" button calls your phone immediately with a schedule's message, at most once per minute.

## Activation (owner only)
1. Copy `SHARED_SECRET` from the Railway CallMe service's variables.
2. Set it on this Worker as `CALLME_SECRET`: Cloudflare dashboard → Workers → callme-alarms →
   Settings → Variables and Secrets → Add → type *Secret*. Or run `npx wrangler secret put CALLME_SECRET`.
3. In the UI, press "Resume calling". The master pause is on until you do this.

## Files
- `src/worker.js`: the worker. `public/`: the UI. `schema.sql`: the D1 schema (already applied in production).
- Deploy: `npx wrangler login && npx wrangler deploy`.

## Known limits
No snooze, no retry when unanswered, no exactly-once guarantee. Runs more than 5 minutes late are skipped.
Best effort, so don't use it as your only time-critical alarm.
