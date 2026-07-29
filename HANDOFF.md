# CryptoWatch — Project Handoff

A single-file context doc to continue this project in a fresh chat. Everything
below reflects what is **actually built and verified** as of this handoff.

---

## 1. What it is

**CryptoWatch** is a live crypto **launch radar + market-intelligence + research
terminal**, all in one app. It spans two worlds under one roof:

- **Launch side:** new tokens seconds after they launch (cross-chain), risk
  scoring, on-chain safety/rug checks, real-time alerts + delivery, and a
  non-custodial swap.
- **Research side:** the full ~17k-coin market universe, asset detail pages with
  charts, and a clustered multi-source news engine fused with live market data.

**Goal (owner's words):** make it the most sophisticated site for crypto
**knowledge and research**, and give a trading/sniping edge on new launches.

**Guardrails (held throughout):**
- **Non-custodial** — the app never holds keys, signs, or moves funds. The
  user's own wallet signs every trade.
- **No financial advice** — everything surfaces *data and risk signals only*.
  No buy/sell calls, no price predictions. This is enforced even in the AI
  system prompt.

---

## 2. Where it lives & how to run

- **Location:** `/Users/jeffbardon/valadate/cryptowatch/` (inside the `valadate` repo).
- **Files:**
  - `server.js` — the entire backend (zero npm deps; Node 18+ built-in `http` + `fetch`).
  - `public/index.html` — the entire frontend (one self-contained file: HTML + CSS + vanilla JS).
  - `public/vendor/solana-web3.js` — vendored `@solana/web3.js` UMD (for swap tx deserialize). `node_modules/` is gitignored.
  - `config.json` — runtime config + secrets (**gitignored**, created on first change).
  - `.claude/launch.json` (repo root) — has a `cryptowatch` entry: `node .../cryptowatch/server.js`, port 4000.
- **Run:**
  ```bash
  node cryptowatch/server.js              # defaults to http://localhost:4000
  PORT=4010 node cryptowatch/server.js    # or pick a port (server reads $PORT)
  ```
  Port **4000 is only the default** (`PORT` env var overrides it) — e.g. this was
  last run on **4010** to sit beside another instance. Open whatever port you started.
- **Architecture:** server polls free APIs, holds an in-memory buffer, pushes new
  launches to the browser over **Server-Sent Events** (`/stream`). Frontend is a
  tabbed SPA. No build step.

---

## 3. Tabs / features

All are **built**. "Verified" varies by what the env allows: most are verified
against **live data**; the paid/keyed paths (Phantom swap signing, Telegram/
Discord delivery, all Claude AI features) are **pipeline-verified only** — each
returns the correct upstream error with a bad/absent credential, proving the
wiring, and goes live with the owner's own key. Each item notes which below.

### 🚀 New launches / 🔥 Trending
- Live cross-chain new pools from **GeckoTerminal** (`new_pools` / `trending_pools`), pushed via SSE.
- Columns: age (live-ticking), token, chain/DEX, price, liquidity, 1h vol, buys/sells, Δ5m, **risk score** (0–100 heuristic), safety check, flags, links.
- **Click-to-copy**: token address AND pool address (separate ⧉ buttons, "copied ✓").
- **Sortable** numeric columns; filters (search, chain, min liq, min vol, hide "no sells").
- Green **Swap** button on Solana rows (see Swap).

### 🛡 Safety check (per launch, on-demand)
- **Solana** (public RPC): mint authority, freeze authority, SPL vs Token-2022, best-effort holder concentration.
- **EVM (ETH/BSC/Base)** (honeypot.is): buy/sell **simulation** (honeypot?), taxes, verified source.
- **LP-lock/burn** (EVM, public RPC): reads how much of the LP token supply is in burn addresses / known lockers (UNCX, Team Finance, PinkLock). ≥95% secured = good; failed read = *unknown* (never a fake 0%). V3 & Solana = honest "N/A".
- Rolls up to **PASSED / CAUTION / DANGER**. Verified against LADYS (burned), MOG (UNCX-locked), PEPE (unsecured), TURBO (V3).

### 🔔 Alerts
- Rule builder: chain, min liquidity, min 1h vol, max age, min risk, **safety gate** (off / block DANGER / PASSED-only).
- Engine evaluates every new launch against rules using data already in hand (no extra API calls); only cheap-passing candidates get a deep safety check, capped per cycle.
- Matches → **browser notification + sound + live feed**.
- **Delivery** (server-side, so alerts reach you tab-closed): Telegram (bot token + chat id), Discord (webhook), generic webhook (`{event,pool,ruleName,safety,at}`). "Send test" verifies. **Webhook path verified end-to-end; Telegram/Discord use the same code path.**
- Rules + delivery persist in `config.json` (secrets masked on read).

### 💱 Swap (non-custodial — Solana via Jupiter)
- 💱 Swap tab + per-Solana-row Swap button → shared panel: connect **Phantom**, Buy/Sell, amount, slippage, **live Jupiter quote** (out/impact/min-received/hops).
- Server only fetches route + builds an **unsigned** tx (`/swap/quote`, `/swap/build`, `/swap/mint`); the user's Phantom signs & sends. Solscan link on submit.
- **Verified through the quote/build pipeline** (0.5 SOL → 12.75M BONK). The final Phantom **signing needs a real browser with the extension** — not testable in the automation env, and the assistant won't execute trades regardless.
- **EVM swaps (0x/1inch + MetaMask) are NOT built** — staged next for the swap feature.

### 📊 Markets (Messari-style, deep)
- Full universe via **CoinGecko** (`/coins/markets`), **250/page** with **page-number pagination** (jump box) across ~60 pages of ~17,850 coins.
- Universe-wide **sort presets** (Top cap / Low cap ↑ / Top volume / Low volume) — reorder ALL coins server-side. Column headers for cap/volume also sort universe-wide; price/%change sort the loaded page.
- **Range filter**: cap tiers (Micro/Small/Mid/Large) + custom min/max cap + **min 24h volume** floor (hides dead $0 coins). Shorthand accepted (`50k`, `5m`).
- **Unified asset page** (the capstone — click any coin): the asset modal fuses
  **everything** we have for one coin into a single research surface:
  - price + 7d chart (with news "what moved price" markers), 24h/7d/30d, stat grid,
    description, links;
  - **On-chain & trade** — every supported-chain contract (from CoinGecko
    `platforms`) with the **same rug safety check used on new launches** run inline
    (mint/freeze, honeypot sim, LP-lock…) and a **non-custodial Swap** on Solana;
  - **Developer activity** — the coin's GitHub repo (from CoinGecko
    `links.repos_url.github`, automatic): commits/7d, stars, issues, last push;
  - **Governance** — the DAO's recent Snapshot proposals (active/closed + votes),
    via a curated CoinGecko-id → Snapshot-space map (`COIN_SNAPSHOT`);
  - **Live market** — real-time **price + trade tape** via a **Coinbase WebSocket**
    (`wss://ws-feed.exchange.coinbase.com`, `<SYM>-USD`, `ticker`+`matches`),
    opened **client-side** in the browser (keeps the server zero-dep; Coinbase is
    US-reliable, unlike Binance). Green/red buy-sell tape, live-flashing price,
    graceful "no feed for this pair" fallback, WS closed on modal close. Verified
    live in-browser (BTC/ETH streaming). Only major Coinbase-listed pairs have a
    feed; everything else still shows the CoinGecko chart.
  - **In the news** — per-asset clustered mentions.
  - **🧠 Explain this asset** — AI plain-English "what is this / what's its state"
    from the page's own data (optional Claude key; `/ai/explain`).
  - Mapping is automatic where CoinGecko provides it (GitHub repo, contracts);
    Snapshot spaces are curated for the majors (long-tail coins have none).
    Endpoints reused/added: `/asset` (enriched), `/dev/repo`, `/gov/space`,
    `/safety`, swap. All free-tier. Verified live (Aave: 4 chains, safety PASSED,
    Aave DAO proposals; Chainlink: 33 commits/7d, no gov space → section hidden).
