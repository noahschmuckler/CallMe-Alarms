-- Full schema for a fresh database. Production was created from the original
-- version of this file; bring it up to date with migrations/ instead.
CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), paused INTEGER NOT NULL DEFAULT 1);
INSERT OR IGNORE INTO settings(id, paused) VALUES(1, 1);
CREATE TABLE IF NOT EXISTS schedules (
 id TEXT PRIMARY KEY, label TEXT NOT NULL, at TEXT NOT NULL,
 days TEXT NOT NULL, once_date TEXT NOT NULL DEFAULT '',
 message TEXT NOT NULL, repeats INTEGER NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
 snooze_minutes INTEGER NOT NULL DEFAULT 0, max_snoozes INTEGER NOT NULL DEFAULT 0,
 retry_minutes INTEGER NOT NULL DEFAULT 0, max_retries INTEGER NOT NULL DEFAULT 0,
 until_ack INTEGER NOT NULL DEFAULT 0, late_ok INTEGER NOT NULL DEFAULT 0,
 revision INTEGER NOT NULL DEFAULT 1, reminder_id TEXT, source TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS due_schedules ON schedules(enabled,at);
CREATE TABLE IF NOT EXISTS runs (
 fire_key TEXT PRIMARY KEY, schedule_id TEXT NOT NULL,
 label TEXT NOT NULL, started_at TEXT NOT NULL,
 result TEXT NOT NULL, call_id TEXT,
 snoozes INTEGER NOT NULL DEFAULT 0, retries INTEGER NOT NULL DEFAULT 0,
 decided INTEGER NOT NULL DEFAULT 0, chain_started TEXT,
 halt INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS recent_runs ON runs(started_at);
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
 detail TEXT, decided_at TEXT, schedule_revision INTEGER, new_reminder_id TEXT
);
CREATE INDEX IF NOT EXISTS command_reminder ON commands(reminder_id,state);
CREATE INDEX IF NOT EXISTS command_received ON commands(received_at);
CREATE TABLE IF NOT EXISTS reminders (
 reminder_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, schedule_id TEXT NOT NULL, command_id TEXT NOT NULL,
 call_at TEXT NOT NULL, planned_text_at TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, replaced_by TEXT
);
-- One row per finished call: what was pressed and what the app did next.
CREATE TABLE IF NOT EXISTS events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, schedule_id TEXT NOT NULL, reminder_id TEXT,
 fire_key TEXT NOT NULL, call_id TEXT, kind TEXT NOT NULL, call_status TEXT, digits TEXT, outcome TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS event_reminder ON events(reminder_id);
