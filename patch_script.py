import sys

with open("src/scripts/browser_apply.py", "r", encoding="utf-8") as f:
    content = f.read()

# Chunk 1: HTTP post & upload screenshot
target1 = """    except Exception as e:
        raise RuntimeError(f"HTTP POST error: {e}")"""
replacement1 = """    except Exception as e:
        raise RuntimeError(f"HTTP POST error: {e}")

def upload_screenshot(filepath, filename):
    import requests
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY: return None
    url = f"{SUPABASE_URL}/storage/v1/object/screenshots/{filename}"
    headers = {"Authorization": f"Bearer {SUPABASE_SERVICE_KEY}", "Content-Type": "image/jpeg"}
    try:
        with open(filepath, 'rb') as f:
            res = requests.post(url, headers=headers, data=f)
        if res.status_code not in (200, 201):
            with open(filepath, 'rb') as f:
                res = requests.put(url, headers=headers, data=f)
        return f"{SUPABASE_URL}/storage/v1/object/public/screenshots/{filename}"
    except Exception as e:
        log(f"  ⚠️ Error uploading screenshot: {e}")
    return None"""
content = content.replace(target1, replacement1)

# Chunk 2: apply_to_job return success
target2 = """    if submitted:
        log("  🎉 Application submitted successfully!")

    return submitted"""
replacement2 = """    if submitted:
        log("  🎉 Application submitted successfully!")

    return submitted, "", None"""
content = content.replace(target2, replacement2)

# Chunk 3: fetch_pending_jobs query
target3 = """        select="id,title,company,apply_link,status,platform,description,scraped_at","""
replacement3 = """        select="id,title,company,apply_link,status,platform,description,scraped_at,evaluations(id,letter_grade,weighted_score)","""
content = content.replace(target3, replacement3)

# Chunk 4: apply_to_job return failures
target4_1 = """        if not action:
            ts = int(time.time())
            page.screenshot(path=f"debug_failed_form_{ts}.png")
            with open(f"debug_failed_form_{ts}.html", "w", encoding="utf-8") as f:
                f.write(page.content())
            log("  ⚠️ No button found to advance")
            break"""
replacement4_1 = """        if not action:
            ts = int(time.time())
            s_path = f"debug_failed_form_{ts}.png"
            page.screenshot(path=s_path)
            with open(f"debug_failed_form_{ts}.html", "w", encoding="utf-8") as f:
                f.write(page.content())
            log("  ⚠️ No button found to advance")
            return False, "Validation Error / No advance button", s_path"""
content = content.replace(target4_1, replacement4_1)

target4_2 = """    if any(s in text_lower for s in captcha_signals):
        raise ValueError("Captcha/bot detection wall — marking manual")"""
replacement4_2 = """    if any(s in text_lower for s in captcha_signals):
        import time
        s_path = f"captcha_{int(time.time())}.png"
        page.screenshot(path=s_path)
        return False, "Captcha Blocked", s_path"""
content = content.replace(target4_2, replacement4_2)

# Chunk 5: Main loop
target5 = """            job_id = job.get("id")

            log(f"\\n━━━ {title} @ {company} ━━━")

            # Per-company cap
            if company_applied.get(company_key, 0) >= 2:
                log(f"  ⏭️ Skipping — already applied to {company} 2x this run")
                results["skipped"] += 1
                continue

            page = context.new_page()
            Stealth().apply_stealth_sync(page)
            try:
                success = apply_to_job(page, context, job, str(RESUME_PATH))

                if success:
                    results["applied"] += 1
                    company_applied[company_key] = company_applied.get(company_key, 0) + 1
                    applied_jobs.append({"title": title, "company": company})
                    log(f"  ✅ Applied to {title} @ {company}")

                    # Update Supabase
                    from datetime import timezone as tz
                    if os.environ.get("DRY_RUN", "false").lower() == "true":
                        log(f"  🧪 DRY_RUN: skipping Supabase update for {job_id}")
                    else:
                        supabase_update("jobs", {"status": "applied", "applied_at": datetime.now(tz.utc).isoformat()}, job_id)

                    # Discord notification
                    send_discord({
                        "title": f"✅ Applied: {title}",
                        "description": f"**{company}**\\n{job.get('apply_link', '')[:100]}",
                        "color": 3066993,
                        "timestamp": datetime.utcnow().isoformat(),
                    })
                else:
                    results["failed"] += 1
                    failed_jobs.append({"title": title, "company": company})
                    log(f"  ❌ Failed to apply to {title} @ {company}")
                    supabase_update("jobs", {"status": "manual_queue"}, job_id)

            except Exception as e:
                results["failed"] += 1
                msg = str(e)[:100]
                log(f"  ❌ Error: {msg}")
                failed_jobs.append({"title": title, "company": company, "error": msg})
                supabase_update("jobs", {"status": "manual_queue"}, job_id)
                send_discord({
                    "title": f"❌ Failed: {title}",
                    "description": f"**{company}**\\nError: {msg}",
                    "color": 15158332,
                    "timestamp": datetime.utcnow().isoformat(),
                })"""

replacement5 = """            job_id = job.get("id")

            evals = job.get("evaluations", {})
            eval_data = evals[0] if isinstance(evals, list) and evals else (evals if isinstance(evals, dict) else {})
            ats_score = eval_data.get("weighted_score")
            eval_id = eval_data.get("id", job_id)

            log(f"\\n━━━ {title} @ {company} ━━━")

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

                    if os.environ.get("DRY_RUN", "false").lower() == "true":
                        log(f"  🧪 DRY_RUN: skipping Supabase update for {job_id}")
                    else:
                        supabase_update("jobs", {"status": "applied", "applied_at": datetime.now(tz.utc).isoformat()}, job_id)

                    send_discord({
                        "title": f"✅ Auto-Applied: {title}",
                        "description": f"Successfully applied to **{company}**!",
                        "color": 0x00d2a0,
                        "fields": [
                            {"name": "🏢 Company", "value": company, "inline": True},
                            {"name": "⭐ ATS Score", "value": f"{ats_score:.1f} / 5.0" if ats_score else "? / 5.0", "inline": True},
                            {"name": "🔗 Apply Link", "value": f"[Open Job]({job.get('apply_link', '')})", "inline": True},
                        ],
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
                        import time
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
                results["failed"] += 1
                msg = str(e)[:100]
                log(f"  ❌ Error: {msg}")
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
                })"""
content = content.replace(target5, replacement5)

with open("src/scripts/browser_apply.py", "w", encoding="utf-8") as f:
    f.write(content)
print("Done replacing.")
