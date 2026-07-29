// CryptoWatch — live new-token-launch radar (zero dependencies, Node 18+)
//
// Polls GeckoTerminal's free cross-chain feeds (no API key), normalizes each
// pool, scores its risk signals, and streams fresh launches to the browser
// over Server-Sent Events. DexScreener links are best-effort by token address.
//
// Run:  node server.js   (then open http://localhost:4000)

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 4000;
const GT = "https://api.geckoterminal.com/api/v2";

// ---- Tunables -------------------------------------------------------------
const NEW_POLL_MS = 6000; // new_pools poll interval (free tier ~30 req/min)
const TREND_POLL_MS = 30000; // trending_pools poll interval
const MAX_BUFFER = 600; // pools kept in memory / replayed to new clients
const MAX_PAGES = 2; // new_pools pages to sweep each cycle (10 pools/page)
// GeckoTerminal free tier is ~30 req/min. Budget: new_pools 2 pages / 6s = 20,
// trending / 30s = 2  ->  ~22/min, leaving headroom. On a 429 we back off.

// ---- In-memory state ------------------------------------------------------
const seen = new Map(); // poolId -> normalized pool (New feed)
const order = []; // poolIds newest-first
const trending = new Map(); // poolId -> normalized pool (Trending feed)
const clients = new Set(); // active SSE responses

// ---- Fetch helper ---------------------------------------------------------
// Retries a couple of times on 429 with a short backoff, since the free tier
// throttles bursts. A GeckoError carries the status so callers can stay quiet.
class GeckoError extends Error {
  constructor(status) {
    super(`GET -> ${status}`);
    this.status = status;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gtGet(url, tries = 3) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.ok) return res.json();
    if (res.status === 429 && attempt < tries) {
      await sleep(attempt * 1500); // 1.5s, 3s backoff
      continue;
    }
    throw new GeckoError(res.status);
  }
}

// ===========================================================================
// SAFETY-CHECK LAYER
// ===========================================================================
// On-demand deep checks for a single token. These are the checks that actually
// catch rugs — an unsellable honeypot, mintable supply, an active freeze
// authority, punitive taxes — which matter far more than raw feed latency.
//
//   Solana  -> public RPC: mint authority, freeze authority, program, holders
//   EVM     -> honeypot.is: buy/sell simulation, taxes, verified source
//
// Still NOT a guarantee: LP-lock detection and full bytecode analysis need
// paid/heavier tooling (see README v2). This is a strong first filter, no key.

const SAFETY_TTL_MS = 60000;
const safetyCache = new Map(); // token -> { result, ts }
const safetyInflight = new Map(); // token -> Promise (dedupe concurrent hits)

const SOL_RPCS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
];
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

// GeckoTerminal network id -> honeypot.is numeric chainID (supported chains).
const HONEYPOT_CHAINS = { eth: 1, ethereum: 1, bsc: 56, base: 8453 };

async function solRpc(method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  for (const url of SOL_RPCS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (!res.ok) continue;
      const json = await res.json();
      if (json.error) continue; // e.g. 429 on a specific method -> try next RPC
      return json.result;
    } catch {
      /* try next endpoint */
    }
  }
  return null;
}

// Roll a set of per-check statuses up into one grade.
function gradeOf(checks) {
  if (checks.some((c) => c.status === "bad")) return "danger";
  if (checks.some((c) => c.status === "warn")) return "caution";
  if (checks.some((c) => c.status === "good")) return "good";
  return "unknown";
}

async function checkSolana(token) {
  const checks = [];
  const info = await solRpc("getAccountInfo", [token, { encoding: "jsonParsed" }]);
  const parsed = info?.value?.data?.parsed?.info;
  if (!parsed) {
    return {
      supported: true,
      grade: "unknown",
      checks: [{ label: "On-chain read", status: "unknown", detail: "Could not read the mint account (RPC busy). Try again." }],
    };
  }

  // Mint authority — can new supply be minted at will?
  if (parsed.mintAuthority == null) {
    checks.push({ label: "Mint authority", status: "good", detail: "Renounced — supply can't be inflated." });
  } else {
    checks.push({ label: "Mint authority", status: "bad", detail: "ACTIVE — owner can mint unlimited new supply and dilute you." });
  }

  // Freeze authority — can your tokens be frozen in your wallet?
  if (parsed.freezeAuthority == null) {
    checks.push({ label: "Freeze authority", status: "good", detail: "None — your tokens can't be frozen." });
  } else {
    checks.push({ label: "Freeze authority", status: "bad", detail: "ACTIVE — owner can freeze your wallet's tokens (soft honeypot)." });
  }

  // Token-2022 can carry transfer fees / transfer hooks.
  if (info.value.owner === TOKEN_2022) {
    checks.push({ label: "Token program", status: "warn", detail: "Token-2022 — may include transfer fees or hooks. Inspect extensions." });
  } else {
    checks.push({ label: "Token program", status: "good", detail: "Standard SPL token." });
  }

  // Holder concentration (best-effort — public RPC rate-limits this call).
  const largest = await solRpc("getTokenLargestAccounts", [token]);
  const supplyRes = await solRpc("getTokenSupply", [token]);
  const supply = Number(supplyRes?.value?.amount || 0);
  if (largest?.value?.length && supply > 0) {
    const top = largest.value.map((a) => Number(a.amount));
    const top1 = (top[0] / supply) * 100;
    const top10 = (top.slice(0, 10).reduce((s, n) => s + n, 0) / supply) * 100;
    let status = "good";
    if (top10 > 80) status = "bad";
    else if (top10 > 50) status = "warn";
    checks.push({
      label: "Holder concentration",
      status,
      detail: `Top holder ${top1.toFixed(1)}%, top 10 ${top10.toFixed(1)}% of supply. (The pool/LP account is usually the largest — verify before judging.)`,
    });
  } else {
    checks.push({ label: "Holder concentration", status: "unknown", detail: "Public RPC rate-limited this lookup — couldn't fetch holders." });
  }

  // LP lock — honest note: on Solana the fungible-LP burn method used for EVM
  // doesn't apply. pump.fun tokens are curve-locked until they graduate; a
  // Raydium LP-burn read needs a Solana LP indexer we don't have on free tier.
  checks.push({
    label: "LP lock",
    status: "info",
    detail: "Solana: pump.fun tokens are bonding-curve-locked pre-graduation; Raydium LP-burn detection isn't wired (needs a Solana LP indexer). The mint/freeze-authority checks above are the primary Solana rug signals.",
  });

  return { supported: true, grade: gradeOf(checks), checks };
}

// ---- LP-lock / burn detection (EVM UniswapV2-style pairs) -----------------
// For a V2 pair, the pair contract IS the fungible LP token. We read what
// share of its supply sits in burn addresses or known lockers — if ~all of it
// is burned/locked, liquidity can't be pulled (the #1 rug vector). V3 pools use
// NFT positions, so this fungible-supply method doesn't apply.
const EVM_RPC = {
  eth: "https://ethereum-rpc.publicnode.com",
  ethereum: "https://ethereum-rpc.publicnode.com",
  bsc: "https://bsc-rpc.publicnode.com",
  base: "https://base-rpc.publicnode.com",
};
const BURN_ADDRS = [
  "0x000000000000000000000000000000000000dEaD",
  "0x0000000000000000000000000000000000000000",
];
// Major liquidity lockers. Non-exhaustive — an LP locked in a locker we don't
// list here reads as "not secured", which errs on the cautious side.
const LOCKERS = {
  eth: [
    "0x663A5C229c09b049E36dCc11a9B0d4a8Eb9db214", // UNCX / Unicrypt V2
    "0xE2fE530C047f2d85298b07D9333C05737f1435fB", // Team Finance
    "0x71B5759d73262FBb223956913ecF4ecC51057641", // Team Finance (legacy)
  ],
  bsc: [
    "0x7ee058420e5937496F5a2096f04caA7721cF70cc", // PinkLock v1
    "0x407993575c91ce7643a4d4cCACc9A98c36eE1BBE", // PinkLock v2
    "0xC765bDB93b0D1c1A88282BA0fa6B2d00E3e0c83", // UNCX BSC
  ],
  base: [
    "0xc4E637D37113192F4F1f060DaEbD7758De7F4131", // UNCX Base
  ],
};
const SEL_TOTAL_SUPPLY = "0x18160ddd";
function balanceOfData(addr) {
  return "0x70a08231" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

async function evmCall(network, to, data) {
  const url = EVM_RPC[network];
  if (!url) return null;
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] });
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      if (res.ok) {
        const j = await res.json();
        if (!j.error && j.result && j.result !== "0x") return BigInt(j.result);
      }
    } catch {
      /* retry */
    }
    if (attempt < 2) await sleep(400);
  }
  return null; // caller must treat null as "couldn't read", NOT as zero
}

async function checkLpLock(network, pairAddress, pairType) {
  if (!pairAddress || !EVM_RPC[network]) {
    return { label: "LP lock", status: "unknown", detail: "No pair address available to inspect." };
  }
  if (pairType && /v3/i.test(pairType)) {
    return { label: "LP lock", status: "unknown", detail: `${pairType} pool — liquidity is held as NFT positions, not a fungible LP token, so burn/lock can't be read this way. Check the position manually.` };
  }
  const total = await evmCall(network, pairAddress, SEL_TOTAL_SUPPLY);
  if (!total || total === 0n) {
    return { label: "LP lock", status: "unknown", detail: "Couldn't read the LP token supply (RPC busy or non-standard pair)." };
  }
  // A failed balance read must NOT be counted as zero — that would fake a
  // "0% secured / rug" verdict. If the burn reads fail, we report unknown.
  let burned = 0n;
  for (const a of BURN_ADDRS) {
    const b = await evmCall(network, pairAddress, balanceOfData(a));
    if (b === null) {
      return { label: "LP lock", status: "unknown", detail: "RPC didn't return LP holder balances — try again in a moment." };
    }
    burned += b;
  }
  let locked = 0n;
  for (const a of LOCKERS[network] || []) {
    const b = await evmCall(network, pairAddress, balanceOfData(a));
    if (b) locked += b; // a missing locker read just under-credits (safe direction)
  }
  const pct = (n) => Number((n * 10000n) / total) / 100;
  const burnedPct = pct(burned);
  const lockedPct = pct(locked);
  const secured = burnedPct + lockedPct;
  const parts = `burned ${burnedPct.toFixed(1)}%, locked ${lockedPct.toFixed(1)}%`;
  if (secured >= 95) {
    return { label: "LP lock", status: "good", detail: `${secured.toFixed(1)}% of LP is secured (${parts}) — liquidity can't be pulled.` };
  }
  if (secured >= 50) {
    return { label: "LP lock", status: "warn", detail: `Only ${secured.toFixed(1)}% of LP secured (${parts}) — the remainder is movable by whoever holds it.` };
  }
  return {
    label: "LP lock",
    status: "bad",
    detail: `${secured.toFixed(1)}% of LP secured (${parts}) — ~${(100 - secured).toFixed(1)}% is unlocked and can be pulled (rug risk). Only major lockers are tracked, so verify manually if you suspect a lock.`,
  };
}

