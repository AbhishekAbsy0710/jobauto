/**
 * Free Hiring Manager Email Finder
 * Strategy: Email pattern permutation + SMTP MX verification (100% free, no API key needed)
 * 
 * How it works:
 * 1. Generate likely email patterns for the company domain (firstname@, first.last@, etc.)
 * 2. Verify which pattern exists using DNS MX lookup + SMTP RCPT TO handshake
 * 3. Return the first verified address
 */
import dns from 'dns/promises';
import net from 'net';

/**
 * Extract the company domain from a company name.
 * e.g. "Acme Corp GmbH" -> tries common TLDs
 */
function guessCompanyDomain(companyName) {
  const cleaned = companyName
    .toLowerCase()
    .replace(/\b(gmbh|ag|inc|ltd|llc|corp|se|ug|kg|co|the|group|studio|labs|technologies|tech|solutions|consulting|services|digital|gmbh & co|& co)\b/gi, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .join('');
  
  return cleaned;
}

/**
 * Generate plausible email patterns for a person at a company domain
 */
function generateEmailPatterns(firstName, lastName, domain) {
  const f = firstName.toLowerCase().replace(/[^a-z]/g, '');
  const l = lastName.toLowerCase().replace(/[^a-z]/g, '');
  const fi = f.charAt(0);
  const li = l.charAt(0);
  
  return [
    `${f}@${domain}`,
    `${f}.${l}@${domain}`,
    `${fi}${l}@${domain}`,
    `${fi}.${l}@${domain}`,
    `${f}${l}@${domain}`,
    `${f}${li}@${domain}`,
    `hiring@${domain}`,
    `hr@${domain}`,
    `talent@${domain}`,
    `jobs@${domain}`,
    `careers@${domain}`,
    `recruit@${domain}`,
    `hello@${domain}`,
    `team@${domain}`,
  ];
}

/**
 * Get MX records for a domain
 */
async function getMxRecords(domain) {
  try {
    const records = await dns.resolveMx(domain);
    return records.sort((a, b) => a.priority - b.priority).map(r => r.exchange);
  } catch {
    return [];
  }
}

/**
 * Verify an email address exists using SMTP handshake (without sending any email).
 * Returns true if the mail server accepts RCPT TO for the address.
 */
async function smtpVerify(email, mxHost, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const [localPart, domain] = email.split('@');
    let resolved = false;
    
    const sock = net.createConnection(25, mxHost);
    sock.setTimeout(timeoutMs);
    
    const done = (result) => {
      if (!resolved) {
        resolved = true;
        sock.destroy();
        resolve(result);
      }
    };
    
    let buffer = '';
    let step = 0;
    
    sock.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\r\n');
      buffer = lines.pop();
      
      for (const line of lines) {
        const code = parseInt(line.substring(0, 3));
        
        if (step === 0 && code === 220) {
          // Server ready, send EHLO
          sock.write(`EHLO verify.jobauto.local\r\n`);
          step = 1;
        } else if (step === 1 && (code === 250 || code === 220)) {
          if (line.startsWith('250 ') || line.startsWith('250-') === false) {
            // EHLO accepted, send MAIL FROM
            sock.write(`MAIL FROM:<verify@jobauto.local>\r\n`);
            step = 2;
          }
        } else if (step === 2 && code === 250) {
          // MAIL FROM accepted, send RCPT TO
          sock.write(`RCPT TO:<${email}>\r\n`);
          step = 3;
        } else if (step === 3) {
          // 250/251 = valid, 550/551/553 = invalid
          const valid = code === 250 || code === 251;
          sock.write('QUIT\r\n');
          done(valid);
        }
      }
    });
    
    sock.on('error', () => done(false));
    sock.on('timeout', () => done(false));
    sock.on('close', () => done(false));
  });
}

/**
 * Try to find a working email for a company.
 * Falls back to guessing patterns if no person name is available.
 */
export async function findHiringManagerEmail(companyName, firstName = null, lastName = null) {
  const domainBase = guessCompanyDomain(companyName);
  
  // Try .com, .de, .io, .co common TLDs
  const tlds = ['com', 'de', 'io', 'co', 'eu', 'net', 'org'];
  
  for (const tld of tlds) {
    const domain = `${domainBase}.${tld}`;
    
    // Check if domain has MX records (i.e., it's a real company domain)
    const mxHosts = await getMxRecords(domain);
    if (mxHosts.length === 0) continue;
    
    console.log(`  🔍 Found MX for ${domain}, checking email patterns...`);
    const mxHost = mxHosts[0];
    
    const patterns = firstName && lastName
      ? generateEmailPatterns(firstName, lastName, domain)
      : generateEmailPatterns('hiring', 'manager', domain).slice(6); // just generic patterns
    
    for (const email of patterns) {
      try {
        const valid = await smtpVerify(email, mxHost, 4000);
        if (valid) {
          console.log(`  ✅ Verified email: ${email}`);
          return email;
        }
      } catch {
        // continue
      }
    }
    
    // If SMTP verification fails (many servers block this), return the best guess
    // hiring@ is the most commonly correct generic address
    const fallback = `hiring@${domain}`;
    console.log(`  ⚠️ SMTP verify blocked — using best-guess: ${fallback}`);
    return fallback;
  }
  
  // Absolute fallback
  const fallback = `hiring@${domainBase}.com`;
  console.log(`  ⚠️ No domain found — falling back to: ${fallback}`);
  return fallback;
}
