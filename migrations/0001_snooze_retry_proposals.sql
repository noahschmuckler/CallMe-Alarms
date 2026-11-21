-- Snooze, repeat calls, quiet hours, and the proposal inbox. Apply once to production:
--   npx wrangler d1 execute callme-alarms --remote --file=migrations/0001_snooze_retry_proposals.sql
-- Existing schedules keep their current behaviour: no snooze, no repeat calls.
ALTER TABLE schedules ADD COLUMN snooze_minutes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE schedules ADD COLUMN max_snoozes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE schedules ADD COLUMN retry_minutes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE schedules ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE schedules ADD COLUMN until_ack INTEGER NOT NULL DEFAULT 0;
ALTER TABLE schedules ADD COLUMN late_ok INTEGER NOT NULL DEFAULT 0;
ALTER TABLE schedules ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE schedules ADD COLUMN reminder_id TEXT;
ALTER TABLE schedules ADD COLUMN source TEXT NOT NULL DEFAULT '';
-- Schedules Noah already created inside quiet hours (10:30 PM - 5 AM) stay allowed.
UPDATE schedules SET late_ok=1 WHERE at>='22:30' OR at<'05:00';
ALTER TABLE runs ADD COLUMN snoozes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN retries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN decided INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN chain_started TEXT;
ALTER TABLE runs ADD COLUMN halt INTEGER NOT NULL DEFAULT 0;
-- Old runs are history only; never start follow-ups for them.
UPDATE runs SET decided=1;
CREATE TABLE IF NOT EXISTS followups (
 id TEXT PRIMARY KEY, parent_key TEXT NOT NULL UNIQUE, schedule_id TEXT NOT NULL,
 kind TEXT NOT NULL, due_at TEXT NOT NULL, snoozes INTEGER NOT NULL, retries INTEGER NOT NULL,
 chain_started TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS due_followups ON followups(status,due_at);
-- Proposal intake. A draft is one submission waiting for owner review; commands are
-- deduplicated by command_id; reminders are approved occurrences (reminder_id -> schedule).
CREATE TABLE IF NOT EXISTS drafts (
 id TEXT PRIMARY KEY, received_at TEXT NOT NULL, via TEXT NOT NULL, title TEXT NOT NULL, note TEXT NOT NULL,
 commands TEXT NOT NULL, hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', decided_at TEXT, result TEXT
);
CREATE INDEX IF NOT EXISTS draft_status ON drafts(status,received_at);
CREATE TABLE IF NOT EXISTS commands (
 command_id TEXT PRIMARY KEY, hash TEXT NOT NULL, content_hash TEXT, action TEXT NOT NULL,
 reminder_id TEXT NOT NULL, draft_id TEXT NOT NULL, received_at TEXT NOT NULL, state TEXT NOT NULL,
 detail TEXT, decided_at TEXT, schedule_revision INTEGER
);
CREATE INDEX IF NOT EXISTS command_reminder ON commands(reminder_id,state);
CREATE INDEX IF NOT EXISTS command_received ON commands(received_at);
CREATE TABLE IF NOT EXISTS reminders (
 reminder_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, schedule_id TEXT NOT NULL, command_id TEXT NOT NULL,
 call_at TEXT NOT NULL, planned_text_at TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL
);
-- One row per finished call: what was pressed and what the app did next.
CREATE TABLE IF NOT EXISTS events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, schedule_id TEXT NOT NULL, reminder_id TEXT,
 fire_key TEXT NOT NULL, call_id TEXT, kind TEXT NOT NULL, call_status TEXT, digits TEXT, outcome TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS event_reminder ON events(reminder_id);