async function checkEvm(token, chainId, network) {
  const url = `https://api.honeypot.is/v2/IsHoneypot?address=${token}&chainID=${chainId}`;
  let data;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    data = await res.json();
  } catch (e) {
    return { supported: true, grade: "unknown", checks: [{ label: "Simulation", status: "unknown", detail: "honeypot.is unreachable — try again." }] };
  }

  const checks = [];
  if (!data.simulationSuccess) {
    checks.push({ label: "Buy/sell simulation", status: "unknown", detail: data.simulationError || "Could not simulate a trade (often means no liquidity yet)." });
    return { supported: true, grade: "unknown", checks };
  }

  // The headline check: can you sell what you buy?
  if (data.honeypotResult?.isHoneypot) {
    checks.push({ label: "Honeypot", status: "bad", detail: "HONEYPOT — the simulation could buy but NOT sell. Do not touch." });
  } else {
    checks.push({ label: "Honeypot", status: "good", detail: "Simulated buy AND sell both succeeded." });
  }

  const sim = data.simulationResult || {};
  const tax = (label, v) => {
    const pct = Number(v) || 0;
    let status = "good";
    if (pct >= 50) status = "bad";
    else if (pct >= 10) status = "warn";
    checks.push({ label, status, detail: `${pct.toFixed(1)}%${pct >= 50 ? " — punitive" : pct >= 10 ? " — high" : ""}` });
  };
  tax("Buy tax", sim.buyTax);
  tax("Sell tax", sim.sellTax);
  if (Number(sim.transferTax)) tax("Transfer tax", sim.transferTax);

  // Verified/open-source source code.
  if (data.contractCode) {
    checks.push({
      label: "Verified source",
      status: data.contractCode.openSource ? "good" : "warn",
      detail: data.contractCode.openSource ? "Contract source is verified/open." : "Contract is NOT verified — code can't be reviewed.",
    });
  }

  // honeypot.is aggregate flags.
  if (Array.isArray(data.flags) && data.flags.length) {
    checks.push({ label: "Analyzer flags", status: "warn", detail: data.flags.join(", ") });
  }
  const risk = data.summary?.risk;
  if (risk) checks.push({ label: "Overall risk (honeypot.is)", status: risk === "high" ? "bad" : risk === "medium" ? "warn" : "info", detail: risk });

  // LP-lock / burn — can the deployer pull liquidity?
  const pairAddress = data.pairAddress || data.pair?.pair?.address;
  const pairType = data.pair?.pair?.type;
  checks.push(await checkLpLock(network, pairAddress, pairType));

  return { supported: true, grade: gradeOf(checks), checks };
}

async function runSafety(network, token) {
  if (network === "solana") return checkSolana(token);
  const chainId = HONEYPOT_CHAINS[network];
  if (chainId) return checkEvm(token, chainId, network);
  return {
    supported: false,
    grade: "unknown",
    checks: [{ label: "Coverage", status: "unknown", detail: `Deep checks aren't wired for "${network}" yet — only Solana and EVM (ETH/BSC/Base). Use the GT/DEX links to inspect manually.` }],
  };
}

async function getSafety(network, token) {
  const key = `${network}:${token}`;
  const hit = safetyCache.get(key);
  if (hit && Date.now() - hit.ts < SAFETY_TTL_MS) return hit.result;
  if (safetyInflight.has(key)) return safetyInflight.get(key);

  const p = runSafety(network, token)
    .then((result) => {
      result.network = network;
      result.token = token;
      result.checkedAt = new Date().toISOString();
      safetyCache.set(key, { result, ts: Date.now() });
      safetyInflight.delete(key);
      return result;
    })
    .catch((e) => {
      safetyInflight.delete(key);
      return { supported: true, grade: "unknown", checks: [{ label: "Error", status: "unknown", detail: e.message }] };
    });
  safetyInflight.set(key, p);
  return p;
}

// ===========================================================================
// ALERTS ENGINE
// ===========================================================================
// Every new launch is evaluated against your rules using data we ALREADY have
// (chain, liquidity, volume, age, risk) — zero extra API calls. Only the few
// that clear those cheap gates get a deep safety check, and only up to a
// per-cycle budget, so we never blow the free rate limits. Matches are pushed
// to the browser over SSE (-> notification + sound + Alerts feed).

let alertRules = []; // [{id,name,enabled,chains,minLiq,minVol,maxAgeSec,minRisk,noRedFlags,requireSafe,safeMode}]
const alerted = new Set(); // "ruleId:poolId" already fired (dedupe)
const alertFeed = []; // recent fired alerts (newest first)
const MAX_ALERT_FEED = 100;
const SAFETY_PER_CYCLE = 6; // cap deep checks triggered per poll cycle

function poolAgeSec(p) {
  return (Date.now() - new Date(p.createdAt).getTime()) / 1000;
}

function matchesCheap(p, r) {
  if (r.chains && r.chains.length && !r.chains.includes(p.network)) return false;
  if (p.liquidityUsd < (r.minLiq || 0)) return false;
  if (p.volumeH1 < (r.minVol || 0)) return false;
  if (r.minRisk && p.riskScore < r.minRisk) return false;
  if (r.maxAgeSec && poolAgeSec(p) > r.maxAgeSec) return false;
  if (r.noRedFlags && p.flags && p.flags.length) return false;
  return true;
}

async function evaluateAlerts(fresh) {
  const active = alertRules.filter((r) => r.enabled);
  if (!active.length) return;
  let budget = SAFETY_PER_CYCLE;

  for (const pool of fresh) {
    for (const rule of active) {
      const key = `${rule.id}:${pool.id}`;
      if (alerted.has(key)) continue;
      if (!matchesCheap(pool, rule)) continue;

      let safety = null;
      if (rule.requireSafe) {
        if (budget <= 0) continue; // out of safety budget this cycle; leave unmarked to retry next cycle
        budget--;
        safety = await getSafety(pool.network, pool.baseTokenAddress);
        const ok =
          rule.safeMode === "passed"
            ? safety.grade === "good"
            : safety.grade !== "danger"; // default: block only DANGER
        if (!ok) {
          alerted.add(key); // failed the gate — don't re-check endlessly
          continue;
        }
      }

      alerted.add(key);
      const alert = {
        poolId: pool.id,
        ruleId: rule.id,
        ruleName: rule.name,
        pool,
        safety,
        at: new Date().toISOString(),
      };
      alertFeed.unshift(alert);
      while (alertFeed.length > MAX_ALERT_FEED) alertFeed.pop();
      broadcast("alert", alert);
      deliver(alert).catch(() => {}); // fire-and-forget outbound delivery
      console.log(`  🔔 ALERT [${rule.name}] ${pool.name} (${pool.network})`);
    }
  }
  if (alerted.size > 5000) alerted.clear(); // simple unbounded-growth guard
}

// ===========================================================================
// ALERT DELIVERY — Telegram / Discord / generic webhook
// ===========================================================================
// Secrets live in memory only, are never logged, and are masked on read. These
// are the USER'S OWN channels, configured and enabled by them; nothing is sent
// until a channel is enabled. A "test" endpoint lets them verify wiring.

const deliveryConfig = {
  telegram: { enabled: false, botToken: "", chatId: "" },
  discord: { enabled: false, webhookUrl: "" },
  webhook: { enabled: false, url: "" },
};

function fmtUsdServer(n) {
  if (!n) return "$0";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + n.toFixed(0);
}

function alertMessage(a) {
  const g = a.safety ? (a.safety.grade || "?").toUpperCase() : "no safety gate";
  return [
    `🚀 ${a.pool.name}  (${a.pool.network} · ${a.pool.dex})`,
    `rule: ${a.ruleName}`,
    `liq ${fmtUsdServer(a.pool.liquidityUsd)} · vol1h ${fmtUsdServer(a.pool.volumeH1)} · risk ${a.pool.riskScore}`,
    `safety: ${g}`,
    a.pool.links.geckoterminal,
  ].join("\n");
}

async function sendTelegram(text) {
  const { botToken, chatId } = deliveryConfig.telegram;
  if (!botToken || !chatId) return { ok: false, error: "missing bot token or chat id" };
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false }),
  });
  if (!res.ok) return { ok: false, error: `Telegram API ${res.status}` };
  return { ok: true };
}

async function sendDiscord(text) {
  const { webhookUrl } = deliveryConfig.discord;
  if (!webhookUrl) return { ok: false, error: "missing webhook url" };
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: text }),
  });
  if (!res.ok) return { ok: false, error: `Discord webhook ${res.status}` };
  return { ok: true };
}

async function sendWebhook(payload) {
  const { url } = deliveryConfig.webhook;
  if (!url) return { ok: false, error: "missing url" };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) return { ok: false, error: `webhook ${res.status}` };
  return { ok: true };
}

// Fire an alert out to every enabled channel (fire-and-forget, self-catching).
async function deliver(alert) {
  const text = alertMessage(alert);
  const jobs = [];
  if (deliveryConfig.telegram.enabled) jobs.push(["telegram", sendTelegram(text)]);
  if (deliveryConfig.discord.enabled) jobs.push(["discord", sendDiscord(text)]);
  if (deliveryConfig.webhook.enabled) jobs.push(["webhook", sendWebhook({ event: "alert", ...alert })]);
  if (!jobs.length) return;
  const results = await Promise.all(
    jobs.map(([name, p]) => p.then((r) => [name, r]).catch((e) => [name, { ok: false, error: e.message }]))
  );
  const fails = results.filter(([, r]) => !r.ok);
  if (fails.length) console.error("  delivery failed:", fails.map(([n, r]) => `${n}:${r.error}`).join(", "));
}

async function testDelivery() {
  const sample = {
    pool: {
      name: "TEST / SOL", network: "solana", dex: "pump-fun",
      liquidityUsd: 12345, volumeH1: 6789, riskScore: 60,
      links: { geckoterminal: "https://www.geckoterminal.com", dexscreener: "https://dexscreener.com" },
    },
    ruleName: "Delivery test", safety: { grade: "good" }, at: new Date().toISOString(),
  };
  const text = "✅ CryptoWatch delivery test\n" + alertMessage(sample);
  const out = {};
  if (deliveryConfig.telegram.enabled) out.telegram = await sendTelegram(text).catch((e) => ({ ok: false, error: e.message }));
  if (deliveryConfig.discord.enabled) out.discord = await sendDiscord(text).catch((e) => ({ ok: false, error: e.message }));
  if (deliveryConfig.webhook.enabled) out.webhook = await sendWebhook({ event: "test", ...sample }).catch((e) => ({ ok: false, error: e.message }));
  if (!Object.keys(out).length) out.note = "No channels are enabled.";
  return out;
}

// Read view with secrets masked — never returns raw tokens/webhook URLs.
function maskedDelivery() {
  return {
    telegram: { enabled: deliveryConfig.telegram.enabled, chatId: deliveryConfig.telegram.chatId, tokenSet: !!deliveryConfig.telegram.botToken },
    discord: { enabled: deliveryConfig.discord.enabled, urlSet: !!deliveryConfig.discord.webhookUrl },
    webhook: { enabled: deliveryConfig.webhook.enabled, url: deliveryConfig.webhook.url },
  };
}

// Apply an update; only overwrite a secret when a non-empty value is supplied,
// so toggling "enabled" doesn't wipe a previously saved token.
function applyDelivery(b) {
  b = b || {};
  if (b.telegram) {
    deliveryConfig.telegram.enabled = !!b.telegram.enabled;
    if (b.telegram.chatId !== undefined) deliveryConfig.telegram.chatId = String(b.telegram.chatId || "");
    if (b.telegram.botToken) deliveryConfig.telegram.botToken = String(b.telegram.botToken);
  }
  if (b.discord) {
    deliveryConfig.discord.enabled = !!b.discord.enabled;
    if (b.discord.webhookUrl) deliveryConfig.discord.webhookUrl = String(b.discord.webhookUrl);
  }
  if (b.webhook) {
    deliveryConfig.webhook.enabled = !!b.webhook.enabled;
    if (b.webhook.url !== undefined) deliveryConfig.webhook.url = String(b.webhook.url || "");
  }
  saveConfig();
}

