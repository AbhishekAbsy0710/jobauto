#!/usr/bin/env python3
"""
Gmail OTP Watcher — Auto-detects security codes from job application emails
and writes them to security_code.txt for the browser-apply.js pipeline.

Usage:
  python3 src/scripts/gmail-otp-watcher.py          # run watcher
  python3 src/scripts/gmail-otp-watcher.py --setup  # first-time OAuth setup
"""

import os
import sys
import re
import time
import json
import base64
import argparse
from datetime import datetime, timezone
from pathlib import Path

# ── deps ────────────────────────────────────────────────────────────────────
try:
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request
    from google_auth_oauthlib.flow import InstalledAppFlow
    from googleapiclient.discovery import build
except ImportError:
    print("❌ Missing deps. Run: pip3 install google-auth google-auth-oauthlib google-api-python-client")
    sys.exit(1)

# ── config ──────────────────────────────────────────────────────────────────
SCRIPT_DIR    = Path(__file__).parent.parent.parent  # jobauto root
CREDS_FILE    = SCRIPT_DIR / "gmail_credentials.json"
TOKEN_FILE    = SCRIPT_DIR / "gmail_token.json"
SIGNAL_FILE   = SCRIPT_DIR / "WAITING_FOR_SECURITY_CODE.txt"
OUTPUT_FILE   = SCRIPT_DIR / "security_code.txt"
SCOPES        = ["https://www.googleapis.com/auth/gmail.readonly"]
POLL_INTERVAL = 5   # seconds between Gmail checks when actively waiting
IDLE_INTERVAL = 30  # seconds between checks when not waiting

# Senders that deliver OTP codes
OTP_SENDERS = [
    "greenhouse.io",
    "greenhouse-mail.io",
    "noreply@greenhouse.io",
    "no-reply@greenhouse.io",
    "no-reply@us.greenhouse-mail.io",
    "anthropic.com",
    "contentful.com",
    "celonis.com",
    "lever.co",
    "ashbyhq.com",
    "myworkday",
    "workday.com",
    "smartrecruiters",
    "datadog.com",
    "datadoghq.com",
    "sumup.com",
    "spotify.com",
    "supabase.io",
    "supabase.com",
    "adyen.com",
    "gitlab.com",
    "careers@",
    "recruiting@",
    "noreply@",
    "no-reply@",
    "talent@",
    "jobs@",
]

# Regex to find 6-8 char alphanumeric codes (the format Greenhouse uses)
CODE_PATTERNS = [
    r'\b([A-Z0-9]{6,8})\b',          # uppercase alphanumeric  e.g. QQ29U5YH
    r'\b([a-zA-Z0-9]{6,8})\b',       # mixed case              e.g. dpymISnh
    r'code[:\s]+([A-Za-z0-9]{4,10})', # "code: XXXXXX"
    r'verification[:\s]+([A-Za-z0-9]{4,10})',
    r'security[:\s]+([A-Za-z0-9]{4,10})',
    r'\b(\d{6})\b',                   # 6-digit numeric
]

# Words that should appear near the code to confirm it's an OTP email
TRIGGER_PHRASES = [
    "security code", "verification code", "confirm your email",
    "verify your email", "one-time", "otp", "sign in code",
    "your code is", "enter this code", "access code",
    "application", "job application", "authenticate",
]


def authenticate():
    """OAuth2 flow — opens browser on first run, uses cached token after."""
    creds = None
    if TOKEN_FILE.exists():
        creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            print("🔄 Refreshing Gmail token...")
            creds.refresh(Request())
        else:
            if not CREDS_FILE.exists():
                print(f"""
❌ No credentials file found at: {CREDS_FILE}

To set up Gmail access:
1. Go to https://console.cloud.google.com/
2. Create a project → Enable Gmail API
3. OAuth consent screen → External → Add your Gmail as test user
4. Credentials → Create OAuth Client ID → Desktop App
5. Download JSON → save as: {CREDS_FILE}
6. Run: python3 {__file__} --setup
""")
                sys.exit(1)

            flow = InstalledAppFlow.from_client_secrets_file(CREDS_FILE, SCOPES)
            creds = flow.run_local_server(port=0, open_browser=True)

        TOKEN_FILE.write_text(creds.to_json())
        print(f"✅ Token saved to {TOKEN_FILE}")

    return build("gmail", "v1", credentials=creds)


