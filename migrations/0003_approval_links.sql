-- One-time approval links for drafts (Pushover one-tap approval). Apply once:
--   npx wrangler d1 execute callme-alarms --remote --file=migrations/0003_approval_links.sql
CREATE TABLE IF NOT EXISTS approval_links (
 id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, draft_hash TEXT NOT NULL, expires_at TEXT NOT NULL,
 created_at TEXT NOT NULL, used_at TEXT, revoked INTEGER NOT NULL DEFAULT 0, result TEXT
);
CREATE INDEX IF NOT EXISTS approval_link_draft ON approval_links(draft_id);
