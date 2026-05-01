import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));
app.use('/output', express.static(join(__dirname, '..', 'output')));

function safeJson(str, fallback) {
  if (!str) return fallback;
  if (typeof str === 'object') return str;
  try { return JSON.parse(str); } catch { return fallback; }
}

// ============================================
// API ROUTES — all use lazy imports
// ============================================

app.get('/api/stats', async (req, res) => {
  try {
    const { getStats } = await import('./database.js');
    res.json(getStats());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/jobs', async (req, res) => {
  try {
    const { getAllJobs } = await import('./database.js');
    const jobs = getAllJobs({
      status: req.query.status, platform: req.query.platform,
      priority: req.query.priority, action: req.query.action,
      grade: req.query.grade, archetype: req.query.archetype,
      minMatch: req.query.minMatch, search: req.query.search,
      limit: req.query.limit || 200
    });
    const parsed = jobs.map(j => ({
      ...j, tags: safeJson(j.tags, []),
      matching_skills: safeJson(j.matching_skills, []),
      missing_skills: safeJson(j.missing_skills, []),
      resume_improvements: safeJson(j.resume_improvements, []),
      dimension_scores: safeJson(j.dimension_scores, {}),
      star_stories: safeJson(j.star_stories, [])
    }));
    res.json(parsed);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/jobs/:id', async (req, res) => {
  try {
    const { getJobById, getDb } = await import('./database.js');
    const job = getJobById(parseInt(req.params.id));
    if (!job) return res.status(404).json({ error: 'Not found' });
    const evaluation = getDb().prepare(
      'SELECT * FROM evaluations WHERE job_id = ? ORDER BY evaluated_at DESC LIMIT 1'
    ).get(job.id);
    res.json({
      ...job, tags: safeJson(job.tags, []),
      evaluation: evaluation ? {
        ...evaluation,
        matching_skills: safeJson(evaluation.matching_skills, []),
        missing_skills: safeJson(evaluation.missing_skills, []),
        resume_improvements: safeJson(evaluation.resume_improvements, []),
        dimension_scores: safeJson(evaluation.dimension_scores, {}),
        star_stories: safeJson(evaluation.star_stories, [])
      } : null
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/jobs/:id/status', async (req, res) => {
  try {
    const { updateJobStatus } = await import('./database.js');
    if (!req.body.status) return res.status(400).json({ error: 'Status required' });
    updateJobStatus(parseInt(req.params.id), req.body.status);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/jobs/:id/apply', async (req, res) => {
  try {
    const { getDb, insertApplication, updateJobStatus } = await import('./database.js');
    const jobId = parseInt(req.params.id);
    const evalRow = getDb().prepare(
      'SELECT id FROM evaluations WHERE job_id = ? ORDER BY evaluated_at DESC LIMIT 1'
    ).get(jobId);
    if (evalRow) insertApplication(evalRow.id, 'manual', null);
    updateJobStatus(jobId, 'applied');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/jobs/:id/generate-pdf', async (req, res) => {
  try {
    const { getJobById, getDb } = await import('./database.js');
    const job = getJobById(parseInt(req.params.id));
    if (!job) return res.status(404).json({ error: 'Not found' });
    const evaluation = getDb().prepare(
      'SELECT * FROM evaluations WHERE job_id = ? ORDER BY evaluated_at DESC LIMIT 1'
    ).get(job.id);
    const bullets = evaluation ? safeJson(evaluation.resume_improvements, []) : null;
    const { generateTailoredPDF } = await import('./services/pdfGenerator.js');
    const result = await generateTailoredPDF(job, bullets);
    res.json({ success: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/resume', async (req, res) => {
  try {
    const { getResume } = await import('./database.js');
    res.json(getResume() || { content: '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/profile', async (req, res) => {
  try {
    const { loadProfile } = await import('./config.js');
    res.json(loadProfile());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/applications', async (req, res) => {
  try {
    const { getDb } = await import('./database.js');
    const apps = getDb().prepare(`
      SELECT a.id as app_id, a.method, a.status as app_status, a.cover_letter, a.pdf_path, a.applied_at,
             j.title, j.company, j.location, j.platform, j.apply_link,
             e.letter_grade, e.weighted_score, e.archetype, e.matching_skills, e.missing_skills,
             e.resume_improvements, e.reason
      FROM applications a
      JOIN evaluations e ON e.id = a.evaluation_id
      JOIN jobs j ON j.id = e.job_id
      ORDER BY a.applied_at DESC
    `).all();
    res.json(apps.map(a => ({
      ...a,
      matching_skills: safeJson(a.matching_skills, []),
      missing_skills: safeJson(a.missing_skills, []),
      resume_improvements: safeJson(a.resume_improvements, []),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Trigger scrape
app.post('/api/trigger-scrape', async (req, res) => {
  try {
    res.json({ message: 'Scrape started' });
    const { runAllScrapers } = await import('./scrapers/index.js');
    const results = await runAllScrapers();
    console.log('Scrape done:', results);
  } catch (e) { console.error('Scrape failed:', e.message); }
});

// Trigger evaluation
app.post('/api/trigger-evaluate', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    res.json({ message: `Evaluating ${limit} jobs` });
    const { evaluateNewJobs } = await import('./services/actionRouter.js');
    const results = await evaluateNewJobs(limit, 1);
    console.log('Evaluation done:', results);
  } catch (e) { console.error('Evaluation failed:', e.message); }
});

// Send Discord report
app.post('/api/send-report', async (req, res) => {
  try {
    const { getStats, getDb } = await import('./database.js');
    const { loadConfig } = await import('./config.js');
    const cfg = loadConfig();
    if (!cfg.discordWebhookUrl) return res.status(400).json({ error: 'No Discord webhook' });

    const stats = getStats();
    const topJobs = getDb().prepare(`
      SELECT j.title, j.company, j.location, j.apply_link,
             e.letter_grade, e.weighted_score, e.matching_skills
      FROM evaluations e JOIN jobs j ON j.id = e.job_id
      WHERE e.letter_grade IN ('A','B') AND e.weighted_score > 0
      ORDER BY e.weighted_score DESC LIMIT 10
    `).all();

    const apps = getDb().prepare(`
      SELECT j.title, j.company, a.method, a.applied_at, a.pdf_path
      FROM applications a
      JOIN evaluations e ON e.id = a.evaluation_id
      JOIN jobs j ON j.id = e.job_id
      ORDER BY a.applied_at DESC LIMIT 10
    `).all();

    // Stats embed
    await fetch(cfg.discordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'JobAuto', embeds: [{
        title: '📊 CareerOps Pipeline Report',
        description: `**${stats.evaluated}/${stats.total_jobs}** evaluated · Avg ${stats.avg_match}/5`,
        color: 0x4da6ff,
        fields: [
          { name: '🚀 Apply', value: `${stats.auto_apply}`, inline: true },
          { name: '👋 Review', value: `${stats.manual_apply}`, inline: true },
          { name: '✅ Applied', value: `${stats.applied}`, inline: true },
          { name: '📈 Grades', value: (stats.grades || []).map(g => `${g.letter_grade}: ${g.count}`).join(' · ') || 'None', inline: false },
        ],
        timestamp: new Date().toISOString(),
        footer: { text: 'JobAuto v2' }
      }]})
    });

    // Top jobs embed
    if (topJobs.length > 0) {
      await fetch(cfg.discordWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'JobAuto', embeds: [{
          title: '🔥 Top Job Matches (EU Only)',
          color: 0x00d2a0,
          fields: topJobs.map((j, i) => ({
            name: `${i+1}. ${j.title} (${j.weighted_score}/5)`,
            value: `**${j.company}** · ${j.location || 'N/A'}\n${safeJson(j.matching_skills,[]).slice(0,3).join(', ')}\n[Apply](${j.apply_link})`,
            inline: false
          })),
          footer: { text: 'Sorted by score · EU locations only' }
        }]})
      });
    }

    // Applied jobs embed
    if (apps.length > 0) {
      await fetch(cfg.discordWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'JobAuto', embeds: [{
          title: '✅ Applied Jobs',
          color: 0x00b894,
          fields: apps.map((a, i) => ({
            name: `${i+1}. ${a.title}`,
            value: `**${a.company}** · ${a.method} · ${a.applied_at}${a.pdf_path ? '\n📄 Tailored PDF ready' : ''}`,
            inline: false
          })),
          footer: { text: `${apps.length} applications submitted` }
        }]})
      });
    }

    res.json({ success: true, topJobs: topJobs.length, applications: apps.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Health
app.get('/api/health', async (req, res) => {
  try {
    const { checkOllamaHealth } = await import('./services/evaluator.js');
    res.json({ status: 'ok', version: 'v2.1.0', ollama: await checkOllamaHealth(), uptime: process.uptime() });
  } catch (e) { res.json({ status: 'ok', version: 'v2.1.0', uptime: process.uptime() }); }
});

app.get('*', (req, res) => { res.sendFile(join(__dirname, 'public', 'index.html')); });

// ============================================
// START — minimal, no heavy imports at boot
// ============================================
const port = process.env.PORT || 3000;

// Init DB synchronously (it's fast — just sqlite)
try {
  const { initializeDb } = await import('./database.js');
  initializeDb();
} catch (e) { console.error('DB init failed:', e.message); }

// Start scheduler lazily
try {
  const { startScheduler } = await import('./scheduler.js');
  startScheduler();
} catch (e) { console.error('Scheduler failed:', e.message); }

app.listen(port, () => {
  console.log(`\n🚀 JobAuto v2.1 (Career-Ops)`);
  console.log(`   Dashboard: http://localhost:${port}`);
  console.log(`   API:       http://localhost:${port}/api`);
  console.log('');
});
