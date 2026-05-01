export function startScheduler() {
  console.log('⏰ Starting job scheduler...');

  import('node-cron').then(({ default: cron }) => {

    // ============================================
    // FULL PIPELINE: Every 6 hours
    // Scrape → Evaluate → Browser Apply → Discord
    // ============================================
    cron.schedule('0 */6 * * *', async () => {
      console.log('\n⏰ [CRON] Running full pipeline...');
      try {
        // Step 1: Scrape all platforms
        console.log('  📡 Step 1: Scraping...');
        const { runAllScrapers } = await import('./scrapers/index.js');
        await runAllScrapers();

        // Step 2: Evaluate new jobs
        console.log('  🤖 Step 2: Evaluating...');
        const { evaluateNewJobs } = await import('./services/actionRouter.js');
        await evaluateNewJobs(30);

        // Step 3: Browser auto-apply to queued Grade A/B jobs
        console.log('  🚀 Step 3: Auto-applying...');
        await runBrowserApply();

        console.log('  ✅ Pipeline complete!');
      } catch (error) {
        console.error('❌ [CRON] Pipeline failed:', error.message);
      }
    });

    // ============================================
    // APPLY-ONLY: Every 2 hours (picks up any new queue items)
    // ============================================
    cron.schedule('30 */2 * * *', async () => {
      console.log('\n⏰ [CRON] Running apply cycle...');
      try {
        await runBrowserApply();
      } catch (error) {
        console.error('❌ [CRON] Apply failed:', error.message);
      }
    });

    // ============================================
    // DAILY SUMMARY: 20:00
    // ============================================
    cron.schedule('0 20 * * *', async () => {
      console.log('\n📊 [CRON] Sending daily summary...');
      try {
        const { getStats } = await import('./database.js');
        const { loadConfig } = await import('./config.js');
        const stats = getStats();
        const cfg = loadConfig();
        if (cfg.discordWebhookUrl) {
          const Database = (await import('better-sqlite3')).default;
          const db = new Database('./db/jobauto.db');
          const apps = db.prepare(`
            SELECT j.title, j.company, j.location, a.applied_at
            FROM applications a JOIN evaluations e ON e.id = a.evaluation_id JOIN jobs j ON j.id = e.job_id
            ORDER BY a.applied_at DESC LIMIT 10
          `).all();
          db.close();

          await fetch(cfg.discordWebhookUrl, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'JobAuto', embeds: [{
              title: '📊 Daily Summary',
              description: `**${stats.evaluated}/${stats.total_jobs}** evaluated · **${stats.applied}** applied\n\n` +
                (apps.length ? '**Recent Applications:**\n' + apps.map((a, i) => `${i+1}. **${a.title}** @ ${a.company} · ${a.location}`).join('\n') : 'No applications yet'),
              color: 0x4da6ff,
              timestamp: new Date().toISOString(),
              footer: { text: 'JobAuto v2.1 · Automated Pipeline' }
            }]})
          });
        }
      } catch (error) {
        console.error('❌ [CRON] Summary failed:', error.message);
      }
    });

    console.log('  📅 Full Pipeline: Every 6 hours');
    console.log('  🚀 Apply Cycle:   Every 2 hours');
    console.log('  📊 Daily Summary: 20:00');
  }).catch(e => console.error('Scheduler init failed:', e.message));
}

// ============================================
// BROWSER AUTO-APPLY (Playwright)
// ============================================
async function runBrowserApply() {
  try {
    const { execSync } = await import('child_process');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const scriptPath = path.join(__dirname, 'scripts', 'browser-apply.js');

    console.log('  🌐 Launching Playwright auto-apply...');
    execSync(`PLAYWRIGHT_BROWSERS_PATH=0 node ${scriptPath}`, {
      cwd: path.join(__dirname, '..'),
      timeout: 600000, // 10 min max
      stdio: 'inherit',
    });
  } catch (e) {
    console.error('  ⚠️ Browser apply error:', e.message?.slice(0, 200));
  }
}
