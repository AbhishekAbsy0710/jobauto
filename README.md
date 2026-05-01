# JobAuto v2 — Career-Ops Enhanced

> 🎯 AI-powered job matching with A–F scoring, tailored PDF resumes, and portal scanning — **$0/month**.

## Quick Start

```bash
npm install
npx playwright install chromium   # For PDF generation

# Start Ollama
ollama pull llama3.1:8b && ollama serve

# Configure your profile
cp config/profile.example.yml config/profile.yml
# Edit config/profile.yml with your details

# Start
npm run dev
open http://localhost:3000
```

## Features

- **A–F Scoring** — 10 weighted dimensions (Technical Fit, Seniority, Domain, Growth, etc.)
- **Tailored PDF Resumes** — ATS-optimized, auto-generated per job
- **Portal Scanner** — Scans Greenhouse, Lever, Ashby career pages
- **3 Free Job APIs** — Arbeitnow (EU), RemoteOK, JSearch
- **Batch Processing** — Evaluate multiple jobs in parallel
- **Archetype Detection** — Auto-classifies as DevOps/Cloud/Data/AI/FullStack
- **Telegram Notifications** — Real-time alerts for high-grade matches
- **Premium Dashboard** — Dark glassmorphism UI with filters and detail modals

## CLI Commands

| Command | Description |
|---------|-------------|
| `npm start` | Start server + scheduler |
| `npm run dev` | Start with auto-reload |
| `npm run scrape` | Manual scrape now |
| `npm run evaluate` | Manual AI evaluation |
| `npm run pdf` | Generate PDF for a job |
| `npm run setup-db` | Initialize database |

## Architecture

```
Free APIs + Portal Scanner → AI Evaluation (Ollama) → A-F Scoring → Dashboard + Telegram
(Arbeitnow, RemoteOK,       (10 dimensions,          (Rule-based     (Filter, review,
 JSearch, Greenhouse,         archetype detection,      thresholds,      PDF generation,
 Lever, Ashby)                STAR stories)             risk override)   apply tracking)
```

## Docker

```bash
docker compose up -d
docker exec jobauto-ollama ollama pull llama3.1:8b
# Dashboard: http://localhost:3000
# n8n: http://localhost:5678 (admin / jobauto2026)
```

## Cost: $0/month

All free: Ollama, Arbeitnow, RemoteOK, JSearch free tier, Playwright, SQLite, Telegram.
