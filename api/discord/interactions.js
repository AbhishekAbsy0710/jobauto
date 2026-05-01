import nacl from 'tweetnacl';
import { createClient } from '@supabase/supabase-js';

// Vercel config: disable body parser to get raw text for signature verification
export const config = {
  api: { bodyParser: false },
};

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function verifySignature(signature, timestamp, rawBody, publicKey) {
  if (!signature || !timestamp || !publicKey) return false;
  try {
    return nacl.sign.detached.verify(
      Buffer.from(timestamp + rawBody),
      Buffer.from(signature, 'hex'),
      Buffer.from(publicKey, 'hex')
    );
  } catch (e) {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);
  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];
  const publicKey = process.env.DISCORD_PUBLIC_KEY;

  if (!verifySignature(signature, timestamp, rawBody, publicKey)) {
    return res.status(401).json({ error: 'invalid request signature' });
  }

  const payload = JSON.parse(rawBody);

  // Handle PING from Discord
  if (payload.type === 1) {
    return res.json({ type: 1 });
  }

  // Handle Button Clicks
  if (payload.type === 3) {
    const customId = payload.data.custom_id;
    const [action, jobIdStr] = customId.split('_');
    const jobId = parseInt(jobIdStr, 10);

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    if (action === 'approve') {
      await sb.from('jobs').update({ status: 'auto_queue' }).eq('id', jobId);
      return res.json({
        type: 7, // UPDATE_MESSAGE
        data: {
          content: '✅ **Approved for Auto-Apply.** It will be applied in the next cycle.',
          components: [], // Remove buttons
        }
      });
    }

    if (action === 'reject') {
      await sb.from('jobs').update({ status: 'archived' }).eq('id', jobId);
      return res.json({
        type: 7, // UPDATE_MESSAGE
        data: {
          content: '❌ **Rejected.** The job has been archived.',
          components: [], // Remove buttons
        }
      });
    }
  }

  return res.status(400).json({ error: 'unknown interaction' });
}
