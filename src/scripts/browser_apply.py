#!/usr/bin/env python3
"""
JobAuto Python Browser Applier
Uses Python Playwright (bypasses Node.js playwright-core initialization hang on macOS Sequoia)
"""

import os
import sys
import json
import time
import random
import re
import urllib.request
import urllib.parse
import urllib.error
from pathlib import Path
from datetime import datetime, timedelta

# Setup paths
SCRIPT_DIR = Path(__file__).parent
ROOT = SCRIPT_DIR.parent.parent
RESUME_PATH = ROOT / "resume" / "resume.pdf"
PROGRESS_LOG = Path("/tmp/apply-progress.txt")

# ── Load .env ────────────────────────────────────────────────────────────────
def load_env():
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                k = k.strip()
                v = v.strip()
                if k:
                    os.environ[k] = v  # Always set (override IDE/shell env)

load_env()

PROFILE = {
    "firstName": "Abhishek Raj",
    "lastName": "Pagadala",
    "fullName": "Abhishek Raj Pagadala",
    "email": os.environ.get("APPLICANT_EMAIL", "pagadalaabhishek60@gmail.com"),
    "phone": os.environ.get("APPLICANT_PHONE", "+49 176 6723 9250"),
    "linkedin": "https://www.linkedin.com/in/abhishek-raj-pagadala",
    "github": "https://github.com/AbhishekAbsy0710",
    "city": "Berlin",
    "country": "Germany",
}

DISCORD_WEBHOOK = os.environ.get("DISCORD_WEBHOOK_URL", "")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

# Chromium executable from Node playwright's installation (known to work)
CHROMIUM_HEADLESS = os.path.expanduser(
    "~/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell"
)
CHROMIUM_FULL = os.path.expanduser(
    "~/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
)

# ── Logging ──────────────────────────────────────────────────────────────────
def log(msg):
    ts = datetime.now().strftime("%H:%M:%S")
    out = f"[{ts}] {msg}"
    print(out, flush=True)
    try:
        with open(PROGRESS_LOG, "a") as f:
            f.write(out + "\n")
    except Exception:
        pass

# ── HTTP helpers ─────────────────────────────────────────────────────────────
def http_post(url, data, headers=None):
    """Simple HTTP POST with JSON body."""
    body = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "JobAuto/1.0 (Python Applier)")
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            content = resp.read()
            if not content:
                return {}
            return json.loads(content.decode("utf-8"))
    except Exception as e:
        raise RuntimeError(f"HTTP POST error: {e}")

def upload_screenshot(filepath, filename):
    """Upload screenshot to Supabase Storage. Returns public URL or None."""
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        return None
    try:
        with open(filepath, 'rb') as f:
            data = f.read()

        url = f"{SUPABASE_URL}/storage/v1/object/screenshots/{filename}"
        req = urllib.request.Request(url, data=data, method="POST")
        req.add_header("apikey", SUPABASE_SERVICE_KEY)
        req.add_header("Authorization", f"Bearer {SUPABASE_SERVICE_KEY}")
        req.add_header("Content-Type", "image/jpeg")
        req.add_header("x-upsert", "true")

        resp = urllib.request.urlopen(req, timeout=30)
        if resp.status in (200, 201):
            public_url = f"{SUPABASE_URL}/storage/v1/object/public/screenshots/{filename}"
            return public_url
        else:
            log(f"  ⚠️ Screenshot upload status: {resp.status}")
            return None
    except Exception as e:
        log(f"  ⚠️ Error uploading screenshot: {e}")
        return None

def supabase_query(table, select="*", filters=None, order=None, limit=None):
    """Simple Supabase REST query."""
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        return []
    params = [("select", select)]
    if filters:
        for f in filters:
            # Each filter is like "status=eq.auto_queue" - split on first =
            k, _, v = f.partition("=")
            params.append((k, v))
    if order:
        params.append(("order", order))
    if limit:
        params.append(("limit", str(limit)))
    query_string = urllib.parse.urlencode(params)
    url = f"{SUPABASE_URL}/rest/v1/{table}?{query_string}"
    req = urllib.request.Request(url)
    req.add_header("apikey", SUPABASE_SERVICE_KEY)
    req.add_header("Authorization", f"Bearer {SUPABASE_SERVICE_KEY}")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        log(f"  ⚠️ Supabase query error: {e}")
        return []

def supabase_update(table, data, job_id):
    """Update a row in Supabase."""
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        return
    url = f"{SUPABASE_URL}/rest/v1/{table}?id=eq.{job_id}"
    body = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="PATCH")
    req.add_header("Content-Type", "application/json")
    req.add_header("apikey", SUPABASE_SERVICE_KEY)
    req.add_header("Authorization", f"Bearer {SUPABASE_SERVICE_KEY}")
    req.add_header("Prefer", "return=minimal")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read()
    except Exception as e:
        log(f"  ⚠️ Supabase update error: {e}")

# ── Discord Notification ──────────────────────────────────────────────────────
def send_discord(embed):
    if not DISCORD_WEBHOOK:
        return
    try:
        http_post(DISCORD_WEBHOOK, {"username": "JobAuto", "embeds": [embed]})
    except Exception as e:
        log(f"  ⚠️ Discord notification error: {e}")

# ── AI helpers ────────────────────────────────────────────────────────────────
def call_groq(system_prompt, user_prompt, model="llama-3.1-8b-instant"):
    if not GROQ_API_KEY:
        return "{}"
    data = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.1,
        "max_tokens": 1500,
        "response_format": {"type": "json_object"},
    }
    try:
        result = http_post(
            "https://api.groq.com/openai/v1/chat/completions",
            data,
            headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
        )
        return result.get("choices", [{}])[0].get("message", {}).get("content", "{}")
    except Exception as e:
        log(f"  ⚠️ Groq error ({model}): {e}")
        # Fallback to Gemini
        return call_gemini(system_prompt, user_prompt)

def call_gemini(system_prompt, user_prompt):
    if not GEMINI_API_KEY:
        return "{}"
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={GEMINI_API_KEY}"
    data = {
        "contents": [{"role": "user", "parts": [{"text": f"{system_prompt}\n\n{user_prompt}"}]}],
        "generationConfig": {"temperature": 0.1, "maxOutputTokens": 1500, "responseMimeType": "application/json"},
    }
    try:
        result = http_post(url, data)
        text = result.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text", "{}")
        log(f"  ✅ Gemini responded ({len(text)} chars)")
        return text
    except Exception as e:
        log(f"  ⚠️ Gemini error: {e}")
        return "{}"

