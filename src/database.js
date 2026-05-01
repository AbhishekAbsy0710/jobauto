import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'db', 'jobauto.db');

let db;

export function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

export function initializeDb() {
  const database = getDb();

  database.exec(`
    CREATE TABLE IF NOT EXISTS resumes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      skills TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT UNIQUE,
      title TEXT NOT NULL,
      company TEXT,
      platform TEXT,
      apply_link TEXT,
      apply_type TEXT,
      description TEXT,
      location TEXT,
      tags TEXT,
      remote INTEGER DEFAULT 0,
      scraped_at TEXT DEFAULT (datetime('now')),
      status TEXT DEFAULT 'new'
    );

    CREATE TABLE IF NOT EXISTS evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER REFERENCES jobs(id),
      resume_id INTEGER REFERENCES resumes(id),
      match_percentage INTEGER,
      ranking_score REAL,
      skill_depth_score INTEGER,
      role_alignment_score INTEGER,
      letter_grade TEXT,
      weighted_score REAL,
      archetype TEXT,
      dimension_scores TEXT,
      star_stories TEXT,
      priority TEXT,
      risk_level TEXT,
      action TEXT,
      matching_skills TEXT,
      missing_skills TEXT,
      resume_improvements TEXT,
      reason TEXT,
      raw_response TEXT,
      evaluated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      evaluation_id INTEGER REFERENCES evaluations(id),
      method TEXT,
      status TEXT DEFAULT 'pending',
      cover_letter TEXT,
      pdf_path TEXT,
      notes TEXT,
      applied_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_platform ON jobs(platform);
    CREATE INDEX IF NOT EXISTS idx_jobs_external_id ON jobs(external_id);
    CREATE INDEX IF NOT EXISTS idx_eval_priority ON evaluations(priority);
    CREATE INDEX IF NOT EXISTS idx_eval_action ON evaluations(action);
    CREATE INDEX IF NOT EXISTS idx_eval_grade ON evaluations(letter_grade);
    CREATE INDEX IF NOT EXISTS idx_eval_archetype ON evaluations(archetype);
  `);

  // Migrate: add new columns if upgrading from v1
  const cols = database.prepare("PRAGMA table_info(evaluations)").all().map(c => c.name);
  const newCols = { letter_grade: 'TEXT', weighted_score: 'REAL', archetype: 'TEXT', dimension_scores: 'TEXT', star_stories: 'TEXT' };
  for (const [col, type] of Object.entries(newCols)) {
    if (!cols.includes(col)) {
      database.exec(`ALTER TABLE evaluations ADD COLUMN ${col} ${type}`);
      console.log(`  🔧 Migrated: added evaluations.${col}`);
    }
  }
  const appCols = database.prepare("PRAGMA table_info(applications)").all().map(c => c.name);
  if (!appCols.includes('pdf_path')) {
    database.exec('ALTER TABLE applications ADD COLUMN pdf_path TEXT');
  }

  // Seed default resume
  const resumeCount = database.prepare('SELECT COUNT(*) as count FROM resumes').get();
  if (resumeCount.count === 0) {
    try {
      const cvPath = join(__dirname, '..', 'resume', 'cv.md');
      const txtPath = join(__dirname, '..', 'resume', 'resume.txt');
      const resumePath = existsSync(cvPath) ? cvPath : txtPath;
      const resumeText = readFileSync(resumePath, 'utf-8');
      database.prepare('INSERT INTO resumes (name, content, skills) VALUES (?, ?, ?)').run(
        'Abhishek Raj Pagadala', resumeText,
        JSON.stringify(['Azure', 'Terraform', 'Docker', 'Kubernetes', 'GitHub Actions', 'CI/CD',
          'PHP', 'Laravel', 'Python', 'Django', 'Node.js', 'Flutter', 'React',
          'PostgreSQL', 'MySQL', 'MongoDB', 'CosmosDB', 'Stripe', 'PayPal',
          'RAG', 'LLMs', 'Hugging Face', 'Prompt Engineering'])
      );
      console.log('✅ Default resume loaded');
    } catch (e) {
      console.log('⚠️  No resume found — add resume/cv.md');
    }
  }

  console.log('✅ Database initialized at', DB_PATH);
  return database;
}

// --- Query helpers ---

