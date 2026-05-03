// ============================================
// JobAuto v2 — CareerOps Dashboard JS
// ============================================

let allJobs = [];
let debounceTimer = null;

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  loadStats();
  loadJobs();
  checkHealth();
  setInterval(checkHealth, 30000);
});

// ============================================
// HEALTH CHECK
// ============================================
async function checkHealth() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    const dot = document.querySelector('.health-dot');
    const text = document.getElementById('health-text');

    if (data.llm === 'groq') {
      dot.classList.add('online');
      dot.classList.remove('offline');
      text.textContent = 'Groq API Active';
    } else {
      dot.classList.add('offline');
      dot.classList.remove('online');
      text.textContent = 'Groq API Missing';
    }
  } catch {
    const dot = document.querySelector('.health-dot');
    dot.classList.add('offline');
    document.getElementById('health-text').textContent = 'Server Error';
  }
}

// ============================================
// STATS
// ============================================
async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const s = await res.json();

    document.getElementById('sv-total').textContent = s.total_jobs || 0;
    document.getElementById('sv-apply').textContent = s.auto_apply || 0;
    document.getElementById('sv-review').textContent = s.manual_apply || 0;
    document.getElementById('sv-skip').textContent = s.ignored || 0;
    document.getElementById('sv-applied').textContent = s.applied || 0;
    document.getElementById('sv-interviews').textContent = s.interviews || 0;
    document.getElementById('sv-avg').textContent = s.avg_match || 0;

    renderGradeBar(s.grades || []);
  } catch (e) {
    console.error('Stats error:', e);
  }
}

function renderGradeBar(grades) {
  const bar = document.getElementById('grade-bar');
  if (!grades.length) { bar.innerHTML = ''; return; }

  const total = grades.reduce((sum, g) => sum + g.count, 0);
  const gradeOrder = ['A', 'B', 'C', 'D', 'F'];
  const colors = { A: 'grade-a', B: 'grade-b', C: 'grade-c', D: 'grade-d', F: 'grade-f' };

  bar.innerHTML = gradeOrder.map(g => {
    const found = grades.find(x => x.letter_grade === g);
    if (!found) return '';
    const pct = Math.max((found.count / total) * 100, 3);
    return `<div class="grade-segment ${colors[g]}" style="flex:${pct}" data-label="${g}: ${found.count} jobs" onclick="filterByGrade('${g}')"></div>`;
  }).join('');
}

function filterByGrade(grade) {
  document.getElementById('filter-grade').value = grade;
  filterJobs();
}

// ============================================
// JOBS LIST
// ============================================
async function loadJobs() {
  try {
    const res = await fetch('/api/jobs?limit=300');
    allJobs = await res.json();
    renderJobs(allJobs);
    document.getElementById('loading-state')?.remove();
  } catch (e) {
    document.getElementById('job-grid').innerHTML =
      '<div class="empty-state"><div class="empty-icon">⚠️</div><h3>Connection Error</h3><p>Could not reach the API server.</p></div>';
  }
}

