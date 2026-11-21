# CallMe Alarms

Cloudflare Worker (`callme-alarms`) with a password-protected UI for scheduling wake-up phone calls.

- `src/worker.js` is the source recovered from the live deployment (via its source map).
- Still missing from the repo: `public/` (index.html, app.js, style.css) and the D1 schema/migrations.
- Not wired yet: no cron trigger, and no `CALLME_SECRET`, so no calls are placed.