// ===========================================================================
// PERSISTENCE — alert rules + delivery config survive restarts
// ===========================================================================
// Written to a local config.json (gitignored — it holds delivery secrets).
// Loaded once at startup, saved synchronously on every change (changes are
// rare, so a blocking write is fine and guarantees durability).

// Defaults to a file next to the app; on an ephemeral host (Render) point this
// at a mounted persistent disk (e.g. CONFIG_PATH=/data/config.json) to keep
// alert rules + delivery config across deploys.
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, "config.json");

function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (Array.isArray(cfg.alertRules)) alertRules = cfg.alertRules;
    if (cfg.deliveryConfig) {
      const d = cfg.deliveryConfig; // merge to tolerate future shape changes
      if (d.telegram) Object.assign(deliveryConfig.telegram, d.telegram);
      if (d.discord) Object.assign(deliveryConfig.discord, d.discord);
      if (d.webhook) Object.assign(deliveryConfig.webhook, d.webhook);
    }
    if (cfg.cgConfig) Object.assign(cgConfig, cfg.cgConfig);
    if (cfg.aiConfig) Object.assign(aiConfig, cfg.aiConfig);
    if (cfg.ghConfig) Object.assign(ghConfig, cfg.ghConfig);
    const chans = ["telegram", "discord", "webhook"].filter((k) => deliveryConfig[k].enabled);
    console.log(`Loaded config.json: ${alertRules.length} rule(s), delivery ${chans.join("+") || "off"}`);
  } catch (e) {
    if (e.code !== "ENOENT") console.error("loadConfig error:", e.message);
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ alertRules, deliveryConfig, cgConfig, aiConfig, ghConfig }, null, 2));
  } catch (e) {
    console.error("saveConfig error:", e.message);
  }
}

// ---- Normalization --------------------------------------------------------
function tokenAddr(rel) {
  // GeckoTerminal token ids look like "solana_9yQ..." — strip the network.
  const id = rel?.data?.id || "";
  const i = id.indexOf("_");
  return i >= 0 ? id.slice(i + 1) : id;
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function normalize(p) {
  const a = p.attributes || {};
  const rel = p.relationships || {};
  const network = rel.network?.data?.id || "?";
  const dex = rel.dex?.data?.id || "?";
  const baseAddr = tokenAddr(rel.base_token);
  const liq = num(a.reserve_in_usd);
  const volH1 = num(a.volume_usd?.h1);
  const volM5 = num(a.volume_usd?.m5);
  const fdv = num(a.fdv_usd);
  const tx = a.transactions || {};
  const h1 = tx.h1 || {};
  const m5 = tx.m5 || {};

  const pool = {
    id: p.id,
    network,
    dex,
    name: a.name || "?",
    poolAddress: a.address,
    baseTokenAddress: baseAddr,
    priceUsd: num(a.base_token_price_usd),
    createdAt: a.pool_created_at,
    liquidityUsd: liq,
    fdvUsd: fdv,
    volumeH1: volH1,
    volumeM5: volM5,
    buysH1: h1.buys || 0,
    sellsH1: h1.sells || 0,
    buysM5: m5.buys || 0,
    sellsM5: m5.sells || 0,
    priceChangeM5: num(a.price_change_percentage?.m5),
    priceChangeH1: num(a.price_change_percentage?.h1),
    links: {
      geckoterminal: `https://www.geckoterminal.com/${network}/pools/${a.address}`,
      dexscreener: baseAddr
        ? `https://dexscreener.com/search?q=${baseAddr}`
        : `https://dexscreener.com/search?q=${a.address}`,
    },
  };
  const risk = scoreRisk(pool);
  pool.riskScore = risk.score;
  pool.flags = risk.flags;
  return pool;
}

// ---- Risk signal scoring --------------------------------------------------
// NOT financial advice and NOT a safety guarantee. A heuristic read of the
// data we have. Higher score = healthier-LOOKING; it says nothing about a
// contract's actual honeypot/rug risk, which needs on-chain inspection.
function scoreRisk(p) {
  let score = 50;
  const flags = [];

  // Liquidity depth
  if (p.liquidityUsd < 1000) {
    score -= 25;
    flags.push("Very low liquidity (<$1k)");
  } else if (p.liquidityUsd < 5000) {
    score -= 10;
    flags.push("Low liquidity (<$5k)");
  } else if (p.liquidityUsd > 25000) {
    score += 15;
  } else if (p.liquidityUsd > 10000) {
    score += 8;
  }

  // FDV wildly above liquidity => thin float, easy to move / dump
  if (p.liquidityUsd > 0 && p.fdvUsd / p.liquidityUsd > 50) {
    score -= 15;
    flags.push(`FDV ${Math.round(p.fdvUsd / p.liquidityUsd)}x liquidity`);
  }

  // Trading flow
  const buys = p.buysH1;
  const sells = p.sellsH1;
  if (buys + sells === 0) {
    score -= 5;
    flags.push("No trades yet");
  } else if (sells === 0) {
    flags.push("No sells yet (unproven exit)");
  } else if (sells > buys * 2) {
    score -= 12;
    flags.push("Heavy selling");
  } else if (buys > sells * 1.5) {
    score += 8;
  }

  // Volume relative to liquidity (real activity vs. a dead pool)
  if (p.liquidityUsd > 0) {
    const ratio = p.volumeH1 / p.liquidityUsd;
    if (ratio > 3) {
      score += 10;
    } else if (ratio < 0.05 && buys + sells > 0) {
      score -= 5;
      flags.push("Thin volume vs. liquidity");
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, flags };
}

// ---- SSE broadcast --------------------------------------------------------
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

// ---- Poll loops -----------------------------------------------------------
async function pollNew() {
  try {
    const fresh = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const json = await gtGet(`${GT}/networks/new_pools?page=${page}`);
      for (const p of json.data || []) {
        if (seen.has(p.id)) continue;
        const pool = normalize(p);
        seen.set(p.id, pool);
        order.unshift(p.id);
        fresh.push(pool);
        btRecord("new", pool); // discovery snapshot for backtesting
      }
    }
    // Trim buffer
    while (order.length > MAX_BUFFER) {
      const drop = order.pop();
      seen.delete(drop);
    }
    if (fresh.length) {
      // Oldest-first so the client prepends in the right order.
      fresh.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      broadcast("new", fresh);
      const t = new Date().toISOString().slice(11, 19);
      console.log(`[${t}] +${fresh.length} new pools (buffer ${order.length})`);
      await evaluateAlerts(fresh);
    }
  } catch (e) {
    if (e.status === 429) console.log("  (new_pools throttled — backing off)");
    else console.error("pollNew error:", e.message);
    broadcast("status", { error: e.message });
  }
}

async function pollTrending() {
  try {
    const json = await gtGet(`${GT}/networks/trending_pools`);
    const list = (json.data || []).map(normalize);
    trending.clear();
    for (const p of list) { trending.set(p.id, p); btRecord("seen", p); }
    broadcast("trending", list);
  } catch (e) {
    if (e.status !== 429) console.error("pollTrending error:", e.message);
  }
}

// ===========================================================================
// BACKTEST STORE — persist the launch stream to study which early signals
// preceded winners vs rugs. Bounded in memory + periodic file rewrite (cheap;
// no per-event disk churn). On an ephemeral host (Render) point DATA_DIR at a
// mounted disk to keep history across deploys. Purely observational — the
// outcome pass re-reads a small batch of aged launches within the rate budget.
// ===========================================================================
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const BT_FILE = path.join(DATA_DIR, "launches.jsonl");
const BT_MAX = 20000;
let btEvents = []; // { t, e, id, net, name, addr, price, liq, vol, buys, sells, risk, noSells, createdAt }
let btDirty = false;
const btLastRec = new Map(); // id -> last-recorded ms (throttles "seen")
const btOutcomeChecked = new Set();

function btRecord(event, p) {
  if (!p || !p.id) return;
  const now = Date.now();
  if (event === "seen") {
    const last = btLastRec.get(p.id) || 0;
    if (now - last < 5 * 60 * 1000) return; // at most one re-observation / 5 min per pool
  }
  btLastRec.set(p.id, now);
  btEvents.push({
    t: now, e: event, id: p.id, net: p.network, name: p.name, addr: p.poolAddress,
    price: p.priceUsd, liq: p.liquidityUsd, vol: p.volumeH1,
    buys: p.buysH1, sells: p.sellsH1, risk: p.riskScore,
    noSells: (p.flags || []).some((f) => f.includes("No sells")), createdAt: p.createdAt,
  });
  if (btEvents.length > BT_MAX) btEvents.splice(0, btEvents.length - BT_MAX);
  btDirty = true;
}
function btLoad() {
  try {
    const lines = fs.readFileSync(BT_FILE, "utf8").split("\n").filter(Boolean);
    for (const l of lines.slice(-BT_MAX)) { try { btEvents.push(JSON.parse(l)); } catch {} }
    for (const ev of btEvents) btLastRec.set(ev.id, ev.t);
    console.log(`Backtest: loaded ${btEvents.length} events from ${BT_FILE}`);
  } catch (e) { if (e.code !== "ENOENT") console.error("btLoad:", e.message); }
}
function btSave() {
  if (!btDirty) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(BT_FILE, btEvents.map((x) => JSON.stringify(x)).join("\n") + "\n");
    btDirty = false;
  } catch (e) { console.error("btSave:", e.message); }
}
// Re-read a small batch of aged launches to capture their outcome (did liquidity
// survive/grow, or get pulled?). Capped per pass so it stays within the budget.
async function btOutcomePass() {
  const now = Date.now();
  const seen = new Set(), cands = [];
  for (const ev of btEvents) {
    if (ev.e !== "new" || seen.has(ev.id) || btOutcomeChecked.has(ev.id)) continue;
    seen.add(ev.id);
    if (!ev.addr || !ev.net) continue;
    const ageMin = (now - new Date(ev.createdAt || ev.t).getTime()) / 60000;
    if (ageMin >= 45 && ageMin <= 300) cands.push(ev);
  }
  for (const ev of cands.slice(0, 4)) {
    btOutcomeChecked.add(ev.id);
    try {
      const j = await gtGet(`${GT}/networks/${ev.net}/pools/${ev.addr}`);
      if (j && j.data) {
        const pool = normalize(j.data);
        btLastRec.delete(pool.id); // force-record even if recently seen
        btRecord("outcome", pool);
      }
    } catch { /* pool may be gone (itself a signal) — skip */ }
  }
}
// Correlate discovery-time signals with the trajectory we observed.
function btAnalytics() {
  const byId = new Map();
  for (const ev of btEvents) { if (!byId.has(ev.id)) byId.set(ev.id, []); byId.get(ev.id).push(ev); }
  const rows = [];
  for (const [id, evs] of byId) {
    evs.sort((a, b) => a.t - b.t);
    const t0 = evs[0], t1 = evs[evs.length - 1];
    const spanMin = (t1.t - t0.t) / 60000;
    if (evs.length < 2 || spanMin < 10) continue; // need a real trajectory
    const liq0 = t0.liq || 0, liq1 = t1.liq || 0;
    const liqRatio = liq0 > 0 ? liq1 / liq0 : null;
    let outcome = "flat";
    if (liq1 < Math.max(500, liq0 * 0.25)) outcome = "rugged";
    else if (liqRatio != null && liqRatio >= 1.5) outcome = "grew";
    rows.push({ id, net: t0.net, name: t0.name, risk0: t0.risk || 0, liq0, liq1, price0: t0.price, price1: t1.price, noSells0: !!t0.noSells, spanMin: Math.round(spanMin), outcome, obs: evs.length, lastT: t1.t });
  }
  const dist = (sub) => ({ n: sub.length, grew: sub.filter((r) => r.outcome === "grew").length, flat: sub.filter((r) => r.outcome === "flat").length, rugged: sub.filter((r) => r.outcome === "rugged").length });
  return {
    tracked: byId.size, withTrajectory: rows.length, events: btEvents.length,
    since: btEvents.length ? btEvents[0].t : null,
    byRisk: [
      { label: "Risk 60–100", ...dist(rows.filter((r) => r.risk0 >= 60)) },
      { label: "Risk 40–59", ...dist(rows.filter((r) => r.risk0 >= 40 && r.risk0 < 60)) },
      { label: "Risk 0–39", ...dist(rows.filter((r) => r.risk0 < 40)) },
    ],
    byNoSells: [
      { label: "No sells at discovery", ...dist(rows.filter((r) => r.noSells0)) },
      { label: "Had sells at discovery", ...dist(rows.filter((r) => !r.noSells0)) },
    ],
    byLiq: [
      { label: "Liq ≥ $25k", ...dist(rows.filter((r) => r.liq0 >= 25000)) },
      { label: "Liq $5k–$25k", ...dist(rows.filter((r) => r.liq0 >= 5000 && r.liq0 < 25000)) },
      { label: "Liq < $5k", ...dist(rows.filter((r) => r.liq0 < 5000)) },
    ],
    recent: rows.sort((a, b) => b.lastT - a.lastT).slice(0, 40),
  };
}

