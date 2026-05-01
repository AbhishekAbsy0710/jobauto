-- JobAuto Schema for Supabase
-- Run this in Supabase SQL Editor: Dashboard → SQL Editor → New Query

-- Jobs table
CREATE TABLE IF NOT EXISTS jobs (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  company TEXT,
  location TEXT,
  description TEXT,
  apply_link TEXT,
  platform TEXT,
  remote BOOLEAN DEFAULT false,
  tags JSONB DEFAULT '[]'::jsonb,
  status TEXT DEFAULT 'new',
  source_id TEXT UNIQUE,
  scraped_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Evaluations table
CREATE TABLE IF NOT EXISTS evaluations (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT REFERENCES jobs(id) ON DELETE CASCADE,
  letter_grade TEXT,
  weighted_score REAL,
  match_percentage REAL,
  archetype TEXT,
  action TEXT,
  priority TEXT,
  risk_level TEXT,
  reason TEXT,
  matching_skills JSONB DEFAULT '[]'::jsonb,
  missing_skills JSONB DEFAULT '[]'::jsonb,
  resume_improvements JSONB DEFAULT '[]'::jsonb,
  dimension_scores JSONB DEFAULT '{}'::jsonb,
  star_stories JSONB DEFAULT '[]'::jsonb,
  evaluated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Applications table
CREATE TABLE IF NOT EXISTS applications (
  id BIGSERIAL PRIMARY KEY,
  evaluation_id BIGINT REFERENCES evaluations(id) ON DELETE CASCADE,
  method TEXT DEFAULT 'manual',
  status TEXT DEFAULT 'submitted',
  pdf_path TEXT,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_source_id ON jobs(source_id);
CREATE INDEX IF NOT EXISTS idx_evals_job_id ON evaluations(job_id);
CREATE INDEX IF NOT EXISTS idx_evals_grade ON evaluations(letter_grade);
CREATE INDEX IF NOT EXISTS idx_apps_eval_id ON applications(evaluation_id);

-- Disable RLS (private tool, no auth needed)
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE applications ENABLE ROW LEVEL SECURITY;

-- Allow all access with service key
CREATE POLICY IF NOT EXISTS "Allow all jobs" ON jobs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "Allow all evals" ON evaluations FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "Allow all apps" ON applications FOR ALL USING (true) WITH CHECK (true);