def get_email_body(msg_payload):
    """Recursively extract plain text body from Gmail message payload."""
    body = ""
    if "parts" in msg_payload:
        for part in msg_payload["parts"]:
            body += get_email_body(part)
    elif msg_payload.get("mimeType") == "text/plain":
        data = msg_payload.get("body", {}).get("data", "")
        if data:
            body = base64.urlsafe_b64decode(data + "==").decode("utf-8", errors="ignore")
    elif msg_payload.get("mimeType") == "text/html":
        data = msg_payload.get("body", {}).get("data", "")
        if data:
            html = base64.urlsafe_b64decode(data + "==").decode("utf-8", errors="ignore")
            # Strip HTML tags for plain text
            body = re.sub(r'<[^>]+>', ' ', html)
    return body


def extract_otp_from_email(service, msg_id):
    """Fetch a Gmail message and try to extract an OTP code from it."""
    try:
        msg = service.users().messages().get(
            userId="me", id=msg_id, format="full"
        ).execute()
    except Exception as e:
        print(f"  ⚠️  Failed to fetch message {msg_id}: {e}")
        return None

    headers = {h["name"].lower(): h["value"] for h in msg["payload"].get("headers", [])}
    sender  = headers.get("from", "").lower()
    subject = headers.get("subject", "")

    # Only process from known OTP senders OR if subject has clear OTP signals
    subject_lc = subject.lower()
    from_known = any(s.split('@')[-1] in sender for s in OTP_SENDERS if '@' in s) or \
                 any(s in sender for s in OTP_SENDERS if '@' not in s)
    subject_is_otp = any(p in subject_lc for p in ["security code","verification code","verify","confirm","access code","one-time","otp"])
    if not from_known and not subject_is_otp:
        return None

    body = get_email_body(msg["payload"])
    combined = (subject + " " + body).lower()

    # Must mention a trigger phrase to be considered OTP email
    is_otp_email = any(phrase in combined for phrase in TRIGGER_PHRASES)
    if not is_otp_email:
        return None

    print(f"  📧 OTP email detected from: {headers.get('from','?')}", flush=True)
    print(f"  📋 Subject: {subject}", flush=True)

    # Common words to skip (these match 6-8 char alphanumeric but aren't codes)
    SKIP_WORDS = {
        "security", "confirm", "verify", "access", "submit", "please",
        "company", "address", "account", "privacy", "consent", "process",
        "general", "service", "support", "contact", "welcome", "applied",
        "application", "resubmit", "greenhouse", "abhishek", "street",
        "pagadala", "display", "entered", "provide", "collect",
    }

    # Strategy 1: Find code near contextual phrases (most reliable)
    # Greenhouse format: "Copy and paste this code into the security code field on your application: CODE_HERE"
    context_patterns = [
        r'application[:\s]+([a-zA-Z0-9]{6,10})\s',
        r'code[^a-zA-Z0-9]{0,50}?:\s*([a-zA-Z0-9]{6,10})',
        r'(?:paste|enter|type)\s+(?:this\s+)?(?:code|the\s+code)[^:]*:\s*([a-zA-Z0-9]{6,10})',
    ]
    for cp in context_patterns:
        m = re.search(cp, body, re.IGNORECASE)
        if m:
            code = m.group(1).strip()
            if code.lower() not in SKIP_WORDS:
                print(f"  🔑 Extracted code (context): {code}", flush=True)
                return code

    # Strategy 2: Find isolated 8-char token that's NOT a common word
    # Greenhouse codes are exactly 8 chars, mixed case with uppercase
    for text_source in [body, subject]:
        if not text_source:
            continue
        for m in re.findall(r'\b([a-zA-Z0-9]{8})\b', text_source):
            if m.lower() in SKIP_WORDS:
                continue
            # Must have at least one uppercase letter (codes like zGsobPvQ, IFNiCrF3)
            if any(c.isupper() for c in m) and not m.isupper():
                print(f"  🔑 Extracted code (8-char): {m}", flush=True)
                return m

    # Strategy 3: Fallback to generic patterns
    for text_source in [body, subject]:
        if not text_source:
            continue
        for pattern in CODE_PATTERNS:
            matches = re.findall(pattern, text_source, re.IGNORECASE)
            for m in matches:
                m = m.strip()
                if len(m) < 6:
                    continue
                if m.lower() in SKIP_WORDS:
                    continue
                if m.isdigit() and int(m) in range(2020, 2030):
                    continue
                # At least has mixed case or mixed alpha-num
                has_upper = any(c.isupper() for c in m)
                has_lower = any(c.islower() for c in m)
                has_digit = any(c.isdigit() for c in m)
                if (has_upper and has_lower) or has_digit:
                    print(f"  🔑 Extracted code (fallback): {m}", flush=True)
                    return m

    print("  ⚠️  Could not extract code from email body", flush=True)
    return None