// ===========================================================================
// MARKETS / ASSET / NEWS  (Messari-style intelligence on established assets)
// ===========================================================================
// CoinGecko free API for market-cap rankings, asset detail, and price charts;
// aggregated RSS for news. All cached to stay under free rate limits.

// Optional CoinGecko key. Free "demo" tier uses the public host + a demo-key
// header; paid "pro" tier uses the pro host + pro-key header. With no key we
// fall back to the anonymous public endpoint (lower rate limit). A UI value
// wins over the COINGECKO_API_KEY / COINGECKO_PLAN env vars.
let cgConfig = { key: "", plan: "demo" };
function cgSettings() {
  return {
    key: cgConfig.key || process.env.COINGECKO_API_KEY || "",
    plan: cgConfig.plan || process.env.COINGECKO_PLAN || "demo",
    fromEnv: !cgConfig.key && !!process.env.COINGECKO_API_KEY,
  };
}
function cgFetch(path) {
  const { key, plan } = cgSettings();
  const base = plan === "pro" ? "https://pro-api.coingecko.com/api/v3" : "https://api.coingecko.com/api/v3";
  const headers = { Accept: "application/json" };
  if (key) headers[plan === "pro" ? "x-cg-pro-api-key" : "x-cg-demo-api-key"] = key;
  return fetch(base + path, { headers });
}

const MARKETS_TTL = 45000;
const MARKETS_PER_PAGE = 250; // CoinGecko free max; ~15k coins => ~60 pages available
// CoinGecko can order the WHOLE universe only by these fields, so sorting by
// market cap / volume spans all ~17k coins (e.g. asc = the true low-caps).
const MARKET_ORDERS = new Set(["market_cap_desc", "market_cap_asc", "volume_desc", "volume_asc"]);
const marketsPageCache = new Map(); // "order:page" -> { data, ts }
async function getMarkets(page = 1, order = "market_cap_desc") {
  if (!MARKET_ORDERS.has(order)) order = "market_cap_desc";
  const cacheKey = `${order}:${page}`;
  const hit = marketsPageCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < MARKETS_TTL) return hit.data;
  const res = await cgFetch(`/coins/markets?vs_currency=usd&order=${order}&per_page=${MARKETS_PER_PAGE}&page=${page}&sparkline=true&price_change_percentage=1h,24h,7d`);
  if (!res.ok) throw new GeckoError(res.status);
  const raw = await res.json();
  const data = raw.map((c) => ({
    id: c.id, symbol: c.symbol, name: c.name, image: c.image, rank: c.market_cap_rank,
    price: c.current_price, marketCap: c.market_cap, volume: c.total_volume,
    change1h: c.price_change_percentage_1h_in_currency,
    change24h: c.price_change_percentage_24h_in_currency,
    change7d: c.price_change_percentage_7d_in_currency,
    supply: c.circulating_supply, ath: c.ath, atl: c.atl,
    spark: c.sparkline_in_7d?.price || [],
  }));
  marketsPageCache.set(cacheKey, { data, ts: Date.now() });
  return data;
}

// Universe size — how many coins CoinGecko tracks in total (for context).
let globalCache = { data: null, ts: 0 };
async function getGlobal() {
  if (globalCache.data && Date.now() - globalCache.ts < 300000) return globalCache.data;
  const res = await cgFetch(`/global`);
  if (!res.ok) throw new GeckoError(res.status);
  const j = await res.json();
  const data = {
    activeCryptos: j.data?.active_cryptocurrencies || null,
    markets: j.data?.markets || null,
    totalMcap: j.data?.total_market_cap?.usd || null,
    perPage: MARKETS_PER_PAGE,
  };
  globalCache = { data, ts: Date.now() };
  return data;
}

