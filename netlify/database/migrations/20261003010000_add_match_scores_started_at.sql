-- Staff explicitly confirm both lineups and start the match from /staff.
-- From that moment captains can no longer change their lineup, and only then
-- can leg scores be recorded. NULL = not started (lineups still editable).
ALTER TABLE match_scores ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
