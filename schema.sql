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
 source TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS due_schedules ON schedules(enabled,at);
CREATE TABLE IF NOT EXISTS runs (
 fire_key TEXT PRIMARY KEY, schedule_id TEXT NOT NULL,
 label TEXT NOT NULL, started_at TEXT NOT NULL,
 result TEXT NOT NULL, call_id TEXT,
 snoozes INTEGER NOT NULL DEFAULT 0, retries INTEGER NOT NULL DEFAULT 0,
 decided INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS recent_runs ON runs(started_at);
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