// ---- Entity fusion: map a CoinGecko coin -> its GitHub repo, Snapshot space,
// and on-chain contract(s). GitHub + contracts come straight from CoinGecko's
// own metadata (automatic); Snapshot spaces are a curated map of the major DAOs
// (the long tail of coins has no governance space). This is what lets the
// unified asset page fuse dev activity, governance, and safety/swap for a coin.
const CG_CHAIN = {
  ethereum: { net: "eth", label: "Ethereum" },
  "binance-smart-chain": { net: "bsc", label: "BNB Chain" },
  base: { net: "base", label: "Base" },
  solana: { net: "solana", label: "Solana" },
};
// CoinGecko id -> Snapshot space id (verified live against hub.snapshot.org).
const COIN_SNAPSHOT = {
  aave: "aavedao.eth",
  uniswap: "uniswapgovernance.eth",
  "ethereum-name-service": "ens.eth",
  "lido-dao": "lido-snapshot.eth",
  arbitrum: "arbitrumfoundation.eth",
  balancer: "balancer.eth",
  apecoin: "apecoin.eth",
  gmx: "gmx.eth",
  safe: "safe.eth",
  "convex-finance": "cvx.eth",
  sushi: "sushigov.eth",
  gitcoin: "gitcoindao.eth",
  aavegotchi: "aavegotchi.eth",
  "stargate-finance": "stgdao.eth",
  "radiant-capital": "radiantcapital.eth",
  frax: "frax.eth",
  "frax-share": "frax.eth",
  "1inch": "1inch.eth",
  dydx: "dydxgov.eth",
  "dydx-chain": "dydxgov.eth",
  "curve-dao-token": "curve.eth",
  "compound-governance-token": "comp-vote.eth",
  decentraland: "snapshot.dcl.eth",
  olympus: "olympusdao.eth",
  "rocket-pool": "rocketpool-dao.eth",
};
function parseGithubRepos(links) {
  const urls = links?.repos_url?.github || [];
  const repos = [];
  for (const u of urls) {
    const m = String(u).match(/github\.com\/([^\/]+\/[^\/]+?)(?:\.git)?\/?$/);
    if (m && !/\/(tree|blob)\//.test(u)) repos.push(m[1]);
  }
  return [...new Set(repos)];
}
function parseContracts(platforms) {
  const out = [];
  for (const [plat, addr] of Object.entries(platforms || {})) {
    const c = CG_CHAIN[plat];
    if (c && addr) out.push({ chain: c.label, network: c.net, address: addr });
  }
  return out;
}

const assetCache = new Map(); // id -> { data, ts }
const ASSET_TTL = 60000;
async function getAsset(id) {
  const hit = assetCache.get(id);
  if (hit && Date.now() - hit.ts < ASSET_TTL) return hit.data;
  const [detailRes, chartRes] = await Promise.all([
    cgFetch(`/coins/${id}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`),
    cgFetch(`/coins/${id}/market_chart?vs_currency=usd&days=7`),
  ]);
  if (!detailRes.ok) throw new GeckoError(detailRes.status);
  const d = await detailRes.json();
  const md = d.market_data || {};
  const prices = chartRes.ok ? (await chartRes.json()).prices || [] : [];
  const chart = prices.map((p) => p[1]);
  const chartStart = prices.length ? prices[0][0] : null;
  const chartEnd = prices.length ? prices[prices.length - 1][0] : null;
  const data = {
    id: d.id, symbol: d.symbol, name: d.name, image: d.image?.large || d.image?.small,
    rank: d.market_cap_rank,
    description: (d.description?.en || "").replace(/<[^>]+>/g, "").slice(0, 600),
    homepage: d.links?.homepage?.filter(Boolean)[0] || null,
    twitter: d.links?.twitter_screen_name ? `https://x.com/${d.links.twitter_screen_name}` : null,
    price: md.current_price?.usd, marketCap: md.market_cap?.usd, volume: md.total_volume?.usd,
    change24h: md.price_change_percentage_24h,
    change7d: md.price_change_percentage_7d,
    change30d: md.price_change_percentage_30d,
    ath: md.ath?.usd, athDate: md.ath_date?.usd, atl: md.atl?.usd,
    high24h: md.high_24h?.usd, low24h: md.low_24h?.usd,
    supply: md.circulating_supply, maxSupply: md.max_supply, totalSupply: md.total_supply,
    chart, chartStart, chartEnd,
    // Fusion hooks for the unified asset page:
    githubRepos: parseGithubRepos(d.links).slice(0, 3),
    githubRepo: parseGithubRepos(d.links)[0] || null,
    snapshotSpace: COIN_SNAPSHOT[d.id] || null,
    contracts: parseContracts(d.platforms),
  };
  assetCache.set(id, { data, ts: Date.now() });
  return data;
}

// Per-asset news — clusters from the news index that mention this coin id.
async function getAssetNews(id) {
  const payload = await getNews();
  return (payload.clusters || [])
    .filter((c) => c.assets?.some((a) => a.id === id))
    .slice(0, 15);
}

// ---- News: 11 sources, deduped, clustered, topic-tagged, asset-detected ----
const NEWS_FEEDS = [
  { src: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { src: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { src: "Decrypt", url: "https://decrypt.co/feed" },
  { src: "The Block", url: "https://www.theblock.co/rss.xml" },
  { src: "CryptoSlate", url: "https://cryptoslate.com/feed/" },
  { src: "Bankless", url: "https://www.bankless.com/rss/feed" },
  { src: "DL News", url: "https://www.dlnews.com/arc/outboundfeeds/rss/" },
  { src: "Protos", url: "https://protos.com/feed/" },
  { src: "The Defiant", url: "https://thedefiant.io/api/feed" },
  { src: "BeInCrypto", url: "https://beincrypto.com/feed/" },
  { src: "CryptoPotato", url: "https://cryptopotato.com/feed/" },
];
const NEWS_TTL = 120000;
const NEWS_BUFFER_MAX = 500;
const newsBuffer = new Map(); // link -> normalized item (rolling research index)
let newsCache = { payload: null, ts: 0 };

function unwrap(s) {
  return (s || "").replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
}
function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ");
}
function stripHtml(s) {
  return decodeEntities(unwrap(s).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}
function parseFeed(xml, src) {
  const out = [];
  // RSS <item>
  for (const b of xml.split(/<item[ >]/).slice(1)) {
    const title = stripHtml((b.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
    const link = unwrap((b.match(/<link>([\s\S]*?)<\/link>/) || [])[1]);
    const date = unwrap((b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1]);
    const summary = stripHtml((b.match(/<description>([\s\S]*?)<\/description>/) || [])[1]).slice(0, 240);
    if (title && link) out.push({ title, link, date: date || null, src, summary });
  }
  // Atom <entry> (fallback for feeds that use it)
  if (!out.length) {
    for (const b of xml.split(/<entry[ >]/).slice(1)) {
      const title = stripHtml((b.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]);
      const link = unwrap((b.match(/<link[^>]*href="([^"]+)"/) || [])[1]);
      const date = unwrap((b.match(/<(?:updated|published)>([\s\S]*?)<\/(?:updated|published)>/) || [])[1]);
      const summary = stripHtml((b.match(/<summary[^>]*>([\s\S]*?)<\/summary>/) || [])[1]).slice(0, 240);
      if (title && link) out.push({ title, link, date: date || null, src, summary });
    }
  }
  return out.slice(0, 40);
}

// Topic classification by keyword.
const TOPIC_RULES = {
  Regulation: ["sec ", "regulat", "lawsuit", "court", " sue", "congress", "senate", "cftc", "legal", " ban ", "compliance", "treasury", " doj", "judge", "settlement", "white house", "policy"],
  Security: ["hack", "exploit", "breach", "stolen", "drain", "rug ", "scam", "vulnerab", "phishing", " attack", "malware", "laundering"],
  DeFi: ["defi", "liquidity", "yield", "lending", " dex", " amm", " tvl", "staking", "restaking", "vault", "perpetual", "perps"],
  L2s: ["layer 2", "layer-2", " l2 ", "rollup", "optimism", "arbitrum", "zksync", "starknet", "scaling", "base network"],
  Memecoins: ["memecoin", "meme coin", "meme-coin", "pump.fun", "dogecoin", "shiba", "pepe", " bonk", " wif ", "dogwifhat"],
  NFTs: [" nft", "non-fungible", "opensea", "collectible", "pfp "],
  Macro: [" fed ", "interest rate", "inflation", " etf", "recession", " cpi", "rate cut", "jobs report", " gdp", "federal reserve"],
  Bitcoin: ["bitcoin", " btc", "satoshi", "halving", "ordinal", "runes"],
  Ethereum: ["ethereum", " eth ", "vitalik", "dencun", "pectra", "staking"],
  Stablecoins: ["stablecoin", " usdt", " usdc", "tether", "circle", " dai ", "depeg"],
  Exchanges: ["binance", "coinbase", "kraken", " okx", "bybit", " listing", "delisting"],
  Funding: ["raise", "raised", "funding round", "series a", "series b", "venture", "valuation", "seed round"],
  Unlocks: ["token unlock", " unlock", "vesting", " vest ", "cliff", "emission", "token release", "unlocked tokens", "supply unlock"],
};
function tagTopics(text) {
  const t = " " + text.toLowerCase() + " ";
  const topics = [];
  for (const [topic, kws] of Object.entries(TOPIC_RULES)) {
    if (kws.some((k) => t.includes(k))) topics.push(topic);
  }
  return topics;
}

// ---- Sentiment (lexicon-based, free, always-on) ---------------------------
// A crude but useful directional read on a headline. NOT a market signal or
// advice — just aggregates loaded/positive vs. negative words so the research
// view can show a "market mood" without any paid model. The AI layer (below)
// is the richer, optional-key take.
const SENT_POS = ["surge", "surges", "soar", "soars", "rally", "rallies", "gains", "jumps", "bullish", "record high", "all-time high", "approval", "approved", "partnership", "adoption", "upgrade", "integration", "milestone", "raised", "funding", "backing", "greenlight", "wins", "boost", "breakout", "inflows", "rebound", "recovers", "outperform", "expands", "green"];
const SENT_NEG = ["hack", "hacked", "exploit", "exploited", "drain", "stolen", "scam", " rug", "crash", "plunge", "plummet", "dump", "selloff", "sell-off", "bearish", "lawsuit", " sue", "sued", " ban ", "banned", "fraud", "collapse", "liquidation", "outflows", "downturn", "warning", "halt", "breach", "delist", "insolven", "probe", "charged", "fine", "penalty", "slump", "decline", "fear", "fud", "shutdown"];
function sentimentOf(text) {
  const t = " " + text.toLowerCase() + " ";
  let score = 0;
  for (const w of SENT_POS) if (t.includes(w)) score++;
  for (const w of SENT_NEG) if (t.includes(w)) score--;
  const label = score > 0 ? "positive" : score < 0 ? "negative" : "neutral";
  return { score, label };
}

// Asset dictionary from CoinGecko top coins → detect mentions in headlines.
let assetDict = { map: null, ts: 0 };
const ASSET_STOP = new Set(["for", "you", "one", "the", "usd", "all", "new", "buy", "get", "top", "now", "day"]);
async function ensureAssetDict() {
  if (assetDict.map && Date.now() - assetDict.ts < 600000) return assetDict.map;
  const map = new Map(); // lowercased term -> {id, symbol, name}
  try {
    const coins = await getMarkets(1, "market_cap_desc");
    for (const c of coins) {
      const entry = { id: c.id, symbol: c.symbol.toUpperCase(), name: c.name };
      const sym = c.symbol.toLowerCase();
      if (sym.length >= 3 && !ASSET_STOP.has(sym)) map.set(sym, entry);
      const name = c.name.toLowerCase();
      if (name.length >= 4) map.set(name, entry);
    }
    assetDict = { map, ts: Date.now() };
  } catch {
    if (!assetDict.map) assetDict = { map: new Map(), ts: Date.now() };
  }
  return assetDict.map;
}
function detectAssets(text, dict) {
  const found = new Map();
  // $TICKER
  for (const m of text.matchAll(/\$([A-Za-z]{2,6})\b/g)) {
    const hit = dict.get(m[1].toLowerCase());
    if (hit) found.set(hit.id, hit);
  }
  // whole-word name / symbol matches
  const words = text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/);
  const wordSet = new Set(words);
  for (const [term, entry] of dict) {
    if (term.includes(" ")) { if (text.toLowerCase().includes(term)) found.set(entry.id, entry); }
    else if (wordSet.has(term)) found.set(entry.id, entry);
  }
  return [...found.values()].slice(0, 5);
}

// Cluster near-duplicate stories by title-token Jaccard similarity.
const TITLE_STOP = new Set("the a an of to in on for and or with is are as at by from into over after amid new price crypto will could would say says amid this that with have has after over into more than what when will".split(" "));
function titleTokens(t) {
  return new Set(
    t.toLowerCase().replace(/[^a-z0-9$ ]/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !TITLE_STOP.has(w))
  );
}
function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const uni = a.size + b.size - inter;
  return uni ? inter / uni : 0;
}
function clusterItems(items) {
  const clusters = [];
  for (const it of items) {
    const tok = titleTokens(it.title);
    if (tok.size < 2) { clusters.push({ tok, items: [it] }); continue; }
    let best = null, bestSim = 0;
    for (const c of clusters) {
      const sim = jaccard(tok, c.tok);
      if (sim > bestSim) { bestSim = sim; best = c; }
    }
    if (best && bestSim >= 0.45) best.items.push(it);
    else clusters.push({ tok, items: [it] });
  }
  return clusters.map((c) => {
    c.items.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    const lead = c.items[0];
    const topics = [...new Set(c.items.flatMap((i) => i.topics))];
    const assetMap = new Map();
    for (const i of c.items) for (const a of i.assets) assetMap.set(a.id, a);
    return {
      title: lead.title, link: lead.link, date: lead.date, src: lead.src, summary: lead.summary,
      count: c.items.length,
      sources: [...new Set(c.items.map((i) => i.src))],
      items: c.items.map((i) => ({ src: i.src, link: i.link, date: i.date })),
      topics, assets: [...assetMap.values()],
      sentiment: sentimentOf(c.items.map((i) => i.title).join(" ") + " " + (lead.summary || "")),
    };
  });
}

async function getNews() {
  if (newsCache.payload && Date.now() - newsCache.ts < NEWS_TTL) return newsCache.payload;
  const fresh = [];
  await Promise.all(
    NEWS_FEEDS.map(async (f) => {
      try {
        const r = await fetch(f.url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0" } });
        if (r.ok) fresh.push(...parseFeed(await r.text(), f.src));
      } catch { /* skip a failing feed */ }
    })
  );
  // Merge into the rolling buffer (dedupe by link), trim to newest NEWS_BUFFER_MAX.
  for (const it of fresh) if (!newsBuffer.has(it.link)) newsBuffer.set(it.link, it);
  let all = [...newsBuffer.values()].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  if (all.length > NEWS_BUFFER_MAX) {
    all = all.slice(0, NEWS_BUFFER_MAX);
    newsBuffer.clear();
    for (const it of all) newsBuffer.set(it.link, it);
  }
  const dict = await ensureAssetDict();
  for (const it of all) {
    const text = it.title + " " + (it.summary || "");
    it.topics = tagTopics(text);
    it.assets = detectAssets(text, dict);
  }
  const clusters = clusterItems(all).sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  const topicCounts = {};
  for (const c of clusters) for (const t of c.topics) topicCounts[t] = (topicCounts[t] || 0) + 1;
  // Market mood — aggregate cluster sentiment across the recent index.
  let pos = 0, neg = 0, neu = 0, net = 0;
  for (const c of clusters) {
    net += c.sentiment.score;
    if (c.sentiment.label === "positive") pos++;
    else if (c.sentiment.label === "negative") neg++;
    else neu++;
  }
  const total = pos + neg + neu || 1;
  const mood = {
    net, pos, neg, neu,
    // -100..100: net leaning of positive vs negative stories
    index: Math.round(((pos - neg) / total) * 100),
    label: pos - neg > total * 0.12 ? "risk-on" : neg - pos > total * 0.12 ? "risk-off" : "mixed",
  };
  const payload = {
    clusters: clusters.slice(0, 200),
    topics: Object.keys(TOPIC_RULES).filter((t) => topicCounts[t]).sort((a, b) => topicCounts[b] - topicCounts[a]),
    sources: [...new Set(all.map((i) => i.src))].sort(),
    total: all.length,
    mood,
  };
  newsCache = { payload, ts: Date.now() };
  return payload;
}

// ---- Trending narratives (free heuristic) ---------------------------------
// Which themes are HEATING UP right now: for every topic we compare how many
// story-clusters landed in the last 6h vs the prior window, and surface the
// movers with sample headlines, sentiment, and the assets riding each wave.
// Pure counting over the news index — no API calls, no key.
async function getNarratives() {
  const payload = await getNews();
  const clusters = payload.clusters || [];
  const now = Date.now();
  const RECENT_MS = 6 * 3600 * 1000;

  const topics = {};
  for (const c of clusters) {
    const age = now - new Date(c.date || 0).getTime();
    const recent = age <= RECENT_MS;
    for (const t of c.topics) {
      const s = (topics[t] = topics[t] || { recent: 0, prior: 0, sent: 0, clusters: [], assets: new Map() });
      if (recent) s.recent++; else s.prior++;
      s.sent += c.sentiment?.score || 0;
      s.clusters.push(c);
      for (const a of c.assets) s.assets.set(a.id, a);
    }
  }

  const narratives = Object.entries(topics)
    .map(([topic, s]) => {
      const total = s.recent + s.prior;
      // momentum = acceleration (fresh coverage vs. the prior window).
      const momentum = s.recent - s.prior;
      return {
        topic, total, recent: s.recent, prior: s.prior, momentum,
        heating: s.recent > s.prior && s.recent >= 2,
        sentiment: s.sent,
        sentLabel: s.sent > 1 ? "positive" : s.sent < -1 ? "negative" : "neutral",
        assets: [...s.assets.values()].slice(0, 6),
        sample: s.clusters
          .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
          .slice(0, 3)
          .map((c) => ({ title: c.title, link: c.link, date: c.date, src: c.src, count: c.count })),
      };
    })
    // Trending = most current coverage first, then acceleration, then breadth.
    .sort((a, b) => b.recent - a.recent || b.momentum - a.momentum || b.total - a.total);

  // Most-mentioned assets across the whole index (narrative-agnostic).
  const assetCount = new Map();
  for (const c of clusters)
    for (const a of c.assets) {
      const e = assetCount.get(a.id) || { ...a, count: 0, sent: 0 };
      e.count++; e.sent += c.sentiment?.score || 0;
      assetCount.set(a.id, e);
    }
  const topAssets = [...assetCount.values()].sort((a, b) => b.count - a.count).slice(0, 14);

  return { narratives, topAssets, mood: payload.mood, total: payload.total, generatedAt: new Date().toISOString() };
}

// ---- Governance (Snapshot — free, no key) ---------------------------------
// Live active on-chain governance proposals across DAO spaces. Ranked so the
// biggest DAOs (by follower count) surface first, then soonest-to-close.
const GOV_TTL = 300000;
let govCache = { data: null, ts: 0 };
async function getGov() {
  if (govCache.data && Date.now() - govCache.ts < GOV_TTL) return govCache.data;
  const query = `query{proposals(first:60,where:{state:"active"},orderBy:"end",orderDirection:asc){id title start end choices scores_total votes space{id name followersCount}}}`;
  const res = await fetch("https://hub.snapshot.org/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new GeckoError(res.status);
  const j = await res.json();
  let proposals = (j.data?.proposals || []).map((p) => ({
    id: p.id, title: p.title, start: p.start, end: p.end,
    space: p.space?.name || p.space?.id, spaceId: p.space?.id,
    followers: p.space?.followersCount || 0,
    votes: p.votes || 0, choices: (p.choices || []).length,
    link: `https://snapshot.org/#/${p.space?.id}/proposal/${p.id}`,
  }));
  proposals.sort((a, b) => b.followers - a.followers || a.end - b.end);
  const data = { proposals: proposals.slice(0, 60), generatedAt: new Date().toISOString() };
  govCache = { data, ts: Date.now() };
  return data;
}

// One DAO's recent proposals (active + closed), for the unified asset page.
const govSpaceCache = new Map(); // spaceId -> { data, ts }
async function getGovSpace(space) {
  const hit = govSpaceCache.get(space);
  if (hit && Date.now() - hit.ts < GOV_TTL) return hit.data;
  const query = `query{space(id:"${space}"){id name} proposals(first:12,where:{space:"${space}"},orderBy:"created",orderDirection:desc){id title state start end votes}}`;
  const res = await fetch("https://hub.snapshot.org/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new GeckoError(res.status);
  const j = await res.json();
  const proposals = (j.data?.proposals || []).map((p) => ({
    id: p.id, title: p.title, state: p.state, start: p.start, end: p.end, votes: p.votes || 0,
    link: `https://snapshot.org/#/${space}/proposal/${p.id}`,
  }));
  const data = { space, spaceName: j.data?.space?.name || space, proposals };
  govSpaceCache.set(space, { data, ts: Date.now() });
  return data;
}

// ---- Developer activity (GitHub — free, optional token) -------------------
// A shipping-velocity read on major protocols: commits in the last 7 days,
// stars, open issues, last push. Unauthenticated GitHub allows ~60 req/hr, so
// results are cached 30m; an optional token (env GITHUB_TOKEN or UI) lifts it.
const DEV_REPOS = [
  { name: "Bitcoin", symbol: "BTC", repo: "bitcoin/bitcoin" },
  { name: "Ethereum", symbol: "ETH", repo: "ethereum/go-ethereum" },
  { name: "Solana", symbol: "SOL", repo: "anza-xyz/agave" },
  { name: "Chainlink", symbol: "LINK", repo: "smartcontractkit/chainlink" },
  { name: "Uniswap", symbol: "UNI", repo: "Uniswap/v4-core" },
  { name: "Aave", symbol: "AAVE", repo: "aave/aave-v3-core" },
  { name: "Cosmos", symbol: "ATOM", repo: "cosmos/cosmos-sdk" },
  { name: "Polkadot", symbol: "DOT", repo: "paritytech/polkadot-sdk" },
  { name: "Avalanche", symbol: "AVAX", repo: "ava-labs/avalanchego" },
  { name: "Arbitrum", symbol: "ARB", repo: "OffchainLabs/nitro" },
  { name: "Optimism", symbol: "OP", repo: "ethereum-optimism/optimism" },
  { name: "Sui", symbol: "SUI", repo: "MystenLabs/sui" },
  { name: "Aptos", symbol: "APT", repo: "aptos-labs/aptos-core" },
  { name: "NEAR", symbol: "NEAR", repo: "near/nearcore" },
];
let ghConfig = { token: "" };
function ghToken() { return ghConfig.token || process.env.GITHUB_TOKEN || ""; }
function ghFromEnv() { return !ghConfig.token && !!process.env.GITHUB_TOKEN; }
function ghHeaders() {
  const h = { Accept: "application/vnd.github+json", "User-Agent": "CryptoWatch" };
  const t = ghToken();
  if (t) h.Authorization = "Bearer " + t;
  return h;
}
const DEV_TTL = 1800000;
const repoCache = new Map(); // "owner/name" -> { data, ts }
// One repo's activity (commits in the last 7d + stars/issues/last-push). Shared
// by the /dev board and the per-asset /dev/repo lookup, cached per repo.
async function repoActivity(repo) {
  const hit = repoCache.get(repo);
  if (hit && Date.now() - hit.ts < DEV_TTL) return hit.data;
  const since = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
  let data;
  try {
    const [repoRes, commitsRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${repo}`, { headers: ghHeaders() }),
      fetch(`https://api.github.com/repos/${repo}/commits?since=${since}&per_page=100`, { headers: ghHeaders() }),
    ]);
    if (!repoRes.ok) {
      data = { repo, url: `https://github.com/${repo}`, error: `GitHub ${repoRes.status}` };
    } else {
      const rp = await repoRes.json();
      const commits = commitsRes.ok ? await commitsRes.json() : [];
      const commits7d = Array.isArray(commits) ? commits.length : 0;
      data = {
        repo, url: `https://github.com/${repo}`,
        stars: rp.stargazers_count, openIssues: rp.open_issues_count,
        pushedAt: rp.pushed_at, lang: rp.language,
        commits7d, commitsCapped: commits7d >= 100,
      };
    }
  } catch (e) {
    data = { repo, url: `https://github.com/${repo}`, error: e.message };
  }
  repoCache.set(repo, { data, ts: Date.now() });
  return data;
}
let devCache = { data: null, ts: 0 };
async function getDev() {
  if (devCache.data && Date.now() - devCache.ts < DEV_TTL) return devCache.data;
  const rows = await Promise.all(DEV_REPOS.map(async (r) => ({ ...r, ...(await repoActivity(r.repo)) })));
  const ok = rows.filter((r) => !r.error).sort((a, b) => (b.commits7d || 0) - (a.commits7d || 0));
  const fail = rows.filter((r) => r.error);
  const data = { repos: [...ok, ...fail], generatedAt: new Date().toISOString(), tokenSet: !!ghToken(), fromEnv: ghFromEnv() };
  devCache = { data, ts: Date.now() };
  return data;
}

// ===========================================================================
// SWAP — Solana via Jupiter (NON-CUSTODIAL)
// ===========================================================================
// The server only fetches a route and builds an UNSIGNED transaction. It never
// holds keys and never signs or sends anything — the user's Phantom wallet does
// that in their browser. We proxy Jupiter to centralize errors and avoid CORS.

const JUP = "https://lite-api.jup.ag/swap/v1";
const SOL_MINT = "So11111111111111111111111111111111111111112";

async function jupQuote(inputMint, outputMint, amount, slippageBps) {
  const url = `${JUP}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || `Jupiter quote ${res.status}`);
  return j;
}

async function jupBuild(quoteResponse, userPublicKey) {
  const res = await fetch(`${JUP}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || `Jupiter swap ${res.status}`);
  return j; // { swapTransaction (base64), lastValidBlockHeight, ... }
}

// Token decimals (needed to convert a human amount to raw units for sells).
async function mintDecimals(mint) {
  if (mint === SOL_MINT) return 9;
  const s = await solRpc("getTokenSupply", [mint]);
  const d = s?.value?.decimals;
  return typeof d === "number" ? d : null;
}

// ===========================================================================
// EVM SWAP — non-custodial, keyless via the OpenOcean aggregator
// ===========================================================================
// Same non-custodial model as the Solana swap: the server only fetches a quote
// and builds an UNSIGNED transaction; the user's MetaMask signs and sends it.
// OpenOcean is a keyless DEX aggregator (no API key). `amount` is in HUMAN units
// (e.g. "0.5" = 0.5 ETH). Native token = the 0xEeee… placeholder. ERC-20 sells
// need a one-time allowance to the router, checked via /evm/allowance.
const OO = "https://open-api.openocean.finance/v4";
const OO_CHAINS = { eth: "eth", ethereum: "eth", base: "base", bsc: "bsc" };
const EVM_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

async function ooGasPrice(chain) {
  try {
    const r = await fetch(`${OO}/${chain}/gasPrice`, { headers: { Accept: "application/json" } });
    const j = await r.json();
    const gp = j?.data?.standard?.legacyGasPrice ?? j?.data?.base;
    return gp != null ? String(gp) : "5000000000";
  } catch { return "5000000000"; }
}
async function ooSwapCall(chain, kind, params) {
  const gasPrice = await ooGasPrice(chain);
  const qs = new URLSearchParams({ ...params, gasPrice }).toString();
  const r = await fetch(`${OO}/${chain}/${kind}?${qs}`, { headers: { Accept: "application/json" } });
  const j = await r.json();
  if (j.code !== 200) throw new Error(j.error || j.message || `OpenOcean ${kind} ${j.code}`);
  return j.data;
}
const SEL_ALLOWANCE = "0xdd62ed3e";
function allowanceData(owner, spender) {
  return SEL_ALLOWANCE + owner.toLowerCase().replace(/^0x/, "").padStart(64, "0") + spender.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

// ===========================================================================
// AI — plain-English risk verdict via Claude (optional key)
// ===========================================================================
// Turns the raw on-chain safety signals into a short human risk read. Key is
// optional (env ANTHROPIC_API_KEY or UI), stored like the other secrets:
// gitignored config.json, masked on read, never sent to the browser. The call
// is made server-side via raw HTTP to keep this file dependency-free.

let aiConfig = { key: "" };
function aiKey() { return aiConfig.key || process.env.ANTHROPIC_API_KEY || ""; }
function aiFromEnv() { return !aiConfig.key && !!process.env.ANTHROPIC_API_KEY; }

const aiCache = new Map(); // token -> { verdict, ts }
const AI_TTL = 300000;

const AI_SYSTEM = `You are a crypto risk analyst embedded in a brand-new-token launch radar. Given on-chain safety-check data for a token that launched minutes ago, write a SHORT plain-English risk read: 2 to 4 sentences.

Lead with the single most important risk factor. Weigh the signals that actually determine a rug: honeypot (can you sell?), LP lock/burn, mint & freeze authority, liquidity depth, holder concentration. Most brand-new tokens are scams or rugs — be blunt when the data says so, and say when the data is thin or unknown rather than guessing.

Hard rules: describe risk from the provided data only. Do NOT tell the user to buy, sell, ape, or avoid; do NOT predict price; do NOT give financial or investment advice. End with a one-line bottom line starting "Bottom line:". No preamble, no markdown headers, no bullet points.`;

function aiUsd(n) {
  const a = Math.abs(n || 0);
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + Math.round(n || 0);
}
function aiUserText(pool, safety) {
  const ageSec = Math.max(0, (Date.now() - new Date(pool.createdAt).getTime()) / 1000);
  const age = ageSec < 3600 ? Math.round(ageSec / 60) + "m" : Math.round(ageSec / 3600) + "h";
  const checks = (safety?.checks || []).map((c) => `- ${c.label} [${c.status}]: ${c.detail}`).join("\n");
  return `Token "${pool.name}" on ${pool.network} via ${pool.dex}.
Liquidity ${aiUsd(pool.liquidityUsd)}, 1h volume ${aiUsd(pool.volumeH1)}, age ${age}, heuristic risk score ${pool.riskScore}/100.
On-chain safety checks (status is good/warn/bad/unknown):
${checks || "(no deep safety data available)"}
Overall heuristic grade: ${safety?.grade || "unknown"}.

Write the risk read.`;
}

async function callClaude(system, userText, maxTokens = 400) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": aiKey(),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-opus-5",
      max_tokens: maxTokens,
      output_config: { effort: "low" },
      system,
      messages: [{ role: "user", content: userText }],
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error?.message || `Anthropic API ${res.status}`);
  if (j.stop_reason === "refusal") return "The AI declined to analyze this token.";
  const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  return text || "No response from the model.";
}

async function aiRiskVerdict(pool, safety) {
  if (!aiKey()) return { error: "no_key" };
  const key = pool.baseTokenAddress || pool.id;
  const hit = aiCache.get(key);
  if (hit && Date.now() - hit.ts < AI_TTL) return { verdict: hit.verdict, cached: true };
  const verdict = await callClaude(AI_SYSTEM, aiUserText(pool, safety));
  aiCache.set(key, { verdict, ts: Date.now() });
  return { verdict };
}

// ===========================================================================
// AI RESEARCH LAYER — "what matters now" digest + per-story "why it matters"
// ===========================================================================
// Same optional Claude key. Turns the free clustered/sentiment-tagged news
// index into synthesis a researcher can skim. Cached hard (digest is a whole
// call over the top stories) so it costs a fraction of a cent and stays under
// any rate limit. Guardrails identical: describe/synthesize only, no advice.

const AI_DIGEST_SYSTEM = `You are the editor of a sophisticated crypto research terminal. You are given the current top clustered headlines (each with how many outlets ran it, topic tags, detected assets, and a crude sentiment tag). Write a tight "What matters now" briefing.

Output 4 to 6 themes, one per line, each starting with "- ". Each line: a 2-4 word label in CAPS, then " — ", then ONE sentence explaining the development and why it matters to the market or a sector. Merge related stories into one theme. Lead with the most market-moving, regulatory, security, or capital-flow items; push noise down or out.

Hard rules: synthesize ONLY what the headlines support — do not invent facts, prices, or figures not present. Do NOT give buy/sell/investment advice or predict prices. No preamble, no sign-off, no markdown headers — just the "- " lines.`;

const AI_WHY_SYSTEM = `You explain why a single crypto news story matters, for a sophisticated researcher who already knows the basics. Given a headline (and maybe a short summary and detected assets), write 1 to 2 sentences on the significance: what it implies for the protocol, sector, or market structure.

Hard rules: reason only from the story provided; do not invent specifics. Do NOT give buy/sell/investment advice or predict price. No preamble, no markdown — just the 1-2 sentences.`;

const aiDigestCache = { text: null, ts: 0, sig: "" };
const AI_DIGEST_TTL = 600000; // 10 min
const aiWhyCache = new Map(); // link -> { text, ts }
const AI_WHY_TTL = 3600000; // 1h

function digestUserText(clusters, mood) {
  const lines = clusters.slice(0, 28).map((c, i) => {
    const assets = (c.assets || []).map((a) => "$" + a.symbol).join(" ");
    const topics = (c.topics || []).join(", ");
    return `${i + 1}. "${c.title}" [${c.count}x outlets${topics ? "; " + topics : ""}${assets ? "; " + assets : ""}; sentiment ${c.sentiment?.label || "neutral"}]`;
  });
  const m = mood ? `Overall news mood: ${mood.label} (${mood.pos} positive / ${mood.neg} negative clusters).` : "";
  return `${m}\nTop clustered crypto headlines right now:\n${lines.join("\n")}\n\nWrite the "What matters now" briefing.`;
}

async function aiDigest() {
  if (!aiKey()) return { error: "no_key" };
  const payload = await getNews();
  const clusters = payload.clusters || [];
  // Signature keyed to the current lead stories, so we don't re-bill for an
  // unchanged front page but do refresh when the news actually moves.
  const sig = clusters.slice(0, 12).map((c) => c.link).join("|");
  if (aiDigestCache.text && aiDigestCache.sig === sig && Date.now() - aiDigestCache.ts < AI_DIGEST_TTL) {
    return { digest: aiDigestCache.text, mood: payload.mood, cached: true, generatedAt: new Date(aiDigestCache.ts).toISOString() };
  }
  const text = await callClaude(AI_DIGEST_SYSTEM, digestUserText(clusters, payload.mood), 700);
  aiDigestCache.text = text; aiDigestCache.ts = Date.now(); aiDigestCache.sig = sig;
  return { digest: text, mood: payload.mood, generatedAt: new Date().toISOString() };
}

async function aiWhy(story) {
  if (!aiKey()) return { error: "no_key" };
  const link = story.link || story.title;
  const hit = aiWhyCache.get(link);
  if (hit && Date.now() - hit.ts < AI_WHY_TTL) return { why: hit.text, cached: true };
  const assets = (story.assets || []).map((a) => `$${a.symbol} (${a.name})`).join(", ");
  const userText = `Headline: "${story.title}"\n${story.summary ? "Summary: " + story.summary + "\n" : ""}${assets ? "Assets: " + assets + "\n" : ""}${story.sources ? "Ran by: " + story.sources.join(", ") + "\n" : ""}\nWhy does this matter?`;
  const text = await callClaude(AI_WHY_SYSTEM, userText, 220);
  aiWhyCache.set(link, { text, ts: Date.now() });
  return { why: text };
}

// ---- AI asset explainer + natural-language screener (finish the AI set) ----
const AI_EXPLAIN_SYSTEM = `You explain what a crypto asset is and its current state, for a researcher who wants a quick, grounded read. Given the asset's name, symbol, CoinGecko description, market stats, and any dev/governance/news signals provided, write 2 to 4 sentences: what it is and does, its category/sector, and any notable current context.

Hard rules: use ONLY the provided data; if the description is thin, say the data is limited rather than inventing. Do NOT give buy/sell/investment advice or predict price. No preamble, no markdown.`;

const aiExplainCache = new Map(); // coin id -> { text, ts }
async function aiExplain(b) {
  if (!aiKey()) return { error: "no_key" };
  const id = b.id || b.symbol || "";
  const hit = aiExplainCache.get(id);
  if (hit && Date.now() - hit.ts < AI_WHY_TTL) return { explanation: hit.text, cached: true };
  const parts = [`Asset: ${b.name || b.symbol} (${(b.symbol || "").toUpperCase()})`];
  if (b.rank) parts.push(`Market-cap rank #${b.rank}`);
  if (b.marketCap) parts.push(`Market cap ${aiUsd(b.marketCap)}`);
  if (typeof b.change24h === "number") parts.push(`24h change ${b.change24h.toFixed(1)}%`);
  if (typeof b.change7d === "number") parts.push(`7d change ${b.change7d.toFixed(1)}%`);
  if (b.description) parts.push(`CoinGecko description: ${String(b.description).slice(0, 800)}`);
  if (b.dev) parts.push(`GitHub activity: ${String(b.dev).slice(0, 160)}`);
  if (b.gov) parts.push(`Governance: ${String(b.gov).slice(0, 160)}`);
  if (Array.isArray(b.news) && b.news.length) parts.push(`Recent headlines: ${b.news.slice(0, 4).map(String).join(" | ").slice(0, 400)}`);
  const text = await callClaude(AI_EXPLAIN_SYSTEM, parts.join("\n") + "\n\nExplain this asset.", 340);
  aiExplainCache.set(id, { text, ts: Date.now() });
  return { explanation: text };
}

const AI_SCREEN_SYSTEM = `You convert a plain-English crypto market-screen request into a strict JSON filter for a market-cap-ranked coin table. The ONLY filterable fields are:
- "minCap","maxCap": market cap in USD (number or null)
- "minVol": minimum 24h volume in USD (number or null)
- "order": how to sort the whole universe — one of "market_cap_desc","market_cap_asc","volume_desc","volume_asc"

Interpret cap tiers sensibly: micro <$1,000,000; small $1M–$50M; mid $50M–$1B; large >$1B. "low cap"/"smallest" => order "market_cap_asc". "most traded"/"high volume" => "volume_desc".

Return ONLY a JSON object, no markdown and no text outside it:
{"minCap":<num|null>,"maxCap":<num|null>,"minVol":<num|null>,"order":"<one of the four>","note":"<one short sentence: what you applied, and note anything requested that these four fields can't express (e.g. sector, chain, age)>"}

Never give financial advice.`;

async function aiScreen(query) {
  if (!aiKey()) return { error: "no_key" };
  const raw = await callClaude(AI_SCREEN_SYSTEM, `Request: "${String(query || "").slice(0, 300)}"`, 300);
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { error: "parse", raw };
  let f;
  try { f = JSON.parse(m[0]); } catch { return { error: "parse", raw }; }
  const ORDERS = new Set(["market_cap_desc", "market_cap_asc", "volume_desc", "volume_asc"]);
  return {
    filter: {
      minCap: typeof f.minCap === "number" ? f.minCap : null,
      maxCap: typeof f.maxCap === "number" ? f.maxCap : null,
      minVol: typeof f.minVol === "number" ? f.minVol : null,
      order: ORDERS.has(f.order) ? f.order : "market_cap_desc",
    },
    note: typeof f.note === "string" ? f.note : "",
  };
}

// ---- HTTP server ----------------------------------------------------------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

// ---- Optional access gate (for public hosting) ----------------------------
// This app has no accounts and exposes key-funded AI + config endpoints, so a
// public URL should be locked. Set AUTH_PASS (and optionally AUTH_USER) as an
// env var and every request needs HTTP Basic Auth — the browser prompts once,
// then sends the header on all requests incl. the SSE stream. No env var set =>
// wide open (local single-user use, unchanged).
const AUTH_USER = process.env.AUTH_USER || "";
const AUTH_PASS = process.env.AUTH_PASS || "";
function authOk(req) {
  if (!AUTH_PASS) return true;
  const m = (req.headers.authorization || "").match(/^Basic (.+)$/);
  if (!m) return false;
  const idx = Buffer.from(m[1], "base64").toString().indexOf(":");
  const u = idx >= 0 ? Buffer.from(m[1], "base64").toString().slice(0, idx) : "";
  const p = idx >= 0 ? Buffer.from(m[1], "base64").toString().slice(idx + 1) : "";
  return (!AUTH_USER || u === AUTH_USER) && p === AUTH_PASS;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Health check — intentionally BEFORE the auth gate so platform probes and the
  // keep-alive ping always get a 200 (a 401 here would make the host think the
  // service is unhealthy once AUTH_PASS is set). Returns no sensitive data.
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end("ok");
    return;
  }

  if (!authOk(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="CryptoWatch"', "Content-Type": "text/plain" });
    res.end("Authentication required.");
    return;
  }

  if (url.pathname === "/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("retry: 3000\n\n");
    clients.add(res);
    // Replay current buffers to the new client (newest-first for New feed).
    const snapshot = order.map((id) => seen.get(id)).filter(Boolean);
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    res.write(
      `event: trending\ndata: ${JSON.stringify([...trending.values()])}\n\n`
    );
    res.write(`event: rules\ndata: ${JSON.stringify(alertRules)}\n\n`);
    res.write(
      `event: alerts_snapshot\ndata: ${JSON.stringify(alertFeed)}\n\n`
    );
    req.on("close", () => clients.delete(res));
    return;
  }

  if (url.pathname === "/safety") {
    const network = url.searchParams.get("network");
    const token = url.searchParams.get("token");
    if (!network || !token) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "network and token required" }));
      return;
    }
    getSafety(network, token).then((result) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (url.pathname === "/alerts/rules") {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(alertRules));
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const incoming = JSON.parse(body);
          if (!Array.isArray(incoming)) throw new Error("expected an array of rules");
          // Normalize + keep only known fields.
          alertRules = incoming.map((r, i) => ({
            id: String(r.id || `r${Date.now()}_${i}`),
            name: String(r.name || `Rule ${i + 1}`).slice(0, 60),
            enabled: r.enabled !== false,
            chains: Array.isArray(r.chains) ? r.chains : [],
            minLiq: Number(r.minLiq) || 0,
            minVol: Number(r.minVol) || 0,
            maxAgeSec: Number(r.maxAgeSec) || 0,
            minRisk: Number(r.minRisk) || 0,
            noRedFlags: !!r.noRedFlags,
            requireSafe: !!r.requireSafe,
            safeMode: r.safeMode === "passed" ? "passed" : "not_danger",
          }));
          saveConfig();
          broadcast("rules", alertRules);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, rules: alertRules }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    res.writeHead(405).end("method not allowed");
    return;
  }

  if (url.pathname === "/alerts/delivery") {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(maskedDelivery()));
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          applyDelivery(JSON.parse(body || "{}"));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(maskedDelivery()));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    res.writeHead(405).end("method not allowed");
    return;
  }

  if (url.pathname === "/markets") {
    const page = Math.max(1, Math.min(60, parseInt(url.searchParams.get("page")) || 1));
    const order = url.searchParams.get("order") || "market_cap_desc";
    getMarkets(page, order)
      .then((data) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      })
      .catch((e) => {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      });
    return;
  }

  if (url.pathname === "/global") {
    getGlobal()
      .then((data) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      })
      .catch((e) => {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      });
    return;
  }

  if (url.pathname === "/swap/quote") {
    const input = url.searchParams.get("input");
    const output = url.searchParams.get("output");
    const amount = url.searchParams.get("amount");
    const slippageBps = url.searchParams.get("slippageBps") || "50";
    if (!input || !output || !amount) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "input, output, amount required" }));
      return;
    }
    jupQuote(input, output, amount, slippageBps)
      .then((q) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(q)); })
      .catch((e) => { res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); });
    return;
  }

  if (url.pathname === "/swap/mint") {
    const mint = url.searchParams.get("mint");
    if (!mint) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "mint required" })); return; }
    mintDecimals(mint)
      .then((d) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ mint, decimals: d })); })
      .catch((e) => { res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); });
    return;
  }

  if (url.pathname === "/evm/quote") {
    const chain = OO_CHAINS[url.searchParams.get("chain")];
    const inTok = url.searchParams.get("in"), outTok = url.searchParams.get("out"), amount = url.searchParams.get("amount");
    if (!chain || !inTok || !outTok || !amount) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "chain, in, out, amount required" })); return; }
    ooSwapCall(chain, "quote", { inTokenAddress: inTok, outTokenAddress: outTok, amount })
      .then((d) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); })
      .catch((e) => { res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); });
    return;
  }

  if (url.pathname === "/evm/swap") {
    const chain = OO_CHAINS[url.searchParams.get("chain")];
    const inTok = url.searchParams.get("in"), outTok = url.searchParams.get("out"), amount = url.searchParams.get("amount");
    const slippage = url.searchParams.get("slippage") || "1", account = url.searchParams.get("account");
    if (!chain || !inTok || !outTok || !amount || !account) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "chain, in, out, amount, account required" })); return; }
    ooSwapCall(chain, "swap", { inTokenAddress: inTok, outTokenAddress: outTok, amount, slippage, account })
      .then((d) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); })
      .catch((e) => { res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); });
    return;
  }

  if (url.pathname === "/evm/allowance") {
    const net = url.searchParams.get("chain");
    const token = url.searchParams.get("token"), owner = url.searchParams.get("owner"), spender = url.searchParams.get("spender");
    if (!EVM_RPC[net] || !token || !owner || !spender) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "chain(eth/base/bsc), token, owner, spender required" })); return; }
    evmCall(net, token, allowanceData(owner, spender))
      .then((a) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ allowance: a == null ? null : a.toString() })); })
      .catch((e) => { res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); });
    return;
  }

  if (url.pathname === "/swap/build" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const b = JSON.parse(body || "{}");
        if (!b.quoteResponse || !b.userPublicKey) throw new Error("quoteResponse and userPublicKey required");
        jupBuild(b.quoteResponse, b.userPublicKey)
          .then((r) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(r)); })
          .catch((e) => { res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); });
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (url.pathname === "/news/asset") {
    const id = url.searchParams.get("id");
    if (!id) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "id required" })); return; }
    getAssetNews(id)
      .then((clusters) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(clusters)); })
      .catch((e) => { res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); });
    return;
  }

  if (url.pathname === "/ai/config") {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ keySet: !!aiKey(), fromEnv: aiFromEnv() }));
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const b = JSON.parse(body || "{}");
          if (typeof b.key === "string" && b.key.trim()) aiConfig.key = b.key.trim();
          if (b.clear) aiConfig.key = "";
          saveConfig();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ keySet: !!aiKey(), fromEnv: aiFromEnv() }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    res.writeHead(405).end("method not allowed");
    return;
  }

  if (url.pathname === "/ai/risk" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const b = JSON.parse(body || "{}");
        if (!b.pool) throw new Error("pool required");
        aiRiskVerdict(b.pool, b.safety)
          .then((r) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(r)); })
          .catch((e) => { res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); });
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (url.pathname === "/markets/config") {
    if (req.method === "GET") {
      const s = cgSettings();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ keySet: !!s.key, plan: s.plan, fromEnv: s.fromEnv }));
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const b = JSON.parse(body || "{}");
          if (typeof b.key === "string" && b.key.trim()) cgConfig.key = b.key.trim();
          if (b.clear) cgConfig.key = "";
          if (b.plan === "demo" || b.plan === "pro") cgConfig.plan = b.plan;
          marketsPageCache.clear(); // force refetch with the new key
          globalCache = { data: null, ts: 0 };
          assetCache.clear();
          saveConfig();
          const s = cgSettings();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ keySet: !!s.key, plan: s.plan, fromEnv: s.fromEnv }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    res.writeHead(405).end("method not allowed");
    return;
  }

  if (url.pathname === "/asset") {
    const id = url.searchParams.get("id");
    if (!id) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "id required" }));
      return;
    }
    getAsset(id)
      .then((data) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      })
      .catch((e) => {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      });
    return;
  }

  if (url.pathname === "/news") {
    getNews()
      .then((items) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(items));
      })
      .catch((e) => {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      });
    return;
  }

  if (url.pathname === "/narratives") {
    getNarratives()
      .then((data) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); })
      .catch((e) => { res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); });
    return;
  }

  if (url.pathname === "/ai/digest") {
    aiDigest()
      .then((data) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); })
      .catch((e) => { res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); });
    return;
  }

  if (url.pathname === "/ai/why" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const b = JSON.parse(body || "{}");
        if (!b.title) throw new Error("title required");
        aiWhy(b)
          .then((r) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(r)); })
          .catch((e) => { res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); });
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (url.pathname === "/ai/explain" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const b = JSON.parse(body || "{}");
        if (!b.id && !b.symbol) throw new Error("id or symbol required");
        aiExplain(b)
          .then((r) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(r)); })
          .catch((e) => { res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); });
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (url.pathname === "/ai/screen" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const b = JSON.parse(body || "{}");
        if (!b.query || !String(b.query).trim()) throw new Error("query required");
        aiScreen(b.query)
          .then((r) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(r)); })
          .catch((e) => { res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); });
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (url.pathname === "/gov") {
    getGov()
      .then((data) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); })
      .catch((e) => { res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); });
    return;
  }

  if (url.pathname === "/dev") {
    getDev()
      .then((data) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); })
      .catch((e) => { res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); });
    return;
  }

  if (url.pathname === "/dev/repo") {
    const repo = (url.searchParams.get("repo") || "").trim();
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "valid owner/name repo required" }));
      return;
    }
    repoActivity(repo)
      .then((data) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); })
      .catch((e) => { res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); });
    return;
  }

  if (url.pathname === "/gov/space") {
    const space = (url.searchParams.get("space") || "").trim();
    if (!/^[A-Za-z0-9._-]+$/.test(space)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "valid space id required" }));
      return;
    }
    getGovSpace(space)
      .then((data) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); })
      .catch((e) => { res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); });
    return;
  }

  if (url.pathname === "/dev/config") {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tokenSet: !!ghToken(), fromEnv: ghFromEnv() }));
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const b = JSON.parse(body || "{}");
          if (typeof b.token === "string" && b.token.trim()) ghConfig.token = b.token.trim();
          if (b.clear) ghConfig.token = "";
          devCache = { data: null, ts: 0 }; // refetch with the new token
          saveConfig();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ tokenSet: !!ghToken(), fromEnv: ghFromEnv() }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    res.writeHead(405).end("method not allowed");
    return;
  }

  if (url.pathname === "/alerts/delivery/test" && req.method === "POST") {
    testDelivery().then((result) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (url.pathname === "/backtest") {
    try {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(btAnalytics()));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Static files
  let file = url.pathname === "/" ? "/index.html" : url.pathname;
  const full = path.join(__dirname, "public", path.normalize(file));
  if (!full.startsWith(path.join(__dirname, "public"))) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "text/plain" });
    res.end(data);
  });
});

