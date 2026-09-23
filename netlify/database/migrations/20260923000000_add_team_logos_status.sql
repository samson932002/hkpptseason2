-- A team can now indicate "we don't have a logo — please design one for us"
-- instead of uploading a file. That row has no Drive file at all, so
-- drive_file_id/drive_view_url must become nullable, and a status column
-- distinguishes the two cases for the admin table.
ALTER TABLE team_logos ALTER COLUMN drive_file_id DROP NOT NULL;
ALTER TABLE team_logos ALTER COLUMN drive_view_url DROP NOT NULL;
ALTER TABLE team_logos ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'uploaded';
