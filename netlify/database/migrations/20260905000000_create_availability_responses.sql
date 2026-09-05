CREATE TABLE IF NOT EXISTS availability_responses (
  id SERIAL PRIMARY KEY,
  team TEXT NOT NULL,
  picks JSONB NOT NULL DEFAULT '[]'::jsonb,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT availability_responses_team_key UNIQUE (team)
);