def check_for_otp(service, since_timestamp):
    """Search Gmail for recent OTP emails since a given timestamp."""
    # Broad subject-based search — catches all ATS platforms regardless of sender.
    # Sender validation still happens in extract_otp_from_email() as a safety gate.
    query = (
        "(subject:\"security code\" OR subject:\"verification code\" OR "
        "subject:\"verify your email\" OR subject:\"confirm your email\" OR "
        "subject:\"your code\" OR subject:\"access code\" OR subject:\"one-time\") "
        "newer_than:1h"
    )

    try:
        result = service.users().messages().list(
            userId="me", q=query, maxResults=10
        ).execute()
    except Exception as e:
        print(f"  ⚠️  Gmail search error: {e}")
        return None

    messages = result.get("messages", [])
    if not messages:
        return None

    for msg_ref in messages:
        # Get message internal date to filter by since_timestamp
        try:
            meta = service.users().messages().get(
                userId="me", id=msg_ref["id"], format="metadata",
                metadataHeaders=["From", "Subject", "Date"]
            ).execute()
            internal_date = int(meta.get("internalDate", 0)) / 1000  # ms → s
            if internal_date < since_timestamp:
                continue  # Older than when we started waiting
        except Exception:
            pass

        code = extract_otp_from_email(service, msg_ref["id"])
        if code:
            return code

    return None


def watch(service):
    """Main loop — watches for WAITING_FOR_SECURITY_CODE.txt and auto-fills codes."""
    print("👁️  Gmail OTP Watcher started")
    print(f"   Watching: {SIGNAL_FILE.name}")
    print(f"   Writing to: {OUTPUT_FILE.name}")
    print(f"   Press Ctrl+C to stop\n")

    wait_start = None

    while True:
        try:
            if SIGNAL_FILE.exists():
                # Pipeline is waiting for a code
                if wait_start is None:
                    wait_start = time.time()
                    signal_content = SIGNAL_FILE.read_text().strip()
                    print(f"\n🔔 [{datetime.now().strftime('%H:%M:%S')}] Pipeline waiting for code!", flush=True)
                    print(f"   {signal_content}", flush=True)
                    print(f"   Scanning Gmail every {POLL_INTERVAL}s...")

                # Check Gmail for new OTP
                code = check_for_otp(service, since_timestamp=wait_start - 1800)
                if code:
                    OUTPUT_FILE.write_text(code)
                    print(f"\n✅ [{datetime.now().strftime('%H:%M:%S')}] Code written: {code}", flush=True)
                    print(f"   Pipeline will pick it up automatically")
                    wait_start = None  # Reset for next job
                    time.sleep(5)  # Brief pause before next check
                else:
                    elapsed = int(time.time() - wait_start)
                    print(f"   [{datetime.now().strftime('%H:%M:%S')}] No code found yet ({elapsed}s elapsed)...", flush=True)
                    time.sleep(POLL_INTERVAL)

            else:
                # Not waiting — check less frequently
                if wait_start is not None:
                    print(f"✅ Signal file gone — code was handled")
                    wait_start = None
                time.sleep(IDLE_INTERVAL)

        except KeyboardInterrupt:
            print("\n\n👋 Watcher stopped")
            break
        except Exception as e:
            print(f"⚠️  Watcher error: {e}")
            time.sleep(10)


def main():
    parser = argparse.ArgumentParser(description="Gmail OTP Watcher for JobAuto pipeline")
    parser.add_argument("--setup", action="store_true", help="Run OAuth setup only")
    args = parser.parse_args()

    print("🔐 Authenticating with Gmail...")
    service = authenticate()
    print("✅ Gmail connected\n")

    if args.setup:
        print("✅ Setup complete! Run without --setup to start watching.")
        return

    watch(service)


if __name__ == "__main__":
    main()
