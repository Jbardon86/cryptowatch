# CryptoWatch — live crypto launch radar

A zero-dependency dashboard that streams **brand-new token launches across every
chain**, seconds after they go live, plus a Trending view. Built on GeckoTerminal's
free public API (no key required) with DexScreener links for deeper inspection.

![new launches, seconds old, with liquidity/volume/flow and a risk read]

## Run

```bash
node cryptowatch/server.js
# open http://localhost:4000
```

No `npm install` — it uses only Node's built-in `http`/`fetch` (needs Node 18+).

## What it does

- **New launches tab** — polls GeckoTerminal `new_pools` (cross-chain) every 5s,
  dedupes by pool, and pushes fresh launches to the browser over Server-Sent
  Events. Rows show age (live-ticking), price, liquidity, 1h volume, 1h
  buy/sell counts, 5m price change, a **risk score**, and flags.
- **Trending tab** — GeckoTerminal `trending_pools`, refreshed every 20s.
- **Filters** — search by name/token address, chain, min liquidity, min 1h
  volume, and a "hide no-sells" toggle.
- **Sorting** — click any numeric column header (Price, Liquidity, Vol 1h,
  Δ 5m, Risk, Age) to sort; click again to flip direction. A ▲/▼ marks the
  active column. Default (unsorted) is newest-first on the New tab.
- **Risk score (0–100)** — a *heuristic* read of liquidity depth, FDV/liquidity
  ratio, buy/sell flow, and volume/liquidity ratio. Higher = healthier-looking.
- **Deep safety check (per row, on-demand)** — click 🛡 on any row to run the
  checks that actually catch rugs, then expand the checklist:
  - **Solana** (public RPC, no key): mint authority renounced?, freeze authority
    present?, standard SPL vs. Token-2022 (transfer fees/hooks), and best-effort
    holder concentration.
  - **EVM — ETH / BSC / Base** (honeypot.is): live buy/sell **simulation**
    (can you actually sell?), buy/sell/transfer taxes, and verified-source status.
  - **LP lock / burn** (EVM, via public RPC): for UniswapV2-style pairs the pair
    contract *is* the LP token, so we read how much of its supply sits in burn
    addresses or major lockers (UNCX / Team Finance / PinkLock). ≥95% secured →
    good; a failed read reports *unknown*, never a fake 0%. V3 pools (NFT
    positions) and Solana report an honest "not readable this way" note.
  - Results roll up to a **PASSED / CAUTION / DANGER** badge and are cached 60s.
- **Real-time alerts** — the 🔔 Alerts tab lets you define rules (chain, min
  liquidity, min 1h volume, max age, min risk score, and an optional **safety
  gate**: off / block DANGER / PASSED-only). Every new launch is matched against
  enabled rules server-side using data we already have (no extra API calls);
  only the few that clear those gates get a deep safety check, capped per cycle
  to respect rate limits. Matches fire a **browser notification + sound** and
  drop into a live, grade-color-coded feed.
- **Alert delivery — Telegram / Discord / Webhook** — configure any of the three
  in the Alerts tab so matches reach you even with the tab closed. Telegram
  (bot token + chat id), Discord (channel webhook URL), or a generic webhook
  that receives a JSON POST `{event, pool, ruleName, safety, at}` per alert.
  "Send test" verifies wiring. Secrets are never logged and are masked on read
  (the API returns `tokenSet: true`, never the value).
- **Config persists across restarts** — alert rules and delivery settings are
  saved to `config.json` on every change and reloaded at startup, so your setup
  survives a restart. That file holds delivery secrets, so it's **gitignored**;
  it's created on first change and absent until then.

## Markets intelligence (Messari-style)

Beyond new launches, the app has a market-intelligence side for established assets:

- **📊 Markets** — a deep, market-cap ranked table of the whole tradable
  universe (CoinGecko free API): logo, price, 1h/24h/7d change, market cap, 24h
  volume, and a 7-day sparkline. Loads **250 at a time** with a **Load more**
  button to page as deep as you want (out of ~17,000+ coins tracked; the header
  shows "N shown · M loaded of ~Total tracked"). Click any row for its detail page.
  - **Universe-wide sort**: the **Top cap / Low cap ↑ / Top volume / Low volume**
    presets (and the Market Cap / Volume column headers) re-order *all* ~17k
    coins server-side and reload from page 1 — so "Low cap ↑" surfaces the true
    smallest coins in one fetch, not just a re-sort of what's loaded. Columns
    CoinGecko can't order by (price, % change) sort the loaded rows only.
  - **Page numbers**: 250 coins per page with a `Prev · 1 2 … 59 60 · Next`
    bar and a jump-to-page box — navigate the whole ~60-page universe directly.
  - **Range filter**: cap-tier buttons (Micro <$1M / Small $1M–$50M / Mid /
    Large), custom min/max market cap, and a **min 24h volume** floor (accepts
    shorthand like `50k`, `5m`). The volume floor hides dead $0 coins so "low
    cap" surfaces real, liquid small-caps. Filters the current page; sort +
    page to browse a whole tier.
- **Asset detail** — click any coin for a full profile: 7-day price chart, big
  price + 24h/7d/30d change, a stat grid (market cap, volume, circ/max supply,
  ATH/ATL, 24h high/low), a description, and links (website, X, CoinGecko).
