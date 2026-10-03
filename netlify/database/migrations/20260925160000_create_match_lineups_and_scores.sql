-- Test feature: per-match starting lineups (submitted by each team's
-- captain before their match) and live leg-by-leg scoring (entered by
-- on-site staff during the match).
--
-- match_id is an opaque, client-built string ("<teamAId>-<teamBId>",
-- e.g. "E1-E3") derived from schedule.json + the
-- team identifiers already in divisions.json. It is never reconstructed
-- server-side — both functions just treat it as a stable key.

CREATE TABLE IF NOT EXISTS match_lineups (
  id SERIAL PRIMARY KEY,
  match_id TEXT NOT NULL,
  division TEXT NOT NULL,
  team TEXT NOT NULL,
  -- {"WD": ["Player A","Player B"], "XD1": [...], "XD2": [...], "XD3": [...], "MD": [...]}
  legs JSONB NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT match_lineups_match_team_key UNIQUE (match_id, team)
);

-- One row per match. legs is an ordered, append-only (or last-entry-
-- correctable) log of cumulative running totals: [{"leg":"WD","teamA":18,
-- "teamB":14,"enteredAt":"..."}, ...] in fixed leg order WD, XD1, XD2,
-- XD3, MD. The match is a continuous relay race to 100 cumulative points,
-- so it can finish before all 5 legs are logged.
CREATE TABLE IF NOT EXISTS match_scores (
  id SERIAL PRIMARY KEY,
  match_id TEXT NOT NULL UNIQUE,
  division TEXT NOT NULL,
  team_a TEXT NOT NULL,
  team_b TEXT NOT NULL,
  legs JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'in_progress', -- 'in_progress' | 'final'
  winner TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
