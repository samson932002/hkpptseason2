CREATE TABLE IF NOT EXISTS team_acknowledgments (
  id SERIAL PRIMARY KEY,
  team TEXT NOT NULL,
  captain_name TEXT NOT NULL,
  ack_date TEXT NOT NULL,
  shared_with_team BOOLEAN NOT NULL DEFAULT false,
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT team_acknowledgments_team_key UNIQUE (team)
);