def call_ollama(system_prompt, user_prompt, model="llama3.2:3b"):
    url = f"{os.environ.get('OLLAMA_BASE_URL', 'http://localhost:11434')}/api/chat"
    data = {
        "model": os.environ.get("OLLAMA_MODEL", model),
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "format": "json",
        "stream": False,
        "options": {"temperature": 0.1},
    }
    try:
        result = http_post(url, data)
        text = result.get("message", {}).get("content", "{}")
        log(f"  ✅ Ollama responded ({len(text)} chars)")
        return text
    except Exception as e:
        log(f"  ⚠️ Ollama error: {e}")
        return "{}"

def ai_answer(system_prompt, user_prompt):
    """Try Groq first, fall back to Gemini, then fall back to Ollama."""
    raw = call_groq(system_prompt, user_prompt)
    if not raw or raw.strip() in ("{}", ""):
        raw = call_gemini(system_prompt, user_prompt)
    if not raw or raw.strip() in ("{}", ""):
        raw = call_ollama(system_prompt, user_prompt)
    return raw

# ── Static answers (no AI needed for common fields) ──────────────────────────
STATIC_ANSWERS = [
    (re.compile(r"linkedin", re.I), "https://www.linkedin.com/in/abhishek-raj-pagadala"),
    (re.compile(r"github|portfolio.*url", re.I), "https://github.com/AbhishekAbsy0710"),
    (re.compile(r"^city$|current.*city|where.*you.*based", re.I), "Munich"),
    (re.compile(r"^country$|country.*reside|country.*live|nationality|passport.*country", re.I), "Germany"),
    (re.compile(r"salary.*expect|expected.*salary|desired.*salary|compensation", re.I), "55000"),
    (re.compile(r"notice.*period|start.*date|available.*start", re.I), "Immediate"),
    (re.compile(r"preferred.*name|preferred first", re.I), "Abhishek"),
    (re.compile(r"twitter|x\.com|x\s*/\s*twitter", re.I), "https://x.com/AbhishekAbsy"),
    (re.compile(r"pronoun", re.I), "He/him"),
    (re.compile(r"require.*visa|need.*visa.*sponsor|visa.*required", re.I), "No"),
    (re.compile(r"work.*authoriz|work.*permit|right.*to.*work|legally auth", re.I), "Yes"),
    (re.compile(r"website|personal.*url|your.*website", re.I), "https://github.com/AbhishekAbsy0710"),
]

def try_static_answer(label_text):
    label = re.sub(r"[*\u25cf\u2022\uFE0F]+", "", label_text or "").strip()
    for pattern, value in STATIC_ANSWERS:
        if pattern.search(label):
            return value
    return None

# ── Playwright page helpers ───────────────────────────────────────────────────
def wait(ms):
    time.sleep(ms / 1000)

def fill_field(page, selectors, value):
    """Try multiple selectors to fill a field."""
    if not value:
        return False
    for sel in selectors:
        try:
            el = page.query_selector(sel)
            if el and el.is_visible():
                el.scroll_into_view_if_needed()
                el.click()
                el.fill("")
                el.type(value, delay=10)
                wait(80)
                return True
        except Exception:
            pass
    return False

def dismiss_cookie_banner(page):
    cookie_selectors = [
        "button#onetrust-accept-btn-handler",
        "button#accept-recommended-btn-handler",
        "[id*='cookie'][id*='accept']",
        "button:has-text('Accept All Cookies')",
        "button:has-text('Accept All')",
        "button:has-text('Allow All')",
        "button:has-text('Accept')",
        "button:has-text('Got it')",
    ]
    for sel in cookie_selectors:
        try:
            btn = page.query_selector(sel)
            if btn and btn.is_visible():
                btn.click(force=True)
                wait(500)
                log("  🍪 Dismissed cookie banner")
                return
        except Exception:
            pass

