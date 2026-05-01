// Vercel API Route: /api/resume
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // In Vercel, files are bundled at build time — resume is in the repo
  const resumePath = join(process.cwd(), 'resume', 'resume.pdf');

  if (existsSync(resumePath)) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Abhishek_Raj_Pagadala_Resume.pdf"');
    return res.send(readFileSync(resumePath));
  }

  res.status(404).json({ error: 'Resume not found' });
}
