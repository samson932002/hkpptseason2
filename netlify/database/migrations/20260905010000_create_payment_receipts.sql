CREATE TABLE IF NOT EXISTS payment_receipts (
  id SERIAL PRIMARY KEY,
  team TEXT NOT NULL,
  amount_required INTEGER NOT NULL,
  drive_file_id TEXT NOT NULL,
  drive_view_url TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_receipts_team_key UNIQUE (team)
);