def fill_base_fields(page, resume_path):
    """Fill standard name/email/phone/resume fields."""
    page.evaluate("document.querySelectorAll('a').forEach(a => a.removeAttribute('target'))")

    # Name fields
    fill_field(page, [
        '#first_name', 'input[name="first_name"]', 'input[name*="first"]:not([name*="preferred"])',
        'input[id*="firstName"]',
    ], PROFILE["firstName"])
    fill_field(page, [
        '#last_name', 'input[name="last_name"]', 'input[name*="last"]', 'input[id*="lastName"]',
    ], PROFILE["lastName"])
    fill_field(page, ['input[name="_systemfield_name"]', 'input[name="name"]', 'input[name="cards[0][field0]"]'], PROFILE["fullName"])
    fill_field(page, ['input[name="preferred_name"]', 'input[name*="preferred"]'], PROFILE["firstName"])
    fill_field(page, ['input[name="candidate[first_name]"]'], PROFILE["firstName"])
    fill_field(page, ['input[name="candidate[last_name]"]'], PROFILE["lastName"])
    fill_field(page, ['input[id="candidate_first_name"]'], PROFILE["firstName"])
    fill_field(page, ['input[id="candidate_last_name"]'], PROFILE["lastName"])

    # Email & Phone
    fill_field(page, [
        '#email', 'input[name="email"]', 'input[type="email"]',
        'input[name="_systemfield_email"]', 'input[id*="email"]',
    ], PROFILE["email"])

    # "Confirm your email" field — SmartRecruiters uses React-generated names/ids
    # that DON'T contain "confirm" or "email", so we must match by LABEL TEXT
    try:
        confirm_filled = page.evaluate("""(email) => {
            // Strategy 1: Find label containing "confirm" + "email", then find its input
            const labels = document.querySelectorAll('label');
            for (const label of labels) {
                const txt = (label.innerText || '').toLowerCase();
                if (txt.includes('confirm') && txt.includes('email')) {
                    // Try label[for] -> input
                    const forId = label.getAttribute('for');
                    let inp = forId ? document.getElementById(forId) : null;
                    // Try input inside label
                    if (!inp) inp = label.querySelector('input');
                    // Try next sibling input
                    if (!inp) {
                        const parent = label.closest('div, fieldset, section');
                        if (parent) inp = parent.querySelector('input:not([type="hidden"])');
                    }
                    if (inp && !inp.value) {
                        const nativeSet = Object.getOwnPropertyDescriptor(
                            window.HTMLInputElement.prototype, 'value').set;
                        nativeSet.call(inp, email);
                        inp.dispatchEvent(new Event('input', {bubbles: true}));
                        inp.dispatchEvent(new Event('change', {bubbles: true}));
                        return true;
                    }
                }
            }
            
            // Strategy 2: Find any empty input with type="email" or near "email" text
            // (the confirm field is usually the 2nd email-like input on the page)
            const allInputs = document.querySelectorAll('input');
            let emailInputCount = 0;
            for (const inp of allInputs) {
                if (inp.offsetParent === null || inp.type === 'hidden') continue;
                const parent = inp.closest('div, fieldset');
                const parentText = parent ? parent.innerText.toLowerCase() : '';
                const isEmailRelated = inp.type === 'email' || 
                    (inp.name || '').toLowerCase().includes('email') ||
                    (inp.id || '').toLowerCase().includes('email') ||
                    parentText.includes('email');
                if (isEmailRelated) {
                    emailInputCount++;
                    // The 2nd email-related input is the confirm field
                    if (emailInputCount >= 2 && !inp.value) {
                        const nativeSet = Object.getOwnPropertyDescriptor(
                            window.HTMLInputElement.prototype, 'value').set;
                        nativeSet.call(inp, email);
                        inp.dispatchEvent(new Event('input', {bubbles: true}));
                        inp.dispatchEvent(new Event('change', {bubbles: true}));
                        return true;
                    }
                }
            }
            return false;
        }""", PROFILE["email"])
        if confirm_filled:
            log("    ↳ ✉️ Filled 'Confirm your email' field")
    except Exception as e:
        log(f"    ↳ ⚠️ Confirm email fill error: {e}")

    fill_field(page, [
        '#phone', 'input[name="phone"]', 'input[type="tel"]',
        'input[name="_systemfield_phone"]', 'input[id*="phone"]',
    ], PROFILE["phone"])

    # LinkedIn/GitHub/Website
    fill_field(page, ['input[name*="linkedin"]', 'input[id*="linkedin"]'], PROFILE["linkedin"])
    fill_field(page, ['input[name*="github"]', 'input[id*="github"]'], PROFILE["github"])
    fill_field(page, ['input[name*="website"]', 'input[name*="portfolio"]'], PROFILE["github"])

    # Location
    fill_field(page, ['input[name*="city"]', 'input[id*="city"]', 'input[placeholder*="City" i]'], PROFILE["city"])
    fill_field(page, ['input[name*="country"]', 'input[id*="country"]'], PROFILE["country"])

    # Resume upload
    if Path(resume_path).exists():
        try:
            file_inputs = page.query_selector_all('input[type="file"]')
            for inp in file_inputs:
                accept = inp.get_attribute("accept") or ""
                name = inp.get_attribute("name") or ""
                if "pdf" in accept or "resume" in name or "cv" in name or len(file_inputs) == 1:
                    inp.set_input_files(str(resume_path))
                    log("  📎 Resume uploaded")
                    break
        except Exception:
            pass

    # Lever EEO fields
    eeo = {
        'select[name="eeo[gender]"]': 'Decline to self-identify',
        'select[name="eeo[race]"]': 'Decline to self-identify',
        'select[name="eeo[veteran]"]': 'I decline to self-identify for protected veteran status',
        'select[name="eeo[disability]"]': 'I do not want to answer',
    }
    for sel, val in eeo.items():
        try:
            el = page.query_selector(sel)
            if el and el.is_visible():
                el.select_option(label=val)
        except Exception:
            pass

