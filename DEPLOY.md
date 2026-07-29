# Deploying CryptoWatch to Render

CryptoWatch is a zero-dependency Node app that already reads `$PORT`, so it runs
on Render as-is. This guide covers the whole path plus the caveats that actually
bite (they're real — read §4 before you make the URL public).

---

## 1. Get the code into a Git repo

Render deploys from a connected GitHub/GitLab/Bitbucket repo. The code currently
lives inside the `valadate` monorepo (alongside unrelated projects). **Recommended:
push `cryptowatch/` as its own dedicated repo** so you're not exposing the rest of
`valadate`, and so `render.yaml` sits at the repo root.

```bash
cd /Users/jeffbardon/valadate/cryptowatch
git init && git add -A && git commit -m "CryptoWatch"
git branch -M main
git remote add origin https://github.com/<you>/cryptowatch.git
git push -u origin main
```

`config.json` is gitignored (it holds secrets) — good, it won't be pushed. The
vendored `public/vendor/solana-web3.js` IS committed (needed for the swap UI).

> Alternative: connect the whole `valadate` repo and set `rootDir: cryptowatch`
> in `render.yaml`. Only do this if you're comfortable making that repo public
> (or you have a paid private-repo plan).

## 2. Create the service on Render

Two ways — the blueprint is easiest:

- **Blueprint (recommended):** Render Dashboard → **New → Blueprint** → pick the
  repo. Render reads `render.yaml` and provisions the web service. You'll be
  prompted for the `sync:false` env vars (secrets) — see §3.
- **Manual:** New → **Web Service** → pick the repo → Runtime **Node**, Build
  `npm install`, Start `node server.js`, Health check path `/`. Then add env
  vars from §3 yourself.

## 3. Environment variables (this is how secrets get in)

The app never needs a `config.json` on Render — every key has an env fallback.
Set these in the Render dashboard (Environment tab):

| Var | Purpose | Needed? |
|---|---|---|
| `AUTH_PASS` | **Password-gates the whole site** (HTTP Basic Auth) | **Yes, for a public URL** |
| `AUTH_USER` | Username for the gate (defaults to any if only `AUTH_PASS` set) | optional |
| `ANTHROPIC_API_KEY` | AI risk read + "what matters now" digest + "why it matters" | optional |
| `COINGECKO_API_KEY` + `COINGECKO_PLAN` | Lifts the markets rate limit (`demo` or `pro`) | optional |
| `GITHUB_TOKEN` | Lifts GitHub's 60 req/hr limit for the dev-activity board | optional |
| `CONFIG_PATH` | Point at a mounted disk to persist alert rules/delivery (see §4) | optional |

Render sets `PORT` automatically — don't set it yourself.

Telegram/Discord/webhook **delivery** secrets have no env fallback yet (they're
set in the app UI and saved to `config.json`). On Render's ephemeral disk they
reset on each deploy unless you attach a disk (§4).

## 4. Caveats — read before going public

- **🔒 No accounts.** The app exposes key-funded AI (`/ai/*`) and config-writing
  endpoints (`/ai/config`, `/markets/config`, `/dev/config`, `/alerts/*`). On a
  public URL **anyone could spend your Anthropic key or change your config.**
  Mitigation: **set `AUTH_PASS`** (built-in Basic-Auth gate). If you'd rather not
  fund AI publicly, just don't set `ANTHROPIC_API_KEY` — the AI features stay off
  and everything else works.
- **😴 Free tier sleeps.** A Render **free** web service spins down after ~15 min
  of no *inbound* traffic and cold-starts (~30–50s) on the next hit. Because
  CryptoWatch polls live feeds, **the launch radar stops while it's asleep** and
  the in-memory buffer resets on wake.
  - **Built-in keep-alive:** on Render the server auto-pings its own `/healthz`
    every 10 min (using `RENDER_EXTERNAL_URL`, which Render sets automatically),
    so once it's awake it stays awake. This keeps a free instance running ~24/7,
    which uses most of the free monthly instance-hours (~730 of 750) — fine for a
    single service. It keeps an awake instance warm but can't wake a fully-slept
    one; a free external uptime monitor (UptimeRobot, cron-job.org) hitting
    `/healthz` adds that. For a guaranteed always-on radar, the **Starter** plan
    (~$7/mo) is the clean answer.
  - Health check path is **`/healthz`** (unauthenticated 200) so the service stays
    healthy even with `AUTH_PASS` set.
- **💾 Ephemeral filesystem.** `config.json` (alert rules + delivery config) is
  wiped on every deploy/restart. Use env vars for API keys (durable). To persist
  rules/delivery, attach a **disk** and set `CONFIG_PATH=/data/config.json`
  (the `disk` block in `render.yaml` is ready to uncomment).
- **⏱ Shared datacenter IP.** GeckoTerminal / CoinGecko / GitHub free tiers are
  IP-rate-limited; a busy Render IP can throttle sooner. The free CoinGecko Demo
  key and a GitHub token help. (This is the same free-tier reality noted in
  `HANDOFF.md §6`.)
- **Guardrails unchanged:** non-custodial (the user's Phantom signs; the server
  never holds keys), no financial advice. Hosting doesn't change that.

## 5. After it's live

Open `https://<your-service>.onrender.com` — it'll prompt for the password if you
set `AUTH_PASS`. Everything is relative-pathed, so no config change is needed for
the new origin. Verify the tabs load and `https://…/news` returns JSON.
