-- Snooze, unanswered-call retry, and the plan inbox. Apply once to production:
--   npx wrangler d1 execute callme-alarms --remote --file=migrations/0001_snooze_retry_plans.sql
-- Existing schedules get snooze and retry turned off, so they behave exactly as before.
ALTER TABLE schedules ADD COLUMN snooze_minutes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE schedules ADD COLUMN max_snoozes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE schedules ADD COLUMN retry_minutes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE schedules ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE schedules ADD COLUMN source TEXT NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN snoozes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN retries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN decided INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS followups (
 id TEXT PRIMARY KEY, parent_key TEXT NOT NULL UNIQUE, schedule_id TEXT NOT NULL,
 kind TEXT NOT NULL, due_at TEXT NOT NULL, snoozes INTEGER NOT NULL, retries INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS due_followups ON followups(status,due_at);
CREATE TABLE IF NOT EXISTS plans (
 id TEXT PRIMARY KEY, received_at TEXT NOT NULL, title TEXT NOT NULL, note TEXT NOT NULL,
 calls TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', decided_at TEXT, result TEXT
);
CREATE INDEX IF NOT EXISTS plan_status ON plans(status,received_at);