def fill_dynamic_fields(page):
    """Use AI to fill custom application questions."""
    # Collect form fields
    fields = page.evaluate("""() => {
        const results = [];
        const inputs = Array.from(document.querySelectorAll(
            'input:not([type="hidden"]):not([type="file"]):not([type="submit"]), select, textarea'
        ));
        for (const el of inputs) {
            const name = (el.name || el.id || '').toLowerCase();
            if (['first_name','last_name','fname','lname','name'].includes(name) ||
                name.includes('email') || name.includes('phone') ||
                name.startsWith('iti-') || name.includes('search-input') ||
                el.disabled) continue;

            let labelText = '';
            if (el.labels && el.labels.length > 0) {
                labelText = Array.from(el.labels).map(l => l.innerText).join(' ');
            } else {
                const parent = el.closest('.field, .form-group, div');
                if (parent) labelText = parent.innerText.split('\\n')[0];
            }

            let options = [];
            if (el.tagName === 'SELECT') {
                options = Array.from(el.querySelectorAll('option'))
                    .filter(o => o.innerText.trim() && o.innerText.trim() !== 'Select...')
                    .map(o => ({ value: o.value || o.innerText.trim(), label: o.innerText.trim() }));
            } else if (el.type === 'radio' || el.type === 'checkbox') {
                const labelById = el.id ? document.querySelector('label[for="' + el.id + '"]') : null;
                const text = labelById ? labelById.innerText.trim() : el.value;
                options = [{ value: el.value, label: text }];
            }

            if (labelText && (el.name || el.id)) {
                results.push({
                    id: el.id || '',
                    name: el.name || el.id || '',
                    type: el.type || el.tagName.toLowerCase(),
                    label: labelText.substring(0, 150).replace(/\\s+/g, ' ').trim(),
                    options: options.slice(0, 20),
                });
            }
        }
        return results;
    }""")

    # Filter out GDPR/consent fields and security code inputs
    clean_fields = [
        f for f in fields
        if not any(x in (f.get("name", "") + f.get("id", "")).lower()
                   for x in ["fc-preference", "fc-vendor", "didomi", "consent-slider", "gvl-vendor", "security-input"])
    ]

    if not clean_fields:
        return

    # Group radio buttons
    grouped = {}
    for f in clean_fields:
        name = f["name"]
        if name not in grouped:
            grouped[name] = dict(f)
            grouped[name]["options"] = []
        grouped[name]["options"].extend(f.get("options", []))

    questions = list(grouped.values())
    if not questions:
        return

    # Static pre-fill (no AI)
    static_filled = []
    ai_questions = []
    for q in questions:
        val = try_static_answer(q.get("label", ""))
        if val:
            # Fill the field now
            sel = f'[name="{q["name"]}"], [id="{q["name"]}"]'
            try:
                el = page.query_selector(f'[name="{q["name"]}"]') or page.query_selector(f'[id="{q["name"]}"]')
                if el:
                    tag = el.evaluate("e => e.tagName").lower()
                    if tag == "select":
                        try:
                            el.select_option(label=val)
                        except Exception:
                            pass
                    else:
                        el.scroll_into_view_if_needed()
                        el.click(click_count=3)
                        wait(100)
                        page.keyboard.type(val, delay=10)
                        wait(500)
                        page.keyboard.press("ArrowDown")
                        wait(100)
                        page.keyboard.press("Enter")
                        wait(300)
                    log(f"    ↳ [cache] {q['name']} → {val[:50]}")
                    static_filled.append(q["name"])
            except Exception:
                pass
        else:
            ai_questions.append(q)

    if not ai_questions:
        log(f"  ✅ All {len(static_filled)} fields filled from cache")
        return

    log(f"  🤖 AI answering {len(ai_questions)} custom fields...")

    profile_yaml = ""
    profile_yml_path = ROOT / "config" / "profile.yml"
    if profile_yml_path.exists():
        profile_yaml = profile_yml_path.read_text()[:2000]

    sys_prompt = f"""You are an AI filling out a job application. Use the candidate profile to answer questions.
PROFILE:
{profile_yaml}
LinkedIn: {PROFILE["linkedin"]}
GitHub: {PROFILE["github"]}
Location: Munich, Germany (EU Blue Card holder, no visa sponsorship needed)

Return JSON strictly:
{{"answers": [{{"name": "input_name", "value": "answer", "type": "text|select|radio|checkbox"}}]}}

RULES:
- NEVER leave required fields blank
- For country/residence: always "Germany"
- For select/radio: value MUST be from the options list
- Visa/sponsorship: "No"
- Disability/veteran/gender: "Decline to answer" or "Prefer not to say"
- LinkedIn: {PROFILE["linkedin"]}, GitHub: {PROFILE["github"]}"""

    user_prompt = "Form fields:\n" + json.dumps(ai_questions, indent=2)

    try:
        raw = ai_answer(sys_prompt, user_prompt)
        m = re.search(r'\{[\s\S]*\}', raw)
        if not m:
            raise ValueError("No JSON in AI response")
        data = json.loads(m.group())
        answers = data.get("answers", [])

        for ans in answers:
            name = ans.get("name", "")
            val = ans.get("value", "")
            typ = ans.get("type", "text")
            if not val:
                continue
            try:
                el = page.query_selector(f'[name="{name}"]') or page.query_selector(f'[id="{name}"]')
                if not el:
                    continue
                if typ in ("radio", "checkbox"):
                    page.click(f'[name="{name}"][value="{val}"]', force=True, timeout=2000)
                elif typ in ("select", "select-one"):
                    el.select_option(label=val)
                else:
                    el.scroll_into_view_if_needed()
                    el.click(click_count=3)
                    wait(50)
                    page.keyboard.type(str(val), delay=10)
                    wait(500)
                    page.keyboard.press("ArrowDown")
                    wait(100)
                    page.keyboard.press("Enter")
                    wait(100)
                log(f"    ↳ AI filled {name} → {str(val)[:50]}")
            except Exception as e:
                log(f"    ↳ ⚠️ Failed {name}: {str(e)[:60]}")
    except Exception as e:
        log(f"  ⚠️ AI fill error: {e}")

def click_submit_button(page):
    """Try to click Submit/Apply/Continue buttons in order.
    Explicitly excludes third-party buttons like 'Apply With Indeed/LinkedIn'.
    """
    # Third-party integration buttons and cookie/nav buttons to skip
    SKIP_TEXTS = [
        "with indeed", "with linkedin", "with google", "with facebook",
        "with github", "with twitter", "with apple", "with microsoft",
        "refer a friend", "refer friend", "show all",
        "cookie", "cookies", "privacy", "accept", "reject",
        "confirm my choices", "continue without", "settings",
    ]

    clicked_info = page.evaluate("""({skipTexts}) => {
        function shouldSkip(txt) {
            const t = txt.trim().toLowerCase();
            return skipTexts.some(s => t.includes(s));
        }
        function mark(el, action) {
            const id = 'bot-click-' + Date.now() + Math.random().toString().slice(2);
            el.setAttribute('data-bot-click-target', id);
            return { action: action, text: (el.textContent || el.value || '').trim(), id: id };
        }

        // Priority 1: data-qa submit buttons (SmartRecruiters, etc)
        const qaSubmit = document.querySelector('[data-qa="btn-submit"], [data-qa="btn-submit-application"]');
        if (qaSubmit && qaSubmit.offsetWidth > 0) {
            const t = (qaSubmit.textContent || '').trim();
            if (!shouldSkip(t)) return mark(qaSubmit, 'submitted');
        }

        // Priority 2: type=submit buttons
        const typeSubmits = Array.from(document.querySelectorAll('button[type="submit"], input[type="submit"]'));
        for (const el of typeSubmits) {
            if (el.offsetWidth === 0) continue;
            const t = (el.textContent || el.value || '').trim();
            if (!shouldSkip(t)) return mark(el, 'submitted');
        }

        // Priority 3: buttons/links with submit-like text (exact/strong matches)
        const submitKeywords = [
            'submit application', 'send application', 'submit your application',
            'complete application', 'send my application', 'finish application',
            'abschicken', 'senden', 'bewerbung absenden'
        ];
        const all = Array.from(document.querySelectorAll('button, a[role="button"], a.button, input[type="submit"], oc-button, spl-button, [role="button"], [data-test="footer-next"], [data-test="footer-submit"]'));
        for (const el of all) {
            if (el.offsetWidth === 0) continue;
            const t = (el.textContent || el.value || '').trim().toLowerCase();
            if (submitKeywords.some(k => t.includes(k)) && !shouldSkip(t)) {
                return mark(el, 'submitted');
            }
        }

        // Priority 4: Next/Continue buttons (multi-step forms)
        const nextKeywords = ['next', 'continue', 'next step', 'weiter', 'fortfahren', 'proceed'];
        for (const el of all) {
            if (el.offsetWidth === 0) continue;
            const t = (el.textContent || '').trim().toLowerCase();
            if (nextKeywords.some(k => t === k || t.startsWith(k + ' ')) && !shouldSkip(t)) {
                return mark(el, 'next');
            }
        }

        return null;
    }""", {"skipTexts": SKIP_TEXTS})

    if clicked_info:
        action = clicked_info.get("action", "next")
        text = clicked_info.get("text", "")[:50]
        target_id = clicked_info.get("id")
        
        sel = f'[data-bot-click-target="{target_id}"]'
        
        if action == "submitted":
            if os.environ.get("DRY_RUN", "false").lower() == "true":
                log(f"  🧪 DRY_RUN: skipping final submit button '{text}'")
                return "submitted"
            else:
                log(f"  🖱️ Clicked submit: '{text}'")
                page.click(sel, force=True)
                wait(3000)
        else:
            log(f"  ➡️ Clicked next: '{text}'")
            page.click(sel, force=True)
            wait(2000)
        return action

    # Final fallback: try standard selectors directly
    for sel in ['button[type="submit"]', 'input[type="submit"]', '[data-qa="btn-submit"]']:
        try:
            el = page.query_selector(sel)
            if el and el.is_visible():
                txt = (el.text_content() or el.get_attribute("value") or sel)[:50]
                if os.environ.get("DRY_RUN", "false").lower() == "true":
                    log(f"  🧪 DRY_RUN: skipping fallback submit '{txt}'")
                    return "submitted"
                log(f"  🖱️ Fallback submit: '{txt}'")
                el.click()
                wait(3000)
                return "submitted"
        except Exception:
            pass

    return None

