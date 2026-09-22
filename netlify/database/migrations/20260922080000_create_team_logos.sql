CREATE TABLE IF NOT EXISTS team_logos (
  id SERIAL PRIMARY KEY,
  team TEXT NOT NULL,
  division_zh TEXT NOT NULL,
  drive_file_id TEXT NOT NULL,
  drive_view_url TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT team_logos_team_key UNIQUE (team)
);