- **★ Watchlist** (localStorage): star coins from rows or the detail; "★ Watchlist" filter.

### 📰 News & research
- **11 RSS sources** (CoinDesk, Cointelegraph, Decrypt, The Block, Bankless, DL News, The Defiant, CryptoSlate, Protos, BeInCrypto, CryptoPotato) → rolling ~500-item index.
- **Clusters duplicate stories** (title-token Jaccard) → one card with "+N more · sources". Verified 4-outlet dedup.
- **Topic tags** (Regulation, Security, DeFi, L2s, Macro, Funding, …) with filter chips.
- **Asset detection** → clickable **$SYMBOL** tags that open the coin's Markets detail (news↔data fusion).
- **Full-text search** + source filter.
- **News ↔ data fusion (Pillar 2):**
  - **Per-asset news** on every coin detail page (`/news/asset?id=`).
  - **"What moved price"** — each mention is an **amber marker on the 7-day chart** at its headline time (hover = title).
  - **Watchlists tie in**: "★ Watched" news filter shows only stories about coins you follow.

### 🧠 AI risk read (optional Claude key)
- On a launch's safety check, a **🧠 AI risk read** button → Claude (`claude-opus-5`) turns the on-chain signals into a plain-English risk verdict ending in "Bottom line:". No buy/sell/price/advice (system-prompt enforced).
- Server-side call (`/ai/risk`), key stored in `config.json`, masked, never sent to browser.
- **Verified through the request pipeline** (bogus key → Anthropic's own `invalid x-api-key`, proving wiring). **Live verdicts need the owner's Anthropic key** (none in the env).

### 🧠 Research (Pillar 3 — AI research layer)
- **Market mood** — a lexicon sentiment read over the clustered news index → a
  risk-on / risk-off / mixed gauge with a dial (free, always-on). Every News
  card also gets a colored sentiment dot.
- **Trending narratives** — topic momentum: clusters in the last 6h vs. the
  prior window, ranked by current volume then acceleration, each with sentiment,
  sample headlines, and the assets riding the wave (free heuristic, no key).
- **Most-mentioned assets** — coins ranked by news mentions, click-through to the
  Markets detail.
- **"What matters now" digest** — a Claude-written briefing (4–6 themes) over the
  current top stories; cached ~10m keyed to the front page so it re-bills only
  when the news moves. **Optional Claude key.**
- **Per-story "why it matters"** — a 🧠 button on each News card → 1–2 sentence
  significance read from Claude, cached 1h. **Optional Claude key.**
- Guardrails held: synthesis/description only, no advice, no price calls
  (system-prompt enforced). **Digest + why-it-matters verified through the
  pipeline** (bogus key → Anthropic's own `invalid x-api-key`).

### 📡 Signals (Pillar 4 — primary sources)
- **Governance** — live **active DAO proposals** from **Snapshot** (public
  GraphQL, free): ranked biggest-DAO-first (by follower count), with
  time-to-close, vote counts, and a link. Verified live.
- **Dev activity** — **GitHub** shipping velocity for ~14 major protocols:
  commits in the last 7d (bar), stars, open issues, last push. Cached 30m;
  unauth GitHub is ~60 req/hr, so an **optional GitHub token** (env `GITHUB_TOKEN`
  or UI) lifts it. Verified live.
- **Funding** and **Unlocks** — surfaced free from the news index (a new
  "Unlocks" topic tag joins the existing "Funding" one). Honest UI note: a
  structured rounds/unlock calendar (amounts, dates, % supply) needs a paid data
  key — **DefiLlama gated its free `raises`/`emissions` feeds** during this
  build, so those hooks are staged, not wired.

---

## 4. Endpoint map (server.js)

| Endpoint | Purpose |
|---|---|
| `GET /stream` | SSE: `snapshot`,`new`,`trending`,`rules`,`alerts_snapshot`,`alert`,`status` |
| `GET /safety?network=&token=` | Deep safety/rug check |
| `GET/POST /alerts/rules` | Alert rules |
| `GET/POST /alerts/delivery`, `POST /alerts/delivery/test` | Telegram/Discord/webhook delivery |
| `GET /markets?page=&order=` | Paginated market rankings |
| `GET /global` | Universe size (active coins, total mcap) |
| `GET /asset?id=` | Coin detail + 7d chart (`chartStart/chartEnd` for markers) |
| `GET/POST /markets/config` | Optional CoinGecko key (demo/pro) |
| `GET /news` | Clustered news `{clusters,topics,sources,total,mood}` (+per-cluster `sentiment`) |
| `GET /news/asset?id=` | News clusters mentioning a coin |
| `GET /narratives` | Trending narratives (topic momentum) + top assets + mood |
| `GET/POST /ai/config`, `POST /ai/risk` | Optional Claude key + AI risk verdict |
| `GET /ai/digest` | AI "what matters now" briefing (optional key) |
| `POST /ai/why` | AI per-story "why it matters" (optional key) |
| `POST /ai/explain` | AI "what is this asset" explainer for the coin page (optional key) |
| `POST /ai/screen` | AI natural-language → cap/volume/sort filter for Markets (optional key) |
| `GET /gov` | Snapshot active DAO proposals (all spaces) |
| `GET /gov/space?space=` | One DAO's recent proposals (unified asset page) |
| `GET /dev`, `GET/POST /dev/config` | GitHub dev activity + optional GitHub token |
| `GET /dev/repo?repo=owner/name` | One repo's activity (unified asset page) |
| `GET /asset?id=` | Coin detail — now also returns `githubRepo`, `snapshotSpace`, `contracts` |
| `GET /swap/quote`, `GET /swap/mint`, `POST /swap/build` | Jupiter swap (Solana) |
| `GET /evm/quote`, `GET /evm/swap`, `GET /evm/allowance` | OpenOcean EVM swap (ETH/Base/BSC), keyless |

---

## 5. Data sources & optional keys

**All free, no key required to run:**
- GeckoTerminal (launches/trending) · honeypot.is (EVM safety) · Solana public RPC (`api.mainnet-beta.solana.com`, `solana-rpc.publicnode.com`) · EVM public RPC (`*-rpc.publicnode.com`) · CoinGecko (markets/asset/global) · Jupiter `lite-api.jup.ag` (swap) · 11 news RSS feeds · **Snapshot** `hub.snapshot.org/graphql` (governance) · **GitHub** `api.github.com` (dev activity).

**Optional keys (all wired as optional; env var OR in-app UI; stored gitignored+masked):**
- **CoinGecko** (Markets ▸ ⚙ API key, or `COINGECKO_API_KEY`/`COINGECKO_PLAN`) — lifts markets rate limit. Demo host + `x-cg-demo-api-key`; Pro host + `x-cg-pro-api-key`.
- **Anthropic / Claude** (Alerts ▸ AI risk analysis, or `ANTHROPIC_API_KEY`) — powers AI risk read, the Research **digest**, and per-story **"why it matters"**.
- **GitHub** (Signals ▸ Dev activity ▸ ⚙ token, or `GITHUB_TOKEN`) — lifts GitHub's ~60 req/hr unauth limit for the dev-activity board. Public-repo read scope is enough.
- **Telegram / Discord / generic webhook** — alert delivery.
- **Phantom** wallet — user connects in their browser for swaps.

---

## 6. Constraints & gotchas (important for the next chat)

- **GeckoTerminal free tier ~30 req/min.** Polling tuned to ~22/min with 429 backoff. Bursty testing can temporarily throttle the IP.
- **CoinGecko public tier is rate-limited** (~10–30/min). Deep Markets paging / many asset opens can briefly 502 "rate-limited". A free CoinGecko **Demo key** fixes it. Pages are cached server-side.
- **Public Solana RPC rate-limits `getTokenLargestAccounts`** → holder concentration is best-effort ("unknown" when throttled).
- **GoPlus Security API is network-blocked from this environment** (HTTP 000) — was dropped. That's why LP-lock is done via direct EVM RPC and Solana LP-burn isn't wired.
- **DefiLlama gated its free `raises`/`emissions` endpoints** (now return "Upgrade to the paid API plan") — so the structured funding-rounds and token-unlock calendar have no free source right now. The Signals tab uses news-derived Funding/Unlocks feeds instead; the paid-key hook is the way to light up structured data. Snapshot + GitHub are both free and working.
- **GitHub unauth is ~60 req/hr, shared by IP.** The dev board is 14 repos × 2 calls = 28 per refresh, cached 30m. Heavy testing can exhaust it → repos show an error row until it resets or a token is added (Signals ▸ Dev activity ▸ ⚙ token).
- **No paid keys exist in the dev/test environment** — so the following are verified only through their **pipelines**, not live: Phantom swap **signing**, Telegram/Discord delivery, AI verdicts. Each returns the correct upstream error with a bad/absent credential, proving wiring. The owner tests live with their own keys.
- **`config.json` holds real secrets** (delivery tokens, API keys) in plaintext by design (local persistence) → it is **gitignored**; never commit it, never send it to the browser (masked on read).

---

## 7. Roadmap — what's next

**News/research vision = 4 pillars (owner picked all 4, "free now, wire optional paid keys"):**
1. ✅ **Breadth + organization** — done (11 sources, clustering, tags, search).
2. ✅ **News ↔ data fusion** — done (per-asset news, "what moved price" markers, watchlists).
3. ✅ **AI research layer** — done (🧠 Research tab: market-mood sentiment,
   trending narratives, "what matters now" digest, per-story "why it matters").
   Free layers (mood, narratives) run with no key; digest + why reuse the Claude
   plumbing and light up with the owner's Anthropic key.
4. ◑ **Primary sources** — governance (Snapshot) and dev activity (GitHub) are
   **built & live** (📡 Signals tab); funding + unlocks are surfaced free from the
   news index. **Still open:** a *structured* unlock calendar and funding-rounds
   feed (amounts/dates/investors). DefiLlama paywalled its free `raises`/`emissions`
   during this build — wire a paid data key (DefiLlama Pro, CryptoRank, or
   Token Unlocks) into the ready hooks. Snapshot/GitHub also leave room for
   Tally governance and per-asset repo mapping.

**✅ Unified asset page (capstone) — done.** One coin, one surface: price +
chart + news markers + on-chain safety/swap + GitHub dev activity + Snapshot
governance, auto-fused (see §3 Markets). This is the thing that turned the
separate feeds into one research surface. Remaining polish: extend `COIN_SNAPSHOT`
beyond the ~25 curated DAOs; map to more repos than CoinGecko's single default.

**✅ AI set finished.** All the AI features are now built: risk read, news digest,
per-story "why it matters", **asset explainer** (`/ai/explain`, on the coin page),
and **natural-language screener** (`/ai/screen`, drives the Markets cap/volume/sort
filters). All reuse the one optional Claude key and hold the no-advice guardrails.

**✅ Real-time layer.** Coin pages carry a live **Coinbase WS** price + trade tape
(client-side; see §3). This was the "live trades" ask.

**✅ EVM swaps.** Built (MetaMask + the keyless **OpenOcean** aggregator, since
0x/1inch now need keys). Buy/Sell on ETH/Base/BSC, live quote, ERC-20 approval
flow (allowance check → approve → swap), chain auto-switch. Entry = a "Swap"
button on the asset page's on-chain rows for EVM contracts (`openEvmSwap`).
Quote/build pipeline verified live; signing needs a real MetaMask.

**Other staged items (NOT built):**
- **Structured funding/unlock feeds** — the paid-key half of pillar 4 (see above).
- **Persist launches** for backtesting which signals preceded winners vs rugs.
- **Sub-second launch latency** via a paid provider / node WebSocket (Helius/Birdeye/Bitquery) — also fixes public-RPC throttling.

---

## 8. Quick orientation for a new chat

- The whole app is **two files**: `server.js` and `public/index.html`. Read those first.
- To add a feature: add a server endpoint + a UI section; keep the zero-dependency server ethos (raw `fetch`, no frameworks).
- Optional-key features all follow the **same pattern** (CoinGecko/Claude): `{key}` in `config.json`, env fallback, masked GET, POST to set/clear, cache cleared on change.
- Verify changes by restarting the `cryptowatch` preview and checking the browser (no console errors) + the relevant endpoint via `curl`.
- **Hold the guardrails:** non-custodial, no financial advice, secrets never reach the browser.