// ---- Keep-alive (free-tier hosts sleep after ~15m with no INBOUND traffic) --
// Render spins a free service down on inbound-idle — which pauses the live feed.
// When the host tells us our public URL (Render sets RENDER_EXTERNAL_URL), ping
// our own /healthz on an interval so we always look "trafficked". No-op locally
// (no such env var), so it never runs during local dev. Note: this keeps an
// already-awake instance warm; it can't wake one that has fully slept — an
// external uptime monitor can do that too if you want belt-and-suspenders.
function startKeepAlive() {
  const base = process.env.RENDER_EXTERNAL_URL || process.env.KEEPALIVE_URL;
  if (!base) return;
  const target = base.replace(/\/$/, "") + "/healthz";
  const ping = () => fetch(target).catch(() => {});
  setInterval(ping, 10 * 60 * 1000); // every 10 min, comfortably under the ~15m window
  console.log(`Keep-alive: pinging ${target} every 10m`);
}

loadConfig();
btLoad();
server.listen(PORT, () => {
  console.log(`CryptoWatch running -> http://localhost:${PORT}`);
  pollNew();
  pollTrending();
  setInterval(pollNew, NEW_POLL_MS);
  setInterval(pollTrending, TREND_POLL_MS);
  startKeepAlive();
  setInterval(btSave, 180000);        // persist backtest store every 3 min
  setInterval(btOutcomePass, 120000); // re-check a small batch of aged launches
});
