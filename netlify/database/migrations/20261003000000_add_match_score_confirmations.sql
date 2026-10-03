-- Captains confirm (or dispute) the final result once staff have entered
-- all 5 legs. Keyed by team name:
--   {"<team>": {"status": "confirmed"|"disputed", "name": "...", "note": "...", "at": "<iso>"}}
-- Reset to {} whenever staff change a score, so captains re-confirm the
-- corrected result.
ALTER TABLE match_scores ADD COLUMN IF NOT EXISTS confirmations JSONB NOT NULL DEFAULT '{}'::jsonb;
