#!/usr/bin/env node
// CJS server — instant startup, no ESM import deadlocks
const http = require('http');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(__dirname, 'public');
const DB_PATH = path.join(ROOT, 'db', 'jobauto.db');

// Load .env
try {
  const envFile = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  envFile.split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && !k.startsWith('#')) process.env[k.trim()] = v.join('=').trim();
  });
} catch {}

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';
const MIME = { '.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon','.woff2':'font/woff2' };

// DB connection
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

function safeJson(s, fb) { if (!s) return fb; if (typeof s==='object') return s; try { return JSON.parse(s); } catch { return fb; } }
function sendJson(res, data, status=200) { res.writeHead(status, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}); res.end(JSON.stringify(data)); }
function readBody(req) { return new Promise(r => { let b=''; req.on('data',c=>b+=c); req.on('end',()=>{ try{r(JSON.parse(b))}catch{r({})} }); }); }

function serveFile(res, fp) {
  try {
    if (!fs.existsSync(fp)) return false;
    res.writeHead(200, {'Content-Type': MIME[path.extname(fp)]||'application/octet-stream'});
    res.end(fs.readFileSync(fp));
    return true;
  } catch { return false; }
}

// ========== STATS ==========
function getStats() {
  const total = db.prepare('SELECT COUNT(*) as c FROM jobs').get().c;
  const evaluated = db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status != 'new'").get().c;
  const newJobs = db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status = 'new'").get().c;
  const autoApply = db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status IN ('auto_queue','applied')").get().c;
  const manualApply = db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status = 'manual_queue'").get().c;
  const ignored = db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status = 'archived'").get().c;
  const applied = db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status = 'applied'").get().c;
  const highPri = db.prepare("SELECT COUNT(*) as c FROM evaluations WHERE letter_grade IN ('A','B')").get().c;
  const avgMatch = db.prepare("SELECT ROUND(AVG(weighted_score),1) as a FROM evaluations WHERE weighted_score > 0").get().a || 0;
  const grades = db.prepare("SELECT letter_grade, COUNT(*) as count FROM evaluations WHERE letter_grade IS NOT NULL GROUP BY letter_grade ORDER BY letter_grade").all();
  const platforms = db.prepare("SELECT platform, COUNT(*) as count FROM jobs GROUP BY platform ORDER BY count DESC").all();
  const archetypes = db.prepare("SELECT archetype, COUNT(*) as count FROM evaluations WHERE archetype IS NOT NULL GROUP BY archetype ORDER BY count DESC").all();
  return { total_jobs:total, new_jobs:newJobs, evaluated, auto_apply:autoApply, manual_apply:manualApply, ignored, applied, high_priority:highPri, avg_match:avgMatch, grades, platforms, archetypes, interviews:0 };
}

