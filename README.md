# CryptoWatch — live launch radar + crypto research terminal

A zero-dependency web app that fuses two things under one roof:

- **Launch side** — brand-new token launches across every chain, seconds after
  they go live, with on-chain rug/safety checks, real-time alerts + delivery, and
  a non-custodial swap.
- **Research side** — the full ~17k-coin market universe, a clustered multi-source
  news engine, an AI research layer (sentiment, trending narratives, digests), and
  primary sources (governance + developer activity) — all wired into a **unified
  per-asset page** that shows everything we know about one coin in one place.

Built on free public APIs (no key required to run) with optional keys to lift
rate limits and turn on the AI features. Node's built-in `http`/`fetch` only —
**no framework, no build step, no runtime npm dependencies.**

> ⚠️ **Data only — not financial advice and not a safety guarantee.** The vast
> majority of brand-new tokens are scams or rugs. Every risk signal here is a
> heuristic or an on-chain read, never a recommendation. Always verify on-chain
> before acting. The app is **non-custodial** — it never holds keys, signs, or
> moves funds; your own wallet signs every trade.

---

## Run

```bash
node server.js           # defaults to http://localhost:4000
PORT=4010 node server.js # or pick a port (the server reads $PORT)
```

Needs **Node 18+** (for built-in `fetch`). No `npm install` required to run the
server — the only dependency, `@solana/web3.js`, is vendored into
`public/vendor/` and used purely client-side for the swap UI.

To deploy it to the cloud (Render), see **[DEPLOY.md](DEPLOY.md)**.

---

## Features

### 🚀 New launches / 🔥 Trending
Cross-chain new pools from GeckoTerminal, pushed to the browser over
Server-Sent Events. Rows show live-ticking age, price, liquidity, 1h volume, 1h
buy/sell counts, 5m change, a **risk score (0–100)**, safety badge, flags, and
GT/DEX links. Sortable columns; filters for search, chain, min liquidity, min
volume, and "hide no-sells". Trending mirrors GeckoTerminal's trending pools.

The **risk score** is a *heuristic* read of liquidity depth, FDV/liquidity ratio,
buy/sell flow, and volume/liquidity ratio — higher = healthier-*looking*. It says
nothing about a contract's actual honeypot/rug risk; that's the safety check.

### 🛡 Safety check (per launch, on-demand)
The checks that actually catch rugs:
- **Solana** (public RPC): mint authority renounced?, freeze authority present?,
  SPL vs. Token-2022 (transfer fees/hooks), best-effort holder concentration.
- **EVM — ETH / BSC / Base** (honeypot.is): live buy/sell **simulation** (can you
  actually sell?), buy/sell/transfer taxes, verified-source status.
- **LP lock / burn** (EVM, public RPC): for V2-style pairs the pair contract *is*
  the LP token, so we read how much of its supply is burned/locked (UNCX / Team
  Finance / PinkLock). ≥95% secured → good; a failed read reports *unknown*, never
  a fake 0%. V3 (NFT positions) and Solana get an honest "not readable this way".

Rolls up to a **PASSED / CAUTION / DANGER** badge, cached 60s.

### 🔔 Alerts + delivery
Rule builder (chain, min liquidity, min 1h volume, max age, min risk, and a
**safety gate**: off / block DANGER / PASSED-only). Every new launch is matched
server-side using data already in hand; only cheap-passing candidates get a deep
safety check, capped per cycle to respect rate limits. Matches fire a **browser
notification + sound + live feed**, and can be delivered **tab-closed** via
**Telegram**, **Discord**, or a **generic webhook**. Rules + delivery persist in
a gitignored `config.json` (secrets masked on read, never sent to the browser).

### 📊 Markets
The whole tradable universe via CoinGecko — **250/page** across ~60 pages of
~17,800 coins, with page-number pagination + jump box. **Universe-wide sort**
presets (Top/Low cap, Top/Low volume) reorder *all* coins server-side; a **range
filter** (cap tiers + custom min/max cap + min 24h volume floor) hides dead $0
coins. ★ **Watchlist** (localStorage) stars coins and filters Markets/News down
to what you follow.

