-- "replace" proposals: one command that swaps an approved reminder for a new one. Apply once:
--   npx wrangler d1 execute callme-alarms --remote --file=migrations/0002_replace_command.sql
ALTER TABLE commands ADD COLUMN new_reminder_id TEXT;
ALTER TABLE reminders ADD COLUMN replaced_by TEXT;
