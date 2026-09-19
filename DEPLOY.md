# Deploy PathWars to Render (free tier)

## 0. What you need first
- A GitHub account + this folder pushed to a repo (steps 1–2).
- Your 3 Supabase keys (you have them) + the **database connection string** (step 3).
- ~15 minutes. Total cost: €0.

## 1. Push this folder to GitHub
Secrets are already excluded by `.gitignore` (`play-local.bat` holds your keys
and will NOT be pushed — verify with `git status` before committing).

```bat
cd /d C:\Users\Amine\Desktop\wallrush.online
git init
git add .
git status quick check: play-local.bat and *.sqlite must NOT be listed
git commit -m "PathWars launch"
```
Create an empty repo on github.com (any name, e.g. `pathwars`), then:
```bat
git remote add origin https://github.com/YOU/pathwars.git
git branch -M main
git push -u origin main
```

## 2. Create the Render service
1. render.com → New → **Web Service** → connect the repo.
2. Render reads `render.yaml` automatically (region: pick closest to players).
3. Plan: **Free**. Create service — first deploy takes ~2 minutes.
4. Dashboard → Environment: paste the 4 values below, Save (auto-redeploys).

| Variable | Where to find it |
|---|---|
| `SUPABASE_URL` | You have it (`https://…supabase.co`) |
| `SUPABASE_ANON_KEY` | You have it (`sb_publishable_…`) |
| `SUPABASE_SERVICE_KEY` | You have it (the long JWT) |
| `DATABASE_URL` | Supabase dashboard → Project Settings → Database → **Connection string, pooler mode** (port `6543`). It contains a `[YOUR-PASSWORD]` placeholder — replace with your database password (set at project creation; reset it there if lost). Format: `postgresql://postgres.[ref]:[pw]@aws-0-…pooler.supabase.com:6543/postgres` |
| `VAPID_PUBLIC` / `VAPID_PRIVATE` | Web Push keys (public one below is safe to share; the private one lives only in your local `play-local.bat` — copy it over, never commit it) |
```
VAPID_PUBLIC=BEUbHCc77JrKKef2UBXh20P1OtQPDk4YQATOZ1KmS7ZrvArzg2r7Nb-cP7gdZaOQIX5DX9X_COhLYWxusf6OBLc
```

`PORT` is set by Render itself — do not add it.

## 3. Verify on the Render URL first
Render gives you a free `*.onrender.com` URL. Before touching your domain:
- [ ] Play a quick match on it (two windows).
- [ ] Register an account on it.
- [ ] Check Ranking + a player card.
Only when all three work, move to step 4.

## 4. Free-tier realities
- Sleeps after 15 min idle: first visitor waits ~30–60 s while it wakes. No data loss (Postgres holds everything).
- No `pathwars.sqlite` on the host and none needed — `DATABASE_URL` switches the server to Postgres; SQLite stays for local dev only.
- Logs: Render dashboard → Logs. Real-time game state is in memory per instance (one free instance = fine).

## 5. LAST: point pathwars.online at Render (DNS takes time)
Do this only after step 3 passes — DNS changes need hours to spread worldwide,
and you don't want the domain pointing at a broken deploy while you wait.
1. Render dashboard → service → Settings → Custom Domains → add `pathwars.online` (and `www.pathwars.online` if wanted).
2. At your domain registrar add the DNS records Render shows you (an `A`/`ALIAS` or `CNAME`, plus ACME challenge if asked).
3. Wait for DNS to propagate (up to a few hours; check with `nslookup pathwars.online`). HTTPS is automatic once DNS resolves (Render provisions the certificate).
4. Wipe test data for launch: local `pathwars.sqlite` recreates empty if deleted; the hosted Postgres ships empty already — keep it that way until real players arrive.
