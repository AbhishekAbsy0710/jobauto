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

        // Step 3: API/n8n auto-apply handled within evaluateNewJobs if mode=auto
        // (Queue processor runs independently in other scripts if needed)
        console.log('  ✅ Pipeline complete!');
      } catch (error) {
        console.error('❌ [CRON] Pipeline failed:', error.message);
      }
    });

    // ============================================
    // APPLY-ONLY: Removed (now handled by n8n webhook routing)
    // ============================================

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