def click_greenhouse_apply(page):
    """On Greenhouse job description pages, click the Apply/I'm interested button via JS."""
    if "greenhouse.io" not in page.url or "application" in page.url:
        return False
    clicked = page.evaluate("""() => {
        const selectors = ['#apply_button', '#im_interested_button', 'a.btn-gh-apply', '.application-button a'];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) { el.click(); return el.textContent || sel; }
        }
        const all = Array.from(document.querySelectorAll('a, button'));
        for (const el of all) {
            const txt = (el.textContent || '').trim().toLowerCase();
            if (txt.includes('apply for this job') || txt === "i'm interested" || txt.includes("apply now")) {
                el.click();
                return el.textContent;
            }
        }
        return null;
    }""")
    if clicked:
        log(f"  🎯 GH Apply clicked: '{clicked[:40]}'")
        wait(2500)
        return True
    return False

def apply_to_job(page, context, job, resume_path):
    """Full application flow for one job."""
    apply_link = job.get("apply_link", "")
    if not apply_link:
        raise ValueError("No apply_link")

    log(f"  🌐 Navigating to {apply_link[:80]}...")
    page.goto(apply_link, wait_until="domcontentloaded", timeout=30000)
    wait(2000 + random.random() * 1500)

    # Detect captcha/bot wall immediately
    page_text = page.text_content("body") or ""
    text_lower = page_text.lower()
    captcha_signals = [
        "cloudflare", "checking your browser", "security check", "verify you are human",
        "enable javascript and cookies", "please solve this captcha", "datadome", "captcha-delivery",
    ]
    if any(s in text_lower for s in captcha_signals):
        s_path = f"captcha_{int(time.time())}.png"
        page.screenshot(path=s_path)
        return False, "Captcha Blocked", s_path

    current_url = page.url

    # ── SmartRecruiters: click Apply button first ──
    if "smartrecruiters.com" in current_url:
        # Wait for page to render JS (SR is a SPA)
        try:
            page.wait_for_selector("a.button--primary, [data-qa='btn-apply']", timeout=8000)
        except Exception:
            pass

        # Dismiss cookie banner so it doesn't intercept the Apply button click
        dismiss_cookie_banner(page)
        wait(500)

        # SmartRecruiters uses "I'm interested" or "Apply Now" as their Apply button
        apply_clicked = None
        for sel in ["a.button--primary", "a[class*='button--primary']", "[data-qa='btn-apply']"]:
            try:
                btn = page.query_selector(sel)
                if btn and btn.is_visible():
                    txt = (btn.text_content() or "").strip()
                    # Skip non-apply buttons
                    if any(skip in txt.lower() for skip in ["cookie", "accept all", "refer", "show all"]):
                        continue
                    btn.scroll_into_view_if_needed()
                    btn.click()
                    apply_clicked = txt
                    break
            except Exception:
                pass

        if not apply_clicked:
            # Fallback using trusted clicks
            for txt in ["I'm interested", "Apply Now", "Apply for this", "Bewerben"]:
                try:
                    btn = page.get_by_text(txt, exact=False).first
                    if btn and btn.is_visible():
                        if not any(skip in (btn.text_content() or "").lower() for skip in ["refer", "show all", "cookie"]):
                            btn.scroll_into_view_if_needed()
                            btn.click(force=True)
                            apply_clicked = txt
                            break
                except Exception:
                    pass

        if apply_clicked:
            log(f"  🎯 SR Apply clicked: '{str(apply_clicked).strip()[:40]}'")
            wait(4000)  # SR takes longer to load the form
        else:
            log("  ⚠️ SmartRecruiters Apply button not found")

    # ── Greenhouse: click "Apply for this Job" / "I'm interested" ──
    elif "greenhouse.io" in current_url and "application" not in current_url:
        click_greenhouse_apply(page)

    # Dismiss cookie banners
    dismiss_cookie_banner(page)
    wait(500)

    # Multi-step form loop
    max_steps = 8
    prev_url = page.url
    submitted = False
    prev_content_hash = None
    stuck_count = 0

    for step in range(max_steps):
        log(f"  📋 Step {step + 1}: filling fields...")

        # Fill base fields (name, email, phone, resume)
        fill_base_fields(page, resume_path)
        wait(500)

        # Fill dynamic/custom fields with AI
        fill_dynamic_fields(page)
        wait(500)

        # Auto-check any unchecked required checkboxes (GDPR consent, data transfer, etc.)
        try:
            unchecked = page.query_selector_all('input[type="checkbox"]:not(:checked)')
            for cb in unchecked:
                name = cb.get_attribute("name") or cb.get_attribute("id") or ""
                # Check if it's near a required indicator or is a consent/acknowledge field
                parent_text = cb.evaluate("e => e.closest('div, label, fieldset')?.textContent || ''").lower()
                is_required = cb.get_attribute("required") is not None or \
                              cb.get_attribute("aria-required") == "true" or \
                              "required" in parent_text or \
                              "this field is required" in parent_text
                is_consent = any(w in parent_text for w in [
                    "acknowledge", "confirm", "consent", "agree", "accept",
                    "data transfer", "privacy", "terms", "i have read"
                ])
                if is_required or is_consent:
                    try:
                        cb.click(force=True)
                        log(f"    ↳ ☑️ Checked: {name or 'consent checkbox'}")
                        wait(200)
                    except Exception:
                        pass
        except Exception:
            pass

        # Try to advance/submit
        action = click_submit_button(page)
        if not action:
            is_captcha = False
            for frm in page.frames:
                if "datadome" in frm.url.lower() or "captcha-delivery" in frm.url.lower():
                    is_captcha = True
                    break
            
            if is_captcha:
                ts = int(time.time())
                s_path = f"captcha_datadome_{ts}.png"
                page.screenshot(path=s_path)
                log("  ⚠️ DataDome Captcha Blocked (in iframe)")
                return False, "Captcha Blocked (DataDome)", s_path

            ts = int(time.time())
            s_path = f"debug_failed_form_{ts}.png"
            page.screenshot(path=s_path)
            with open(f"debug_failed_form_{ts}.html", "w", encoding="utf-8") as f:
                f.write(page.content())
            log("  ⚠️ No button found to advance")
            return False, "Validation Error / No advance button", s_path

        wait(2000)

        # Stuck-loop detection: if page content hasn't changed after clicking Next,
        # we're stuck on a validation error or infinite loop — bail out
        try:
            import hashlib
            curr_content = page.inner_text("body") or ""
            curr_hash = hashlib.md5(curr_content[:3000].encode()).hexdigest()
            if curr_hash == prev_content_hash:
                stuck_count += 1
                log(f"  ⚠️ Page unchanged after click ({stuck_count}/3)")
                if stuck_count >= 3:
                    ts = int(time.time())
                    s_path = f"debug_stuck_{ts}.png"
                    page.screenshot(path=s_path)
                    log("  ❌ Stuck in form loop — aborting")
                    return False, "Stuck in form loop (validation error)", s_path
            else:
                stuck_count = 0
            prev_content_hash = curr_hash
        except Exception:
            pass

        # Handle Greenhouse OTP if present
        try:
            sec_input = page.query_selector("#security-input-0")
            if sec_input and sec_input.is_visible():
                company_name = job.get("company", "Company").replace("'", "").replace('"', "")
                log("  🔒 Security code verification required!")
                with open("WAITING_FOR_SECURITY_CODE.txt", "w", encoding="utf-8") as f:
                    f.write(f'Check email for code from {company_name}, then run: echo "CODE" > security_code.txt')
                os.system(f"osascript -e 'display notification \"Check email: code needed for {company_name}\" with title \"JobAuto: OTP Required\" sound name \"Glass\"' 2>/dev/null")
                log("  ⏳ Waiting up to 10 min for security_code.txt...")
                
                start_wait = time.time()
                code_found = False
                while time.time() - start_wait < 600:
                    if os.path.exists("security_code.txt"):
                        with open("security_code.txt", "r", encoding="utf-8") as f:
                            code = f.read().strip()
                        os.remove("security_code.txt")
                        if len(code) >= 6:
                            log("  ✅ Code received! Filling it in...")
                            for i, char in enumerate(code[:8]):
                                inp = page.query_selector(f"#security-input-{i}")
                                if inp:
                                    inp.click()
                                    inp.fill("")
                                    inp.type(char, delay=50)
                            wait(1000)
                            # Also check any unchecked consent checkboxes before submit
                            try:
                                unchecked = page.query_selector_all('input[type="checkbox"]:not(:checked)')
                                for cb in unchecked:
                                    parent_text = cb.evaluate("e => e.closest('div, label, fieldset')?.textContent || ''").lower()
                                    if any(w in parent_text for w in ["acknowledge", "confirm", "consent", "agree", "data transfer", "privacy"]):
                                        cb.click(force=True)
                                        wait(100)
                            except Exception:
                                pass
                            log("  🔘 Clicking SUBMIT again after security code")
                            action = click_submit_button(page)
                            wait(2000)
                            code_found = True
                            break
                    wait(2000)
                if os.path.exists("WAITING_FOR_SECURITY_CODE.txt"):
                    os.remove("WAITING_FOR_SECURITY_CODE.txt")
                if not code_found:
                    log("  ⏰ Security code timeout (10 min)")
                    break
        except Exception as e:
            log(f"  ⚠️ OTP check error: {e}")
        if detect_success(page, prev_url):
            submitted = True
            log("  🎉 Application submitted successfully!")
            # Capture proof screenshot on success
            try:
                ts = int(time.time())
                proof_path = f"proof_success_{ts}.png"
                page.screenshot(path=proof_path, full_page=True)
                log(f"  📸 Proof screenshot captured: {proof_path}")
                return True, None, proof_path
            except Exception:
                pass
            break

        if action == "submitted":
            # Check page for actual success or error
            err_text = page.text_content("body") or ""
            err_lower = err_text.lower()
            if any(e in err_lower for e in ["error", "required", "invalid", "please fill"]):
                ts = int(time.time())
                page.screenshot(path=f"debug_submission_error_{ts}.png")
                with open(f"debug_submission_error_{ts}.html", "w", encoding="utf-8") as f:
                    f.write(page.content())
                log("  ⚠️ Submission errors detected, trying to fix...")
                wait(1000)
            else:
                submitted = True
                # Capture proof screenshot on success
                try:
                    ts = int(time.time())
                    proof_path = f"proof_success_{ts}.png"
                    page.screenshot(path=proof_path, full_page=True)
                    log(f"  📸 Proof screenshot captured: {proof_path}")
                    return True, None, proof_path
                except Exception:
                    pass
                break

        prev_url = page.url

    return submitted, "Validation Error / Max steps reached", None