// ========== SERVER ==========
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const m = req.method;

  // CORS preflight
  if (m === 'OPTIONS') { res.writeHead(204, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'*','Access-Control-Allow-Headers':'*'}); return res.end(); }

  try {
    // === STATS ===
    if (p === '/api/stats') return sendJson(res, getStats());

    // === HEALTH ===
    if (p === '/api/health') return sendJson(res, { status:'ok', version:'v2.1.0', uptime: process.uptime() });

    // === JOBS LIST ===
    if (p === '/api/jobs' && m === 'GET') {
      const limit = url.searchParams.get('limit') || 200;
      const grade = url.searchParams.get('grade');
      const search = url.searchParams.get('search');
      let sql = `SELECT j.*, e.letter_grade, e.weighted_score, e.archetype, e.matching_skills, e.missing_skills, e.resume_improvements, e.dimension_scores, e.star_stories, e.reason, e.action, e.priority
        FROM jobs j LEFT JOIN evaluations e ON e.job_id = j.id`;
      const conditions = [];
      const params = [];
      if (grade) { conditions.push('e.letter_grade = ?'); params.push(grade); }
      if (search) { conditions.push('(j.title LIKE ? OR j.company LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
      if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
      sql += ' ORDER BY e.weighted_score DESC NULLS LAST LIMIT ?';
      params.push(parseInt(limit));
      const jobs = db.prepare(sql).all(...params);
      return sendJson(res, jobs.map(j => ({
        ...j, tags:safeJson(j.tags,[]), matching_skills:safeJson(j.matching_skills,[]),
        missing_skills:safeJson(j.missing_skills,[]), resume_improvements:safeJson(j.resume_improvements,[]),
        dimension_scores:safeJson(j.dimension_scores,{}), star_stories:safeJson(j.star_stories,[])
      })));
    }

    // === SINGLE JOB ===
    if (p.match(/^\/api\/jobs\/\d+$/) && m === 'GET') {
      const id = parseInt(p.split('/').pop());
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
      if (!job) return sendJson(res, {error:'Not found'}, 404);
      const ev = db.prepare('SELECT * FROM evaluations WHERE job_id = ? ORDER BY evaluated_at DESC LIMIT 1').get(id);
      return sendJson(res, { ...job, tags:safeJson(job.tags,[]), evaluation: ev ? {
        ...ev, matching_skills:safeJson(ev.matching_skills,[]), missing_skills:safeJson(ev.missing_skills,[]),
        dimension_scores:safeJson(ev.dimension_scores,{}), star_stories:safeJson(ev.star_stories,[]),
        resume_improvements:safeJson(ev.resume_improvements,[])
      } : null });
    }

    // === MARK APPLIED ===
    if (p.match(/^\/api\/jobs\/\d+\/apply$/) && m === 'POST') {
      const id = parseInt(p.split('/')[3]);
      db.prepare("UPDATE jobs SET status = 'applied' WHERE id = ?").run(id);
      return sendJson(res, {success:true});
    }

    // === APPLICATIONS ===
    if (p === '/api/applications') {
      const apps = db.prepare(`
        SELECT a.id as app_id, a.method, a.status as app_status, a.pdf_path, a.applied_at,
               j.title, j.company, j.location, j.platform, j.apply_link,
               e.letter_grade, e.weighted_score, e.matching_skills, e.resume_improvements
        FROM applications a JOIN evaluations e ON e.id = a.evaluation_id JOIN jobs j ON j.id = e.job_id
        ORDER BY a.applied_at DESC
      `).all();
      return sendJson(res, apps.map(a => ({...a, matching_skills:safeJson(a.matching_skills,[]), resume_improvements:safeJson(a.resume_improvements,[])})));
    }

    // === TRIGGER EVALUATE ===
    if (p === '/api/trigger-evaluate' && m === 'POST') {
      sendJson(res, {message:'Evaluation starting'});
      import('./services/actionRouter.js').then(m => m.evaluateNewJobs(20,1)).catch(e => console.error('Eval fail:', e.message));
      return;
    }

    // === TRIGGER SCRAPE ===
    if (p === '/api/trigger-scrape' && m === 'POST') {
      sendJson(res, {message:'Scrape starting'});
      import('./scrapers/index.js').then(m => m.runAllScrapers()).catch(e => console.error('Scrape fail:', e.message));
      return;
    }

    // === TRIGGER AUTO-APPLY ===
    if (p === '/api/trigger-apply' && m === 'POST') {
      sendJson(res, {message:'Auto-apply starting'});
      const { execSync } = require('child_process');
      const scriptPath = path.join(__dirname, 'scripts', 'browser-apply.js');
      try {
        execSync(`PLAYWRIGHT_BROWSERS_PATH=0 node ${scriptPath}`, { cwd: ROOT, timeout: 600000, stdio: 'inherit' });
      } catch(e) { console.error('Apply fail:', e.message); }
      return;
    }

    // === SERVE RESUME PDF ===
    if (p === '/api/resume') {
      const resumePath = path.join(ROOT, 'resume', 'resume.pdf');
      if (fs.existsSync(resumePath)) {
        res.writeHead(200, {'Content-Type':'application/pdf','Content-Disposition':'inline; filename="Abhishek_Raj_Pagadala_Resume.pdf"','Access-Control-Allow-Origin':'*'});
        return res.end(fs.readFileSync(resumePath));
      }
      return sendJson(res, {error:'Resume not found'}, 404);
    }

    // === DISCORD REPORT ===
    if (p === '/api/send-report' && m === 'POST') {
      if (!DISCORD_WEBHOOK) return sendJson(res, {error:'No webhook'}, 400);
      const stats = getStats();
      const topJobs = db.prepare(`
        SELECT j.title, j.company, j.location, j.apply_link, e.letter_grade, e.weighted_score, e.matching_skills
        FROM evaluations e JOIN jobs j ON j.id = e.job_id
        WHERE e.letter_grade IN ('A','B') AND e.weighted_score > 0
        ORDER BY e.weighted_score DESC LIMIT 10
      `).all();
      const apps = db.prepare(`
        SELECT j.title, j.company, a.method, a.applied_at, a.pdf_path
        FROM applications a JOIN evaluations e ON e.id = a.evaluation_id JOIN jobs j ON j.id = e.job_id
        ORDER BY a.applied_at DESC LIMIT 10
      `).all();

      await fetch(DISCORD_WEBHOOK, { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({username:'JobAuto', embeds:[{
          title:'📊 CareerOps Report', color:0x4da6ff,
          description:`**${stats.evaluated}/${stats.total_jobs}** evaluated · Avg ${stats.avg_match}/5`,
          fields:[
            {name:'🚀 Apply',value:`${stats.auto_apply}`,inline:true},
            {name:'👋 Review',value:`${stats.manual_apply}`,inline:true},
            {name:'✅ Applied',value:`${stats.applied}`,inline:true},
            {name:'📈 Grades',value:stats.grades.map(g=>`${g.letter_grade}: ${g.count}`).join(' · ')||'None',inline:false}
          ], timestamp:new Date().toISOString(), footer:{text:'JobAuto v2.1'}
        }]})
      });

      if (topJobs.length) {
        await fetch(DISCORD_WEBHOOK, { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({username:'JobAuto', embeds:[{
            title:'🔥 Top Matches (EU Only)', color:0x00d2a0,
            fields: topJobs.map((j,i) => ({
              name:`${i+1}. ${j.title} (${j.weighted_score}/5)`,
              value:`**${j.company}** · ${j.location||'N/A'}\n${safeJson(j.matching_skills,[]).slice(0,3).join(', ')}\n[Apply](${j.apply_link})`,
              inline:false
            })), footer:{text:'Sorted by score'}
          }]})
        });
      }

      if (apps.length) {
        await fetch(DISCORD_WEBHOOK, { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({username:'JobAuto', embeds:[{
            title:'✅ Applied Jobs', color:0x00b894,
            fields: apps.map((a,i) => ({
              name:`${i+1}. ${a.title}`,
              value:`**${a.company}** · ${a.method} · ${a.applied_at}${a.pdf_path?'\n📄 PDF':''}`,
              inline:false
            })), footer:{text:`${apps.length} applications`}
          }]})
        });
      }

      return sendJson(res, {success:true, topJobs:topJobs.length, apps:apps.length});
    }

    // === STATIC FILES ===
    if (p.startsWith('/output/')) { if (serveFile(res, path.join(ROOT,'output',p.replace('/output/','')))) return; }
    if (serveFile(res, path.join(PUBLIC, p === '/' ? 'index.html' : p))) return;
    serveFile(res, path.join(PUBLIC, 'index.html')) || sendJson(res, {error:'Not found'}, 404);

  } catch (err) {
    console.error(`❌ ${m} ${p}: ${err.message}`);
    sendJson(res, {error: err.message}, 500);
  }
});

server.listen(PORT, () => {
  console.log(`\n🚀 JobAuto v2.1 — http://localhost:${PORT}`);
  console.log(`   ${db.prepare('SELECT COUNT(*) as c FROM jobs').get().c} jobs in DB`);
  console.log('');
});
