# CallMe Alarms

Cloudflare Worker (`callme-alarms`) with a password-protected UI for scheduling wake-up phone calls.

## How it works
- A once-a-minute cron runs `tick()`, which finds enabled schedules due this minute (America/New_York),
  claims each one in the D1 `runs` table (so it fires once), and asks the existing **CallMe backend on Railway**
  to place the call (`POST /v1/call`). That backend holds the Twilio credentials and speaks the message.
- After a request, the cron polls `GET /v1/call/<id>` for up to 30 minutes and writes the outcome into the activity log.
- A "Test call now" button calls your phone immediately with a schedule's message, at most once per minute.

- **Snooze and repeat calls** (per schedule): with snooze on, the call ends with "Press 1 if you're up. Press 2 to snooze".
  One snooze. If 1 isn't pressed, the schedule can keep calling until it is, or call again a few times.
  Quiet hours (10:30 PM to 5:00 AM) block calls unless a schedule is explicitly allowed. Pending calls are
  listed in the app and can be cancelled; turning a schedule off stops them, even mid-call.
- **Proposals**: Instinct's reminder commands (format in `docs/PROPOSAL_FORMAT.md`) are staged as drafts,
  either pasted into the app or sent to `POST /inbox/proposal` with `Authorization: Bearer <PLAN_TOKEN>`.
  Nothing is scheduled or cancelled until the owner approves the draft in the app.
  `GET /inbox/receipt?command_id=…` returns the current state of a command.

## Activation (owner only)
1. Copy `SHARED_SECRET` from the Railway CallMe service's variables.
2. Set it on this Worker as `CALLME_SECRET`: Cloudflare dashboard → Workers → callme-alarms →
   Settings → Variables and Secrets → Add → type *Secret*. Or run `npx wrangler secret put CALLME_SECRET`.
3. In the UI, press "Resume calling". The master pause is on until you do this.
4. For the proposal inbox, set a long random `PLAN_TOKEN` secret (`npx wrangler secret put PLAN_TOKEN`) and give it to
   the assistant's transport. Without it the inbox refuses everything.

## Upgrading an existing database
`npx wrangler d1 execute callme-alarms --remote --file=migrations/0001_snooze_retry_proposals.sql` (once, before deploying).

## Files
- `src/worker.js`: the worker. `public/`: the UI. `schema.sql`: the full D1 schema for a fresh database.
- `migrations/`: changes to apply to the production database. `test/`: run with `npm test` (Node 22+).
- Deploy: `npx wrangler login && npx wrangler deploy`.

## Known limits
No exactly-once guarantee. Runs more than 5 minutes late are skipped. Snooze/retry calls more than 10 minutes
late are dropped. "Keep calling" stops after 2 hours. A call request that fails ambiguously is never retried.
Snooze by text message and press-3 spoken updates are not supported.
Best effort, so don't use it as your only time-critical alarm.
