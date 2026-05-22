from src.scripts.browser_apply import supabase_query
jobs = supabase_query("jobs", select="*", limit="1")
print(jobs[0].keys())
