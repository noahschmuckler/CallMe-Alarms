CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), paused INTEGER NOT NULL DEFAULT 1);
INSERT OR IGNORE INTO settings(id, paused) VALUES(1, 1);
CREATE TABLE IF NOT EXISTS schedules (
 id TEXT PRIMARY KEY, label TEXT NOT NULL, at TEXT NOT NULL,
 days TEXT NOT NULL, once_date TEXT NOT NULL DEFAULT '',
 message TEXT NOT NULL, repeats INTEGER NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS due_schedules ON schedules(enabled,at);
CREATE TABLE IF NOT EXISTS runs (
 fire_key TEXT PRIMARY KEY, schedule_id TEXT NOT NULL,
 label TEXT NOT NULL, started_at TEXT NOT NULL,
 result TEXT NOT NULL, call_id TEXT
);
CREATE INDEX IF NOT EXISTS recent_runs ON runs(started_at);