### 📰 News & research
**11 RSS sources** (CoinDesk, Cointelegraph, Decrypt, The Block, Bankless, DL
News, The Defiant, CryptoSlate, Protos, BeInCrypto, CryptoPotato) → a rolling
~500-item index that:
- **Clusters duplicate stories** — one event across N outlets = one card ("+N
  more · sources").
- **Topic tags** (Regulation, Security, DeFi, L2s, Macro, Funding, Unlocks, …)
  with filter chips.
- **Asset detection** — coins in a headline become clickable **$SYMBOL** tags that
  open that coin's page (news ↔ data fusion).
- **Sentiment dot** per story, full-text search, and a source filter.

### 🧠 Research (AI research layer)
Synthesis over the live news index:
- **Market mood** — a lexicon sentiment gauge (risk-on / risk-off / mixed) over
  recent clustered headlines. *Free, always-on.*
- **Trending narratives** — topic momentum (last 6h vs. prior), ranked by current
  volume then acceleration, each with sentiment, sample headlines, and the assets
  riding the wave. *Free heuristic.*
- **Most-mentioned assets** — coins ranked by news mentions.
- **"What matters now" digest** — a Claude-written briefing over the top stories.
  *Optional Claude key.*
- **Per-story "why it matters"** — a 🧠 button on each News card for a 1–2 sentence
  significance read. *Optional Claude key.*

### 📡 Signals (primary sources)
Straight-from-the-source data:
- **Governance** — live active DAO proposals from **Snapshot**, biggest-DAO-first,
  with time-to-close and vote counts.
- **Developer activity** — **GitHub** shipping velocity for major protocols:
  commits in the last 7 days, stars, open issues, last push (optional GitHub token
  lifts the rate limit).
- **Funding** & **Unlocks** — surfaced from the news index (raises/rounds, and
  unlock/vesting mentions). A *structured* rounds/unlock calendar needs a paid data
  key — the hook is staged.

### 💱 Swap (non-custodial — Solana via Jupiter)
Turn a spotted token into a trade without leaving the app. Connect **Phantom**,
pick Buy/Sell + amount + max slippage, see a live Jupiter quote (output, price
impact, min received, hops). The server only fetches routes and builds an
**unsigned** transaction; your Phantom wallet signs and sends it. Solscan link on
submit. **The server never holds keys, signs, or sends funds.** (EVM swaps via
0x/1inch + MetaMask are the next stage.)

### 🔗 Unified asset page (the capstone)
Click any coin — from Markets, a News `$SYMBOL` tag, or the Research board — and
get **one research surface** that fuses everything for that coin:
- price + 7-day chart with **"what moved price"** news markers, 24h/7d/30d, a stat
  grid, description, links;
- **Live market** — a real-time **price + trade tape** streamed from a **Coinbase
  WebSocket** (client-side; green/red buy-sell prints), for major Coinbase-listed
  assets;
- **On-chain & trade** — every supported-chain contract, each with the *same rug
  safety check used on new launches* run inline, plus a non-custodial **Swap** on
  Solana;
- **Developer activity** — the coin's GitHub repo (auto-detected from CoinGecko),
  commits/7d, stars, issues, last push;
- **Governance** — the DAO's recent Snapshot proposals (active/closed + votes);
- **In the news** — per-asset clustered mentions.

Mapping is automatic where CoinGecko provides it (GitHub repo + contract
addresses); Snapshot spaces are a curated map of the major DAOs.

### 🧠 AI features (optional Claude key)
An optional Anthropic key powers five features, all guardrailed to **describe only
— no buy/sell calls, no price predictions, not financial advice** (enforced in the
system prompt):
1. **AI risk read** — turns a launch's on-chain safety signals into a plain-English
   verdict ending in "Bottom line:".
2. **"What matters now" digest** — a briefing over the top news stories.
3. **Per-story "why it matters"** — significance of a single headline.
4. **Asset explainer** — "what is this coin / what's its state" on any coin page.
5. **Natural-language screener** — type what you're looking for on the Markets tab
   ("small-caps under $50M with high volume") and Claude sets the cap/volume/sort
   filters for you.

Calls are made **server-side** (`/ai/*`) with `claude-opus-5`; the key is stored in
the gitignored `config.json` (or an env var), masked on read, and never sent to the
browser. No key → the features stay off and everything else works.

---

## Optional keys

All free-tier with no key. Add these (in-app UI **or** env var; stored gitignored +
masked) to lift limits / enable AI:

| Key | Enables | Env var |
|---|---|---|
| **CoinGecko** (Demo or Pro) | Lifts the Markets rate limit | `COINGECKO_API_KEY` / `COINGECKO_PLAN` |
| **Anthropic / Claude** | AI risk read + digest + "why it matters" | `ANTHROPIC_API_KEY` |
| **GitHub token** | Lifts GitHub's 60 req/hr for dev activity | `GITHUB_TOKEN` |
| **Telegram / Discord / webhook** | Alert delivery | (set in the Alerts tab) |

For **public hosting**, set **`AUTH_PASS`** to password-gate the whole site (it
exposes key-funded AI + config endpoints). See [DEPLOY.md](DEPLOY.md).

---

## Data sources (all free, no key required to run)

GeckoTerminal (launches/trending) · honeypot.is (EVM safety) · Solana &
EVM public RPCs · CoinGecko (markets/asset/global) · Jupiter (swap) · 11 news RSS
feeds · Snapshot (governance) · GitHub (dev activity) · Anthropic (optional AI).

## Architecture

```
free public APIs ──poll──▶  server.js (Node, in-memory buffers, zero deps)
                               │  Server-Sent Events (/stream) + REST endpoints
                               ▼
                          public/index.html (self-contained tabbed SPA)
```

- `server.js` — poll loops, normalization, risk scoring, safety checks, alerts +
  delivery, markets/news/research/signals/swap/AI endpoints, SSE, static serving.
- `public/index.html` — the entire UI (HTML/CSS/vanilla JS, no build step).

There's a fuller engineering handoff in [HANDOFF.md](HANDOFF.md).

## Roadmap

- **EVM swaps** (0x/1inch + MetaMask) — the second half of the swap feature.
- **Structured funding/unlock calendar** — needs a paid data key (DefiLlama Pro /
  CryptoRank / Token Unlocks); the hooks are staged.
- **Persist the launch stream** for backtesting which signals preceded winners vs.
  rugs.
- **Sub-second launch latency** via a paid provider / node WebSocket (Helius /
  Birdeye / Bitquery).