export function insertJob(job) {
  const stmt = getDb().prepare(`
    INSERT OR IGNORE INTO jobs (external_id, title, company, platform, apply_link, apply_type, description, location, tags, remote)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    job.external_id, job.title, job.company, job.platform,
    job.apply_link, job.apply_type, job.description, job.location,
    JSON.stringify(job.tags || []), job.remote ? 1 : 0
  );
  return result.changes > 0 ? result.lastInsertRowid : null;
}

export function getNewJobs(limit = 50) {
  return getDb().prepare('SELECT * FROM jobs WHERE status = ? ORDER BY scraped_at DESC LIMIT ?').all('new', limit);
}

export function getJobById(id) {
  return getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

export function getAllJobs(filters = {}) {
  let query = `SELECT j.*, e.match_percentage, e.ranking_score, e.priority, e.risk_level, e.action,
    e.matching_skills, e.missing_skills, e.resume_improvements, e.reason, e.evaluated_at,
    e.letter_grade, e.weighted_score, e.archetype, e.dimension_scores, e.star_stories
    FROM jobs j LEFT JOIN evaluations e ON j.id = e.job_id WHERE 1=1`;
  const params = [];

  if (filters.status) { query += ' AND j.status = ?'; params.push(filters.status); }
  if (filters.platform) { query += ' AND j.platform = ?'; params.push(filters.platform); }
  if (filters.priority) { query += ' AND e.priority = ?'; params.push(filters.priority); }
  if (filters.action) { query += ' AND e.action = ?'; params.push(filters.action); }
  if (filters.grade) { query += ' AND e.letter_grade = ?'; params.push(filters.grade); }
  if (filters.archetype) { query += ' AND e.archetype = ?'; params.push(filters.archetype); }
  if (filters.minMatch) { query += ' AND e.match_percentage >= ?'; params.push(parseInt(filters.minMatch)); }
  if (filters.search) {
    query += ' AND (j.title LIKE ? OR j.company LIKE ? OR j.description LIKE ?)';
    const s = `%${filters.search}%`;
    params.push(s, s, s);
  }

  query += ' ORDER BY COALESCE(e.weighted_score, e.ranking_score, 0) DESC, j.scraped_at DESC';
  if (filters.limit) { query += ' LIMIT ?'; params.push(parseInt(filters.limit)); }

  return getDb().prepare(query).all(...params);
}

export function updateJobStatus(id, status) {
  return getDb().prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, id);
}

export function insertEvaluation(evaluation) {
  const stmt = getDb().prepare(`
    INSERT INTO evaluations (job_id, resume_id, match_percentage, ranking_score, skill_depth_score,
      role_alignment_score, letter_grade, weighted_score, archetype, dimension_scores, star_stories,
      priority, risk_level, action, matching_skills, missing_skills, resume_improvements, reason, raw_response)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    evaluation.job_id, evaluation.resume_id || 1,
    evaluation.match_percentage, evaluation.ranking_score,
    evaluation.skill_depth_score, evaluation.role_alignment_score,
    evaluation.letter_grade, evaluation.weighted_score,
    evaluation.archetype, JSON.stringify(evaluation.dimension_scores || {}),
    JSON.stringify(evaluation.star_stories || []),
    evaluation.priority, evaluation.risk_level, evaluation.action,
    JSON.stringify(evaluation.matching_skills || []),
    JSON.stringify(evaluation.missing_skills || []),
    JSON.stringify(evaluation.resume_improvements || []),
    evaluation.reason, JSON.stringify(evaluation.raw_response || {})
  );
}

export function getStats() {
  const d = getDb();
  return {
    total_jobs: d.prepare('SELECT COUNT(*) as c FROM jobs').get().c,
    new_jobs: d.prepare("SELECT COUNT(*) as c FROM jobs WHERE status = 'new'").get().c,
    evaluated: d.prepare('SELECT COUNT(*) as c FROM evaluations').get().c,
    auto_apply: d.prepare("SELECT COUNT(*) as c FROM evaluations WHERE action = 'Apply'").get().c,
    manual_apply: d.prepare("SELECT COUNT(*) as c FROM evaluations WHERE action = 'Review'").get().c,
    ignored: d.prepare("SELECT COUNT(*) as c FROM evaluations WHERE action = 'Skip'").get().c,
    high_priority: d.prepare("SELECT COUNT(*) as c FROM evaluations WHERE letter_grade IN ('A','B')").get().c,
    applied: d.prepare("SELECT COUNT(*) as c FROM jobs WHERE status = 'applied'").get().c,
    interviews: d.prepare("SELECT COUNT(*) as c FROM jobs WHERE status = 'interview'").get().c,
    avg_match: d.prepare('SELECT ROUND(AVG(weighted_score), 1) as avg FROM evaluations').get().avg || 0,
    platforms: d.prepare('SELECT platform, COUNT(*) as count FROM jobs GROUP BY platform').all(),
    grades: d.prepare('SELECT letter_grade, COUNT(*) as count FROM evaluations WHERE letter_grade IS NOT NULL GROUP BY letter_grade').all(),
    archetypes: d.prepare('SELECT archetype, COUNT(*) as count FROM evaluations WHERE archetype IS NOT NULL GROUP BY archetype').all(),
  };
}

export function getResume() {
  return getDb().prepare('SELECT * FROM resumes ORDER BY id DESC LIMIT 1').get();
}

export function insertApplication(evalId, method, pdfPath) {
  return getDb().prepare(
    'INSERT INTO applications (evaluation_id, method, status, pdf_path) VALUES (?, ?, ?, ?)'
  ).run(evalId, method, 'applied', pdfPath);
}

if (process.argv.includes('--setup')) {
  initializeDb();
  console.log('🎉 Database setup complete!');
  process.exit(0);
}
