// Vercel API Route: /api/health
export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({
    status: 'ok',
    version: 'v3.0.0',
    provider: 'vercel',
    llm: process.env.GROQ_API_KEY ? 'groq' : 'none',
    db: process.env.SUPABASE_URL ? 'supabase' : 'none',
    uptime: process.uptime(),
  });
}