def detect_success(page, prev_url):
    """Detect if application was submitted successfully."""
    url = page.url.lower()
    try:
        page_text = page.text_content("body") or ""
    except Exception:
        page_text = ""
    text_lower = page_text.lower()

    success_signals = [
        "thank you", "application received", "application submitted",
        "we've received your", "your application has been", "successfully applied",
        "we will review", "confirmation", "submitted successfully",
        "application complete", "danke", "bewerbung erhalten",
    ]
    for sig in success_signals:
        if sig in text_lower:
            return True

    # URL changed significantly
    if url != prev_url and ("thank" in url or "confirm" in url or "success" in url or "complete" in url):
        return True

    return False

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    from playwright.sync_api import sync_playwright, TimeoutError
    from playwright_stealth import Stealth
    import time
    import json
    import os
    import re
    import random

    log("🚀 JobAuto Python Browser Applier starting...")

    # Determine chromium path
    chromium_path = None
    is_headed = os.environ.get("HEADED", "").lower() in ("true", "1", "yes")
    if is_headed:
        if Path(CHROMIUM_FULL).exists():
            chromium_path = CHROMIUM_FULL
    else:
        if Path(CHROMIUM_HEADLESS).exists():
            chromium_path = CHROMIUM_HEADLESS
        elif Path(CHROMIUM_FULL).exists():
            chromium_path = CHROMIUM_FULL

    if not chromium_path:
        log("❌ No Chromium found! Run: playwright install chromium")
        sys.exit(1)

    log(f"  🌐 Using Chromium: {chromium_path[-60:]}")

    # Fetch jobs from Supabase
    from datetime import timezone
    thirty_days_ago = (datetime.now(timezone.utc) - timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
    is_local = os.environ.get("LOCAL_RUN", "").lower() == "true"

    # Build query filters
    if os.environ.get("TEST_JOB_ID"):
        test_id = os.environ["TEST_JOB_ID"]
        log(f"🧪 TEST MODE — job {test_id}")
        filters = [f"id=eq.{test_id}"]
    else:
        filters = [
            "status=eq.auto_queue",
            f"scraped_at=gte.{thirty_days_ago}",
        ]

    jobs_raw = supabase_query(
        "jobs",
        select="id,title,company,apply_link,status,platform,description,scraped_at,evaluations(id,letter_grade,weighted_score)",
        filters=filters,
        order="scraped_at.desc",
        limit="200",
    )

    if not jobs_raw:
        log("💭 No jobs in the apply queue.")
        return

    log(f"  📋 Found {len(jobs_raw)} jobs in auto_queue")

    # Sort by scraped_at (newest first - no score available in simple query)
    jobs = sorted(jobs_raw, key=lambda j: j.get("scraped_at", ""), reverse=True)

    # Keywords filter
    TARGET_KEYWORDS = [
        "data engineer", "data analyst", "data scientist", "analytics engineer",
        "devops", "cloud engineer", "cloud architect", "platform engineer",
        "backend", "fullstack", "full stack", "full-stack",
        "software engineer", "software developer",
        "ai engineer", "ml engineer", "machine learning", "mlops",
        "infrastructure engineer", "site reliability", "sre",
        "frontend engineer", "frontend developer",
        "security engineer", "security analyst", "devseops",
        "platform", "technical staff", "tech lead", "product manager", 
        "engineering manager", "compliance engineer"
    ]
    SKIP_KEYWORDS = [
        "kosmetik", "werkstudent", "praktikum", "pflege", "fahrer",
        "marketing manager", "social media", "sales manager", "account executive",
        "hr manager", "recruiter", "talent acquisition",
        "embedded", "firmware", "hardware engineer",
    ]

    filtered = []
    company_counts = {}
    for j in jobs:
        title_lower = (j.get("title") or "").lower()
        company_key = (j.get("company") or "").lower().strip()

        if any(kw in title_lower for kw in SKIP_KEYWORDS):
            continue
        if not any(kw in title_lower for kw in TARGET_KEYWORDS):
            continue
        if company_counts.get(company_key, 0) >= 3:
            continue

        company_counts[company_key] = company_counts.get(company_key, 0) + 1
        filtered.append(j)
        if len(filtered) >= 25:
            break

    if not filtered:
        log("💭 No matching jobs after filtering.")
        return

    log(f"\n🚀 Auto-applying to {len(filtered)} jobs...\n")

    results = {"applied": 0, "failed": 0, "skipped": 0}
    applied_jobs = []
    failed_jobs = []
    company_applied = {}

    with sync_playwright() as p:
        browser = p.chromium.launch(
            channel="chrome",
            headless=not is_headed,
            slow_mo=300 if is_headed else 100,
            ignore_default_args=["--enable-automation"],
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-web-security",
            ],
        )
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
            viewport={"width": 1440, "height": 900},
            locale="en-US",
            timezone_id="Europe/Berlin",
            geolocation={"longitude": 11.58, "latitude": 48.14},
            permissions=["geolocation"],
            extra_http_headers={
                "Accept-Language": "en-US,en;q=0.9",
                "sec-ch-ua": '"Not(A:Brand";v="99", "Google Chrome";v="148", "Chromium";v="148"',
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": '"macOS"'
            }
        )
        # Erase webdriver fingerprint
        context.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            window.chrome = { runtime: {} };
        """)
        context.set_default_timeout(10000)

        for job in filtered:
            title = job.get("title", "?")
            company = job.get("company", "?")
            company_key = company.lower().strip()
            job_id = job.get("id")

            evals = job.get("evaluations", {})
            eval_data = evals[0] if isinstance(evals, list) and evals else (evals if isinstance(evals, dict) else {})
            ats_score = eval_data.get("weighted_score")
            eval_id = eval_data.get("id", job_id)

            log(f"\n━━━ {title} @ {company} ━━━")

            # Per-company cap
            if company_applied.get(company_key, 0) >= 2:
                log(f"  ⏭️ Skipping — already applied to {company} 2x this run")
                results["skipped"] += 1
                continue

            page = context.new_page()
            Stealth().apply_stealth_sync(page)
            try:
                success, fail_reason, err_screenshot = apply_to_job(page, context, job, str(RESUME_PATH))

                from datetime import timezone as tz
                if success:
                    results["applied"] += 1
                    company_applied[company_key] = company_applied.get(company_key, 0) + 1
                    applied_jobs.append({"title": title, "company": company})
                    log(f"  ✅ Applied to {title} @ {company}")

                    # Upload proof screenshot if available
                    proof_url = None
                    if err_screenshot and os.path.exists(err_screenshot):
                        from PIL import Image
                        try:
                            im = Image.open(err_screenshot)
                            jpeg_path = err_screenshot.replace(".png", ".jpeg")
                            im.convert('RGB').save(jpeg_path, "JPEG", quality=50)
                            proof_url = upload_screenshot(jpeg_path, f"proof_{job_id}_{int(time.time())}.jpeg")
                            if proof_url:
                                log(f"  📸 Proof uploaded: {proof_url}")
                        except Exception as e:
                            log(f"  ⚠️ Could not process proof screenshot: {e}")

                    if os.environ.get("DRY_RUN", "false").lower() == "true":
                        log(f"  🧪 DRY_RUN: skipping Supabase update for {job_id}")
                    else:
                        update_data = {"status": "applied", "applied_at": datetime.now(tz.utc).isoformat()}
                        if proof_url:
                            update_data["proof_url"] = proof_url
                        supabase_update("jobs", update_data, job_id)

                    send_discord({
                        "title": f"✅ Auto-Applied: {title}",
                        "description": f"Successfully applied to **{company}**!",
                        "color": 0x00d2a0,
                        "fields": [
                            {"name": "🏢 Company", "value": company, "inline": True},
                            {"name": "⭐ ATS Score", "value": f"{ats_score:.1f} / 5.0" if ats_score else "? / 5.0", "inline": True},
                            {"name": "🔗 Apply Link", "value": f"[Open Job]({job.get('apply_link', '')})", "inline": True},
                            {"name": "📸 Proof", "value": f"[View Screenshot]({proof_url})" if proof_url else "No screenshot", "inline": True},
                        ],
                        "image": {"url": proof_url} if proof_url else None,
                        "timestamp": datetime.utcnow().isoformat(),
                    })
                else:
                    results["failed"] += 1
                    failed_jobs.append({"title": title, "company": company})
                    log(f"  ❌ Failed to apply to {title} @ {company}")
                    
                    if os.environ.get("DRY_RUN", "false").lower() == "true":
                        log(f"  🧪 DRY_RUN: skipping Supabase update for {job_id}")
                    else:
                        supabase_update("jobs", {"status": "manual_queue"}, job_id)
                        
                    error_proof_url = None
                    if err_screenshot and os.path.exists(err_screenshot):
                        from PIL import Image
                        try:
                            im = Image.open(err_screenshot)
                            jpeg_path = err_screenshot.replace(".png", ".jpeg")
                            im.convert('RGB').save(jpeg_path, "JPEG", quality=40)
                            error_proof_url = upload_screenshot(jpeg_path, f"error_{eval_id}_{int(time.time())}.jpeg")
                        except Exception as e:
                            log(f"  ⚠️ Could not process screenshot: {e}")

                    send_discord({
                        "title": f"❌ Auto-Apply Failed: {title}",
                        "description": f"Failed to apply to **{company}** — moved to Manual Queue.",
                        "color": 0xff4500,
                        "fields": [
                            {"name": "🏢 Company", "value": company, "inline": True},
                            {"name": "⭐ ATS Score", "value": f"{ats_score:.1f} / 5.0" if ats_score else "? / 5.0", "inline": True},
                            {"name": "❌ Reason", "value": (fail_reason or "Unknown Error")[:200], "inline": False},
                            {"name": "👉 Apply Manually", "value": f"[Click Here]({job.get('apply_link', '')})", "inline": False},
                        ],
                        "image": {"url": error_proof_url} if error_proof_url else None,
                        "timestamp": datetime.utcnow().isoformat(),
                    })

            except Exception as e:
                import traceback
                results["failed"] += 1
                msg = str(e)[:100]
                log(f"  ❌ Error: {msg}")
                traceback.print_exc()
                failed_jobs.append({"title": title, "company": company, "error": msg})
                supabase_update("jobs", {"status": "manual_queue"}, job_id)
                send_discord({
                    "title": f"❌ Auto-Apply Error: {title}",
                    "description": f"Failed to apply to **{company}** — moved to Manual Queue.",
                    "color": 0xff4500,
                    "fields": [
                        {"name": "🏢 Company", "value": company, "inline": True},
                        {"name": "⭐ ATS Score", "value": f"{ats_score:.1f} / 5.0" if ats_score else "? / 5.0", "inline": True},
                        {"name": "❌ Reason", "value": f"Error: {msg}", "inline": False},
                        {"name": "👉 Apply Manually", "value": f"[Click Here]({job.get('apply_link', '')})", "inline": False},
                    ],
                    "timestamp": datetime.utcnow().isoformat(),
                })
            finally:
                try:
                    page.close()
                except Exception:
                    pass

        browser.close()

    # ── Summary ──
    log(f"\n{'='*50}")
    log(f"📊 SUMMARY: ✅ Applied: {results['applied']} | ❌ Failed: {results['failed']} | ⏭️ Skipped: {results['skipped']}")
    log(f"{'='*50}")

    if applied_jobs:
        log("\n✅ Successfully applied:")
        for j in applied_jobs:
            log(f"   • {j['title']} @ {j['company']}")

    # Final Discord summary
    if results["applied"] > 0 or results["failed"] > 0:
        summary_lines = []
        if applied_jobs:
            summary_lines.append("**Applied:**\n" + "\n".join(f"• {j['title']} @ {j['company']}" for j in applied_jobs[:10]))
        if failed_jobs:
            summary_lines.append("**Failed:**\n" + "\n".join(f"• {j['title']} @ {j['company']}" for j in failed_jobs[:5]))
        send_discord({
            "title": f"📊 Run Complete: {results['applied']} applied, {results['failed']} failed",
            "description": "\n\n".join(summary_lines) or "No details",
            "color": 3447003,
            "timestamp": datetime.utcnow().isoformat(),
        })

if __name__ == "__main__":
    main()
