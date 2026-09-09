CREATE TABLE IF NOT EXISTS roster_submissions (
  id SERIAL PRIMARY KEY,
  team TEXT NOT NULL,
  players JSONB NOT NULL DEFAULT '[]'::jsonb,
  avg_dupr NUMERIC NOT NULL DEFAULT 0,
  male_count INTEGER NOT NULL DEFAULT 0,
  female_count INTEGER NOT NULL DEFAULT 0,
  reopened BOOLEAN NOT NULL DEFAULT false,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT roster_submissions_team_key UNIQUE (team)
);