function renderJobs(jobs) {
  const grid = document.getElementById('job-grid');

  if (!jobs.length) {
    grid.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><h3>No Jobs Found</h3><p>Try adjusting your filters or run a new scrape.</p></div>';
    return;
  }

  grid.innerHTML = jobs.map(job => {
    const grade = job.letter_grade || '—';
    const gradeClass = `grade-${grade}`;
    const scoreDisplay = job.weighted_score ? `${job.weighted_score}/5` : `${job.match_percentage || 0}%`;
    const scorePct = job.weighted_score ? (job.weighted_score / 5) * 100 : (job.match_percentage || 0);
    const barColor = getGradeColor(grade);
    const actionClass = (job.action || '').toLowerCase();

    const matchingSkills = (job.matching_skills || []).slice(0, 4);
    const missingSkills = (job.missing_skills || []).slice(0, 2);

    return `
      <div class="job-card" onclick="openJobModal(${job.id})">
        <div class="job-card-header">
          <div>
            <div class="job-title">${esc(job.title)}</div>
            <div class="job-company">🏢 ${esc(job.company || 'Unknown')} · 📍 ${esc(job.location || 'N/A')}</div>
          </div>
          <div class="grade-badge ${gradeClass}">${grade}</div>
        </div>

        <div class="job-meta">
          ${job.archetype ? `<span class="tag tag-archetype">${archetypeIcon(job.archetype)} ${esc(job.archetype)}</span>` : ''}
          <span class="tag tag-platform">${platformIcon(job.platform)} ${esc(job.platform)}</span>
          ${job.remote ? '<span class="tag tag-remote">🏠 Remote</span>' : ''}
          ${job.action ? `<span class="tag tag-action ${actionClass}">${actionIcon(job.action)} ${esc(job.action)}</span>` : ''}
        </div>

        <div class="score-bar-container">
          <div class="score-bar"><div class="score-bar-fill" style="width:${scorePct}%;background:${barColor}"></div></div>
          <div class="score-text">
            <span>${scoreDisplay}</span>
            <span>${job.priority || ''}</span>
          </div>
        </div>

        ${matchingSkills.length ? `
          <div class="skills-preview">
            ${matchingSkills.map(s => `<span class="skill-tag">${esc(s)}</span>`).join('')}
            ${missingSkills.map(s => `<span class="skill-tag missing">${esc(s)}</span>`).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

// ============================================
// FILTERS
// ============================================
function debounceFilter() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(filterJobs, 300);
}

function filterJobs() {
  const search = document.getElementById('filter-search').value.toLowerCase();
  const grade = document.getElementById('filter-grade').value;
  const platform = document.getElementById('filter-platform').value;

  let filtered = allJobs;

  if (search) filtered = filtered.filter(j =>
    (j.title || '').toLowerCase().includes(search) ||
    (j.company || '').toLowerCase().includes(search) ||
    (j.description || '').toLowerCase().includes(search)
  );
  if (grade) filtered = filtered.filter(j => j.letter_grade === grade);
  if (platform) filtered = filtered.filter(j => j.platform === platform);

  renderJobs(filtered);
}

// ============================================
// JOB MODAL
// ============================================
async function openJobModal(id) {
  try {
    const res = await fetch(`/api/jobs?id=${id}`);
    const job = await res.json();
    const ev = job.evaluation;

    const dims = ev?.dimension_scores || {};
    const dimHtml = Object.entries(dims).map(([key, val]) => {
      const label = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      const grade = val?.grade || 'C';
      const pct = ({ A: 100, B: 80, C: 60, D: 40, F: 10 })[grade] || 50;
      const color = getGradeColor(grade);
      return `
        <div class="dim-item">
          <span class="dim-label">${label}</span>
          <span class="dim-grade" style="color:${color}">${grade}</span>
          <div class="dim-bar"><div class="dim-bar-fill" style="width:${pct}%;background:${color}"></div></div>
        </div>
      `;
    }).join('');

    const stars = ev?.star_stories || [];
    const starsHtml = stars.length ? stars.map(s => `
      <div class="star-card">
        <div class="star-label">Situation</div><div class="star-text">${esc(s.situation || '')}</div>
        <div class="star-label" style="margin-top:6px">Task</div><div class="star-text">${esc(s.task || '')}</div>
        <div class="star-label" style="margin-top:6px">Action</div><div class="star-text">${esc(s.action || '')}</div>
        <div class="star-label" style="margin-top:6px">Result</div><div class="star-text">${esc(s.result || '')}</div>
      </div>
    `).join('') : '<p style="color:var(--text-muted);font-size:12px">Grade B+ required for STAR stories</p>';

    const matchSkills = (ev?.matching_skills || []).map(s => `<span class="skill-tag">${esc(s)}</span>`).join('');
    const missSkills = (ev?.missing_skills || []).map(s => `<span class="skill-tag missing">${esc(s)}</span>`).join('');
    const improvements = (ev?.resume_improvements || []).map(s => `<li style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">${esc(s)}</li>`).join('');

    // Build description section
    const descHtml = job.description ? `
      <div class="modal-section">
        <div class="modal-section-title">📝 Job Description</div>
        <div style="font-size:13px;color:var(--text-secondary);line-height:1.7;max-height:250px;overflow-y:auto;padding-right:8px;white-space:pre-line">${esc(job.description)}</div>
      </div>
    ` : '';

    // Status badge
    const statusMap = { applied: '✅ Applied', auto_queue: '🚀 In Queue', manual_queue: '👋 Review', archived: '🗄️ Archived', new: '🆕 New', evaluated: '📋 Evaluated' };
    const statusLabel = statusMap[job.status] || job.status;

    // Check for failed applications
    const failedApps = (job.applications || []).filter(a => a.status === 'failed');
    const latestFail = failedApps.length > 0 ? failedApps.sort((a,b) => new Date(b.applied_at) - new Date(a.applied_at))[0] : null;

    const failedWarningHtml = latestFail ? `
      <div style="background:rgba(255, 69, 0, 0.1); border-left: 4px solid #ff4500; padding: 12px; border-radius: 4px; margin-bottom: 16px;">
        <div style="color: #ff4500; font-weight: bold; margin-bottom: 4px;">⚠️ Auto-Apply Failed</div>
        <div style="font-size: 13px; color: var(--text-secondary); margin-bottom: 8px;"><strong>Reason:</strong> ${esc(latestFail.method || 'Unknown Validation Error')}</div>
        ${latestFail.pdf_path ? `<a href="${latestFail.pdf_path}" target="_blank" style="color: #ff4500; text-decoration: underline; font-size: 12px;">📸 View Screenshot of Failure</a>` : ''}
      </div>
    ` : '';

    document.getElementById('modal-content').innerHTML = `
      <div style="display:flex;align-items:flex-start;gap:14px;margin-bottom:16px">
        <div class="grade-badge grade-${ev?.letter_grade || '—'}" style="font-size:24px;width:52px;height:52px">
          ${ev?.letter_grade || '—'}
        </div>
        <div>
          <div class="modal-title">${esc(job.title)}</div>
          <div class="modal-company">🏢 ${esc(job.company)} · 📍 ${esc(job.location || 'N/A')} · ${platformIcon(job.platform)} ${esc(job.platform)}</div>
          <div style="margin-top:4px"><span class="tag" style="background:rgba(255,255,255,0.06);color:var(--text-secondary)">${statusLabel}</span></div>
        </div>
      </div>

      ${failedWarningHtml}

      ${ev ? `
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
          ${ev.archetype ? `<span class="tag tag-archetype">${archetypeIcon(ev.archetype)} ${esc(ev.archetype)}</span>` : ''}
          <span class="tag tag-action ${(ev.action||'').toLowerCase()}">${actionIcon(ev.action)} ${esc(ev.action)}</span>
          <span class="tag" style="background:rgba(255,255,255,0.06);color:var(--text-secondary)">⚠️ ${ev.risk_level} Risk</span>
          <span class="tag" style="background:rgba(255,255,255,0.06);color:var(--text-secondary)">🎯 ${ev.priority}</span>
          <span class="tag" style="background:rgba(255,255,255,0.06);color:var(--text-secondary)">⭐ ${ev.weighted_score}/5.0</span>
        </div>

        <div class="modal-section">
          <div class="modal-section-title">📊 Dimension Scores</div>
          <div class="dim-grid">${dimHtml || '<p style="color:var(--text-muted)">No dimension data</p>'}</div>
        </div>

        <div class="modal-section">
          <div class="modal-section-title">💡 AI Assessment</div>
          <p style="font-size:13px;color:var(--text-secondary);line-height:1.6">${esc(ev.reason || 'No assessment available')}</p>
        </div>

        <div class="modal-section">
          <div class="modal-section-title">✅ Matching Skills</div>
          <div class="skills-preview">${matchSkills || '<span style="color:var(--text-muted);font-size:12px">None detected</span>'}</div>
        </div>

        <div class="modal-section">
          <div class="modal-section-title">❌ Skill Gaps</div>
          <div class="skills-preview">${missSkills || '<span style="color:var(--text-muted);font-size:12px">None — perfect match</span>'}</div>
        </div>

        ${improvements ? `
          <div class="modal-section">
            <div class="modal-section-title">📝 Resume Improvements</div>
            <ul style="padding-left:16px">${improvements}</ul>
          </div>
        ` : ''}

        <div class="modal-section">
          <div class="modal-section-title">🎤 Interview STAR Stories</div>
          ${starsHtml}
        </div>
      ` : '<p style="color:var(--text-muted)">Not yet evaluated — run evaluation first.</p>'}

      ${descHtml}

      <div class="modal-section">
        <div class="modal-section-title">🔗 Also Apply On These Platforms</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${buildCrossLinks(job).map(l => `
            <a href="${l.url}" target="_blank" class="btn btn-outline btn-sm" style="text-decoration:none;font-size:11px">
              ${l.icon} ${l.name}
            </a>
          `).join('')}
        </div>
      </div>

      <div class="modal-actions">
        <a href="${job.apply_link}" target="_blank" class="btn btn-primary" style="text-decoration:none">🔗 Direct Apply</a>
        <button class="btn btn-outline" onclick="generatePDF(${job.id})">📄 Generate PDF</button>
        <button class="btn btn-success" onclick="markApplied(${job.id})" ${job.status === 'applied' ? 'disabled' : ''}>
          ${job.status === 'applied' ? '✅ Applied' : '✅ Mark Applied'}
        </button>
        <button class="btn btn-outline" style="border-color: #4da6ff; color: #4da6ff;" onclick="updateStatus(${job.id}, 'auto_queue')">🚀 Send to Auto-Apply</button>
        <button class="btn btn-outline" onclick="updateStatus(${job.id}, 'archived')">🗄️ Archive</button>
      </div>
    `;

    document.getElementById('modal-overlay').classList.add('active');
    document.body.style.overflow = 'hidden';
  } catch (e) {
    console.error('Modal error:', e);
  }
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('active');
  document.body.style.overflow = '';
}

// Close on Escape
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ============================================
// ACTIONS
// ============================================
async function triggerScrape() {
  const btn = document.getElementById('btn-scrape');
  btn.disabled = true;
  btn.innerHTML = '<span>⏳</span> Scraping...';

  try {
    await fetch('/api/trigger-scrape', { method: 'POST' });
    setTimeout(() => {
      loadStats();
      loadJobs();
      btn.disabled = false;
      btn.innerHTML = '<span>🔍</span> Scrape';
    }, 3000);
  } catch {
    btn.disabled = false;
    btn.innerHTML = '<span>🔍</span> Scrape';
  }
}

async function triggerEvaluate() {
  const btn = document.getElementById('btn-evaluate');
  btn.disabled = true;
  btn.innerHTML = '<span>⏳</span> Evaluating...';

  try {
    await fetch('/api/trigger-evaluate', { method: 'POST' });
    setTimeout(() => {
      loadStats();
      loadJobs();
      btn.disabled = false;
      btn.innerHTML = '<span>🤖</span> Evaluate';
    }, 5000);
  } catch {
    btn.disabled = false;
    btn.innerHTML = '<span>🤖</span> Evaluate';
  }
}

async function markApplied(id) {
  try {
    await fetch(`/api/jobs/${id}/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    closeModal();
    loadStats();
    loadJobs();
  } catch (e) { console.error(e); }
}

async function updateStatus(id, status) {
  try {
    await fetch(`/api/jobs/${id}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
    closeModal();
    loadJobs();
  } catch (e) { console.error(e); }
}

async function generatePDF(id) {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = '⏳ Generating...';

  try {
    const res = await fetch(`/api/jobs/${id}/generate-pdf`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      btn.textContent = '✅ Generated!';
      if (data.path) {
        const link = document.createElement('a');
        link.href = `/output/${data.filename}`;
        link.download = data.filename;
        link.click();
      }
    } else {
      btn.textContent = '❌ Failed';
    }
  } catch {
    btn.textContent = '❌ Error';
  }

  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = '📄 Generate PDF';
  }, 3000);
}

// ============================================
// HELPERS
// ============================================
function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function getGradeColor(grade) {
  return { A: '#00d2a0', B: '#4da6ff', C: '#ffd93d', D: '#ff9f43', F: '#ff5252' }[grade] || '#666';
}

function archetypeIcon(type) {
  const icons = { Devops: '🔧', Cloud: '☁️', Data: '📊', Ai: '🤖', Fullstack: '💻', Other: '📋' };
  return icons[type] || icons[(type || '').charAt(0).toUpperCase() + (type || '').slice(1).toLowerCase()] || '📋';
}

function platformIcon(platform) {
  const icons = { arbeitnow: '🇪🇺', remoteok: '🌍', jsearch: '🔎', greenhouse: '🌿', lever: '🔷', ashby: '🟣', linkedin: '💼', indeed: '🔍', stepstone: '🪜', glassdoor: '🏢', xing: '🇩🇪' };
  return icons[(platform || '').toLowerCase()] || '🌐';
}

function actionIcon(action) {
  return { Apply: '🚀', Review: '👋', Skip: '🗄️' }[(action || '')] || '📋';
}

async function triggerApply() {
  const btn = document.getElementById('btn-apply');
  btn.disabled = true;
  btn.innerHTML = '<span>⏳</span> Applying...';

  try {
    await fetch('/api/trigger-apply', { method: 'POST' });
    setTimeout(() => {
      loadStats();
      loadJobs();
      btn.disabled = false;
      btn.innerHTML = '<span>🚀</span> Auto-Apply';
    }, 10000);
  } catch {
    btn.disabled = false;
    btn.innerHTML = '<span>🚀</span> Auto-Apply';
  }
}

function buildCrossLinks(job) {
  const title = encodeURIComponent(job.title || '');
  const company = encodeURIComponent(job.company || '');
  const location = encodeURIComponent(job.location || 'Europe');
  const query = encodeURIComponent(`${job.title} ${job.company}`);
  return [
    { name: 'LinkedIn', icon: '💼', url: `https://www.linkedin.com/jobs/search/?keywords=${title}+${company}&location=${location}` },
    { name: 'Indeed', icon: '🔍', url: `https://www.indeed.com/jobs?q=${title}+${company}&l=${location}` },
    { name: 'Glassdoor', icon: '🏢', url: `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${query}` },
    { name: 'Xing', icon: '🇩🇪', url: `https://www.xing.com/jobs/search?keywords=${title}&location=${location}` },
    { name: 'StepStone', icon: '🪜', url: `https://www.stepstone.de/jobs/${(job.title || '').replace(/\s+/g, '-').toLowerCase()}` },
  ];
}

// ============================================
// TAB SWITCHING
// ============================================
let activeTab = 'jobs';

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');

  // Show job grid + filters for all tabs
  document.getElementById('job-grid').style.display = '';
  document.getElementById('filter-bar').style.display = '';

  // Show applied detail table only on applied tab
  document.getElementById('applied-section').style.display = tab === 'applied' ? '' : 'none';
  document.getElementById('queue-section').style.display = 'none';

  if (tab === 'applied') {
    const applied = allJobs.filter(j => j.status === 'applied');
    renderJobs(applied);
    loadApplied();
  } else if (tab === 'queue') {
    const queued = allJobs.filter(j =>
      j.status === 'auto_queue' || j.status === 'manual_queue' ||
      (j.action === 'Apply' && j.status !== 'applied')
    );
    renderJobs(queued);
  } else if (tab === 'review') {
    const review = allJobs.filter(j =>
      j.action === 'Review' || j.status === 'manual_queue'
    );
    renderJobs(review);
  } else if (tab === 'skip') {
    const skip = allJobs.filter(j =>
      j.action === 'Skip' || j.status === 'archived' || j.letter_grade === 'F'
    );
    renderJobs(skip);
  } else {
    filterJobs();
  }
}

// ============================================
// LOAD APPLIED JOBS
// ============================================
async function loadApplied() {
  try {
    const res = await fetch('/api/applications');
    const apps = await res.json();
    const tbody = document.getElementById('applied-tbody');
    const empty = document.getElementById('applied-empty');
    const count = document.getElementById('applied-count');

    count.textContent = apps.length + ' applications';

    if (apps.length === 0) {
      tbody.innerHTML = '';
      empty.style.display = '';
      return;
    }
    empty.style.display = 'none';

    tbody.innerHTML = apps.map(a => {
      const date = new Date(a.applied_at);
      const timeAgo = getTimeAgo(date);
      const dateStr = date.toLocaleDateString('en-GB', {day:'2-digit',month:'short',year:'numeric'});
      const methodColors = { auto: '#00d2a0', manual: '#4da6ff' };
      const methodBg = methodColors[a.method] || '#666';

      return `
        <tr>
          <td title="${dateStr}">
            <div style="font-weight:500;font-size:12px;">${dateStr}</div>
            <div style="font-size:11px;color:var(--text-muted);">${timeAgo}</div>
          </td>
          <td><strong>${esc(a.company || 'N/A')}</strong></td>
          <td>${esc(a.title || 'N/A')}</td>
          <td>📍 ${esc(a.location || 'N/A')}</td>
          <td>${platformIcon(a.platform)} ${esc(a.platform || 'N/A')}</td>
          <td><span style="background:${methodBg};color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;">${(a.method || 'manual').toUpperCase()}</span></td>
          <td><span class="grade-badge grade-${a.letter_grade}" style="font-size:12px;width:28px;height:28px;">${a.letter_grade || '?'}</span></td>
          <td style="font-weight:600;">${a.weighted_score ? a.weighted_score.toFixed(1) : '?'}/5</td>
          <td>
            <a href="/api/resume" target="_blank" style="color:#4da6ff;text-decoration:none;font-size:12px;" title="View resume used">📄 ${a.pdf_path && !a.pdf_path.startsWith('http') ? a.pdf_path.split('/').pop() : 'resume.pdf'}</a>
            <br>
            <a href="${a.status === 'failed' && a.pdf_path && a.pdf_path.startsWith('http') ? a.pdf_path : `https://swscpdtchfjyzpjhwqqj.supabase.co/storage/v1/object/public/screenshots/${a.app_id}.jpeg`}" target="_blank" style="color:#ffd93d;text-decoration:none;font-size:11px;font-weight:500;" title="View Submission Proof">📸 View Proof</a>
          </td>
          <td style="font-size:11px;color:var(--text-muted);">Base Resume (No modifications)</td>
          <td>${a.apply_link ? '<a href="' + a.apply_link + '" target="_blank" style="color:#00d2a0;text-decoration:none;">🔗 View Job</a>' : '—'}</td>
        </tr>
      `;
    }).join('');
  } catch (e) {
    console.error('Failed to load applications:', e);
  }
}

function getTimeAgo(date) {
  const now = new Date();
  const diffMs = now - date;
  const mins = Math.floor(diffMs / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days/7)}w ago`;
}

// ============================================
// LOAD AUTO-QUEUE
// ============================================
async function loadQueue() {
  try {
    const res = await fetch('/api/jobs?grade=B&limit=50');
    const jobs = await res.json();
    const queued = jobs.filter(j => j.status === 'auto_queue' || (j.letter_grade && ['A','B'].includes(j.letter_grade)));
    const tbody = document.getElementById('queue-tbody');
    const count = document.getElementById('queue-count');

    count.textContent = queued.length + ' queued';

    tbody.innerHTML = queued.map(j => {
      const skills = (j.matching_skills || []).slice(0, 4).join(', ');
      return `
        <tr>
          <td><strong>${j.company || 'N/A'}</strong></td>
          <td>${j.title || 'N/A'}</td>
          <td>${j.location || 'N/A'}</td>
          <td>${j.platform || 'N/A'}</td>
          <td><span class="grade-badge grade-${j.letter_grade}">${j.letter_grade || '?'}</span></td>
          <td>${j.weighted_score ? j.weighted_score.toFixed(1) : '?'}/5</td>
          <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${skills}">${skills || '—'}</td>
          <td>${j.apply_link ? '<a href="' + j.apply_link + '" target="_blank">🔗 Apply</a>' : '—'}</td>
        </tr>
      `;
    }).join('');
  } catch (e) {
    console.error('Failed to load queue:', e);
  }
}