- **📰 News & research** — a real research surface, not a flat feed. Aggregates
  **11 sources** (CoinDesk, Cointelegraph, Decrypt, The Block, Bankless, DL News,
  The Defiant, CryptoSlate, Protos, BeInCrypto, CryptoPotato) into a rolling
  ~500-item index, then:
  - **Clusters duplicate stories** — one event reported by N outlets becomes a
    single card showing "+N more · sources" (title-token similarity).
  - **Topic tags** — auto-classified (Regulation, Security, DeFi, L2s, Macro,
    Funding, …) with filter chips.
  - **Asset detection** — coins named in a headline become clickable **$SYMBOL**
    tags that **open that coin's Markets detail** (news ↔ live-data fusion).
  - **Full-text search** across headlines, summaries, and detected assets, plus
    a source filter.
- **News ↔ data fusion** — the research bridge no feed has:
  - **Per-asset news** on every coin's Markets detail page (`/news/asset`).
  - **"What moved price"** — each mention is plotted as an **amber marker on the
    7-day price chart** at its headline time (hover for the title), so you can
    see which news preceded a move.
  - **Watchlists** (localStorage) — ★ any coin from a Markets row or its detail
    page, then filter **Markets** (★ Watchlist) and **News** (★ Watched) down to
    what you follow.

All three are cached server-side to stay within free rate limits.

**Optional CoinGecko key** — Markets works with no key (anonymous public tier),
but that tier is rate-limited. Add a key to lift the ceiling via the **⚙ API key**
button on the Markets tab (or the `COINGECKO_API_KEY` / `COINGECKO_PLAN` env
vars). Supports both the free **Demo** tier (public host, `x-cg-demo-api-key`)
and paid **Pro** (pro host, `x-cg-pro-api-key`); a UI value overrides the env
var. The key is persisted in the gitignored `config.json`, masked on read
(`keySet: true`), and never sent to the browser. Changing it clears the market
caches so it takes effect immediately.

## Swap (non-custodial — Solana via Jupiter)

Turn a spotted launch into a trade without leaving the app. The **💱 Swap** tab
(and a green **Swap** button on every Solana launch row) opens a swap panel:

- **Connect Phantom** — your wallet holds the keys and signs every transaction.
- **Buy / Sell**, amount, and **max-slippage** control (0.5–10%).
- Live **Jupiter** quote: estimated output, price impact, min received, hop count.
- On Swap, the server asks Jupiter to **build an unsigned transaction**; your
  Phantom wallet signs and sends it. A Solscan link confirms submission.

**The server never holds keys, never signs, and never sends funds** — it only
fetches routes and builds unsigned transactions (`/swap/quote`, `/swap/build`).
This is the standard non-custodial DEX-frontend model. `@solana/web3.js` is
vendored locally (`public/vendor/`, no CDN) to deserialize the transaction for
Phantom.

> Status: **Solana (Jupiter) is built and verified through the quote/build
> flow.** The final wallet-signing step needs a real browser with the Phantom
> extension. **EVM swaps (0x/1inch + MetaMask) are the next stage.**

## AI risk read (Claude — optional)

With an optional Anthropic API key, each launch's safety check gains a
**🧠 AI risk read** button. Claude (`claude-opus-5`) reads the raw on-chain
signals — honeypot sim, LP-lock/burn, mint/freeze authority, liquidity, holder
concentration — and writes a short plain-English risk verdict ending in a
"Bottom line:". It describes risk only: **no buy/sell calls, no price
predictions, not financial advice** (enforced in the system prompt).

- Set the key under **Alerts ▸ AI risk analysis** (or the `ANTHROPIC_API_KEY`
  env var). No key → the button is replaced by a hint; nothing calls out.
- The call is made **server-side** via `/ai/risk`; the key is stored in the
  gitignored `config.json`, masked on read, and never sent to the browser.
- Verdicts are cached 5 min per token. Cost is a fraction of a cent per read.

> Status: **built and verified through the request pipeline** (the bogus-key
> test returned Anthropic's own `invalid x-api-key`, proving the call is wired).
> Add your key to get live verdicts. The other three AI features — asset
> explainer, news digest, and a natural-language screener — are the next stage.

## ⚠️ Important

This surfaces **data only — it is not financial advice and not a safety
guarantee**. The vast majority of brand-new tokens are scams or rugs. The deep
safety check is a strong first filter (it reads real on-chain authority state,
simulates trades, and measures LP burn/lock), but it is NOT a full audit: it
does not yet detect malicious proxy-upgrade paths, every Token-2022 hook, or
lockers outside the tracked set, and LP-lock is EVM-only. Always verify
on-chain before acting.

## Architecture

```
GeckoTerminal free API  ──poll──▶  server.js (Node, in-memory buffer)
                                       │  Server-Sent Events (/stream)
                                       ▼
                                  public/index.html (live table)
```

- `server.js` — poll loops, normalization, risk scoring, SSE broadcast, static serving.
- `public/index.html` — self-contained UI (HTML/CSS/JS, no build step).

## Where to take it next (v2)

Free tier is rate-limited (~30 req/min) and latency is ~2–10s. To get true
sniping latency and real safety checks:

1. **Paid provider / node WebSocket** — Helius (Solana), Birdeye, Moralis,
   Bitquery, or a raw RPC log subscription. Sub-second, push instead of poll.
   A dedicated RPC key also fixes the public-RPC rate-limiting on holder lookups.
2. **Finish the safety layer** — mint/freeze authority, honeypot simulation,
   taxes, and EVM LP-lock/burn are done (see above). Still to add: **Solana
   LP-burn** (needs a Solana LP indexer), a broader locker registry, V3 position
   locks, and proxy-upgrade / ownership-takeback checks.
3. **Backtesting store** — persist the launch stream itself (not just config)
   so you can replay history and test which signals preceded winners vs. rugs.
4. **Multi-user / auth** — today it's single-user local. Sessions + per-user
   config would make it shareable.
