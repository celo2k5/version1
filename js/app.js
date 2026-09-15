// ---------------------------------------------------------------------------
// app.js — Version 1 launchpad (pump.fun-style UI, dark).
// Explore grid with live sparklines · launch form with image / description /
// first-buy / quote-token picker (SOL, PUMP, USDC, custom CA) · live launch
// summary · SIMD-0385 v1 wire format with legacy fallback.
// Operational things (payer, airdrop, RPC, config, byte dump, logs) live in
// /admin — state is shared through localStorage.
// ---------------------------------------------------------------------------
'use strict';

const $ = id => document.getElementById(id);
const LAMPORTS_PER_SOL = 1_000_000_000;
const WALLET_STORAGE_KEY = 'simd0385-launchpad-secret';
const LAUNCHES_STORAGE_KEY = 'v1-launches';
const CFG_STORAGE_KEY = 'v1-cfg';
const LOG_STORAGE_KEY = 'v1-log';
const LAST_TX_STORAGE_KEY = 'v1-last-tx';

const QUOTES = [
  { id: 'none', sym: 'None', name: 'No pairing', ic: '—', cat: 'all' },
  { id: 'SOL', sym: 'SOL', name: 'Solana', ic: '◎', cat: 'crypto' },
  { id: 'PUMP', sym: 'PUMP', name: 'Pump', ic: '💊', cat: 'crypto' },
  { id: 'USDC', sym: 'USDC', name: 'USD Coin · devnet', ic: '$', cat: 'crypto',
    ca: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' },
  { id: 'CA', sym: 'Custom', name: 'Any SPL token by CA', ic: '+', cat: 'custom' },
];

let wallet = null;            // session payer — signs the v1 bytes
let connectedB58 = null;      // connected browser wallet (owner of launches)
let pendingImage = null;      // data-URL of the token image
let selectedQuote = QUOTES[0];
let firstBuySol = 0;
let sortMode = 'recent';
let launches = JSON.parse(localStorage.getItem(LAUNCHES_STORAGE_KEY) || '[]');
const statsCache = new Map(); // mint -> { t, times } for card sparklines

// ------------------------------- helpers -----------------------------------
function log(msg, cls = '') {
  try {
    const lines = JSON.parse(localStorage.getItem(LOG_STORAGE_KEY) || '[]');
    lines.push({ t: Date.now(), msg, cls });
    localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(lines.slice(-200)));
  } catch {}
  console.log(`[v1] ${msg}`);
}

function status(msg, cls = '') {
  $('status').textContent = msg;
  $('status').className = cls;
}

function short(b58, n = 4) {
  return b58 ? `${b58.slice(0, n)}…${b58.slice(-n)}` : '';
}

function fmtCompact(n) {
  n = Number(n);
  if (!isFinite(n)) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return n.toLocaleString('en-US');
}

function timeAgo(ts) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function getCfg() {
  const cfg = JSON.parse(localStorage.getItem(CFG_STORAGE_KEY) || '{}');
  return {
    priorityFeeLamports: BigInt(cfg.priorityFee ?? '5000'),
    computeUnitLimit: parseInt(cfg.cuLimit ?? '200000', 10),
  };
}

const explorerTx = sig => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const explorerAddr = a => `https://explorer.solana.com/address/${a}?cluster=devnet`;

function quoteLabel(item) {
  if (!item.quote) return null;
  return item.quote === 'CA' ? short(item.ca, 4) : item.quote;
}

// ------------------------------- session payer ------------------------------
function loadOrCreateWallet() {
  const stored = localStorage.getItem(WALLET_STORAGE_KEY);
  if (stored) {
    try { wallet = nacl.sign.keyPair.fromSecretKey(b58decode(stored)); } catch { wallet = null; }
  }
  if (!wallet) {
    wallet = nacl.sign.keyPair();
    localStorage.setItem(WALLET_STORAGE_KEY, b58encode(wallet.secretKey));
  }
}

// ------------------------------- wallet connect -----------------------------
function getProvider() {
  return (window.phantom && window.phantom.solana) || window.solana || null;
}

function renderConnect() {
  $('connect-btn').textContent = connectedB58 ? short(connectedB58) : 'Connect';
}

// project token CA chip — placeholder until announced; set it from /admin
function renderCaPill() {
  const ca = localStorage.getItem('v1-project-ca');
  $('ca-pill').textContent = ca ? `CA · ${short(ca, 4)}` : 'CA · soon';
}

async function copyCa() {
  const ca = localStorage.getItem('v1-project-ca');
  const pill = $('ca-pill');
  if (!ca) {
    pill.textContent = 'CA · not announced yet';
    setTimeout(renderCaPill, 1600);
    return;
  }
  try { await navigator.clipboard.writeText(ca); pill.textContent = 'CA · copied ✓'; }
  catch { pill.textContent = `CA · ${short(ca, 6)}`; }
  setTimeout(renderCaPill, 1600);
}

async function toggleConnect() {
  const provider = getProvider();
  if (connectedB58) {
    try { await provider?.disconnect(); } catch {}
    connectedB58 = null;
    renderConnect();
    return;
  }
  if (!provider) {
    status('No Solana wallet extension found (Phantom etc.).', 'warn');
    return;
  }
  try {
    const res = await provider.connect();
    connectedB58 = res.publicKey.toString();
    renderConnect();
    log(`Wallet connected: ${connectedB58}`);
  } catch {}
}

// ------------------------------- token image --------------------------------
function processImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const S = 128, c = document.createElement('canvas');
      c.width = c.height = S;
      const ctx = c.getContext('2d');
      const m = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - m) / 2, (img.height - m) / 2, m, m, 0, 0, S, S);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('could not read image'));
    img.src = URL.createObjectURL(file);
  });
}

async function sha256hexOfDataUrl(dataUrl) {
  try {
    const bin = atob(dataUrl.split(',')[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const h = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(h), b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

function setPendingImage(dataUrl) {
  pendingImage = dataUrl;
  const box = $('img-box');
  box.innerHTML = dataUrl ? '' : '<span class="ic">🖼</span><span>ADD IMAGE</span>';
  if (dataUrl) {
    const img = document.createElement('img');
    img.src = dataUrl;
    box.appendChild(img);
  }
  updateSummary();
}

// ------------------------------- launch form ---------------------------------
function renderQuoteGrid(cat = 'all') {
  const grid = $('quote-grid');
  grid.innerHTML = '';
  for (const q of QUOTES) {
    if (cat !== 'all' && q.cat !== cat && q.id !== 'none') continue;
    const b = document.createElement('button');
    b.className = 'quote-card' + (selectedQuote.id === q.id ? ' on' : '');
    b.innerHTML = `<span class="q-ic">${q.ic}</span><span class="q-t"><span class="q-sym">${q.sym}</span><br><span class="q-name">${q.name}</span></span>`;
    b.addEventListener('click', () => {
      selectedQuote = q;
      $('ca-row').classList.toggle('hidden', q.id !== 'CA');
      renderQuoteGrid(cat);
      updateSummary();
    });
    grid.appendChild(b);
  }
}

function updateCounters() {
  $('cnt-name').textContent = `${$('token-name').value.length}/32`;
  $('cnt-ticker').textContent = `${$('token-symbol').value.length}/13`;
  $('cnt-desc').textContent = `${$('token-desc').value.length}/150`;
  $('cnt-x').textContent = `${$('token-x').value.length}/80`;
}

function updateSummary() {
  const name = $('token-name').value.trim();
  const ticker = $('token-symbol').value.trim().toUpperCase();
  $('sum-name').textContent = name || 'Untitled';
  $('sum-ticker').textContent = ticker ? `$${ticker}` : 'No ticker yet';
  const thumb = $('sum-thumb');
  thumb.innerHTML = pendingImage ? `<img src="${pendingImage}">` : '🖼';

  const paired = selectedQuote.id !== 'none';
  let qLabel = 'Nothing';
  if (paired) {
    qLabel = selectedQuote.id === 'CA'
      ? (short($('ca-input').value.trim(), 4) || 'Custom CA')
      : selectedQuote.sym;
  }
  $('sum-quote').textContent = qLabel;
  $('sum-reserve').textContent = paired ? `${parseInt($('reserve-pct').value, 10) || 0}%` : '—';
  $('sum-fb').textContent = firstBuySol > 0 ? `${firstBuySol} SOL` : 'None';
  $('sum-auth').textContent = $('revoke-mint').checked ? 'Revoked at launch'
    : connectedB58 ? `Yours (${short(connectedB58)})` : 'Session payer';

  const { priorityFeeLamports, computeUnitLimit } = getCfg();
  $('sum-fee').textContent = `${Number(priorityFeeLamports).toLocaleString('en-US')} lamports`;
  $('sum-cu').textContent = computeUnitLimit.toLocaleString('en-US');

  const est = (paired ? 1040 : 720) + $('token-desc').value.length + $('token-x').value.length +
    (pendingImage ? 60 : 0) + (firstBuySol > 0 ? 25 : 0) + (selectedQuote.id !== 'SOL' && paired ? 60 : 0);
  $('sum-size').textContent = `~${(est / 1024).toFixed(1)} KB / 4 KB`;
}

// ------------------------------- launch -------------------------------------
async function launchToken() {
  const btn = $('launch-btn');
  btn.disabled = true;
  try {
    const name = $('token-name').value.trim() || 'Unnamed Token';
    const symbol = ($('token-symbol').value.trim() || 'TOKEN').toUpperCase();
    const desc = $('token-desc').value.trim();
    const xLink = $('token-x').value.trim();
    const decimals = parseInt($('token-decimals').value, 10);
    const supplyStr = $('token-supply').value.trim().replace(/[,\s]/g, '');
    const paired = selectedQuote.id !== 'none';
    const reservePct = paired ? parseInt($('reserve-pct').value, 10) : 0;
    const revoke = $('revoke-mint').checked;
    const { priorityFeeLamports, computeUnitLimit } = getCfg();

    if (!(decimals >= 0 && decimals <= 9)) throw new Error('decimals must be 0–9');
    if (!/^\d+$/.test(supplyStr) || supplyStr === '0') throw new Error('supply must be a positive integer');
    if (paired && !(reservePct >= 1 && reservePct <= 90)) throw new Error('pool reserve must be 1–90%');

    let pairingCa = selectedQuote.ca || null;
    if (selectedQuote.id === 'CA') {
      pairingCa = $('ca-input').value.trim();
      let caBytes;
      try { caBytes = b58decode(pairingCa); } catch { caBytes = null; }
      if (!caBytes || caBytes.length !== 32) throw new Error('custom quote CA must be a valid mint address');
    }

    const total = BigInt(supplyStr) * 10n ** BigInt(decimals);
    if (total > 0xffffffffffffffffn) throw new Error('supply × 10^decimals exceeds u64');
    const reserveAmt = paired ? (total * BigInt(reservePct)) / 100n : 0n;
    const mainAmt = total - reserveAmt;
    if (mainAmt === 0n) throw new Error('pool reserve leaves no supply for the owner');

    const payer = wallet.publicKey;
    const owner = connectedB58 ? b58decode(connectedB58) : payer;
    status('Building SIMD-0385 v1 transaction …');
    log(`── Launch "${name}" ($${symbol}) · supply ${supplyStr} · owner ${connectedB58 ? short(connectedB58) : 'session payer'}` +
        `${paired ? ` · pump.fun vs ${selectedQuote.id === 'CA' ? short(pairingCa, 6) : selectedQuote.sym} (${reservePct}% reserve)` : ''}` +
        `${firstBuySol > 0 ? ` · first buy ${firstBuySol} SOL` : ''}${revoke ? ' · mint authority revoked' : ''}`);

    const imgSha = pendingImage ? await sha256hexOfDataUrl(pendingImage) : null;

    const [blockhashB58, rentMint, rentAcct, balance] = await Promise.all([
      RPC.getLatestBlockhash(),
      RPC.getMinimumBalanceForRentExemption(MINT_ACCOUNT_SIZE),
      RPC.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE),
      RPC.getBalance(b58encode(wallet.publicKey)).catch(() => 0),
    ]);
    const lifetime = b58decode(blockhashB58);

    const mint = nacl.sign.keyPair();
    const mainAcct = nacl.sign.keyPair();
    const reserveAcct = paired ? nacl.sign.keyPair() : null;
    log(`Mint: ${b58encode(mint.publicKey)}`);

    // temp mint authority = payer (it must sign MintTo inside this tx); at the
    // end authority is handed to the owner — or revoked — atomically
    const instructions = [
      ixCreateAccount(payer, mint.publicKey, rentMint, MINT_ACCOUNT_SIZE, TOKEN_PROGRAM_ID),
      ixInitializeMint2(mint.publicKey, decimals, payer),
      ixCreateAccount(payer, mainAcct.publicKey, rentAcct, TOKEN_ACCOUNT_SIZE, TOKEN_PROGRAM_ID),
      ixInitializeAccount3(mainAcct.publicKey, mint.publicKey, owner),
      ixMintTo(mint.publicKey, mainAcct.publicKey, payer, mainAmt),
    ];
    if (reserveAcct) {
      instructions.push(
        ixCreateAccount(payer, reserveAcct.publicKey, rentAcct, TOKEN_ACCOUNT_SIZE, TOKEN_PROGRAM_ID),
        ixInitializeAccount3(reserveAcct.publicKey, mint.publicKey, owner),
        ixMintTo(mint.publicKey, reserveAcct.publicKey, payer, reserveAmt),
      );
    }
    if (revoke) {
      instructions.push(ixSetMintAuthority(mint.publicKey, payer, null));
    } else if (!bytesEqual(owner, payer)) {
      instructions.push(ixSetMintAuthority(mint.publicKey, payer, owner));
    }
    instructions.push(ixMemo(JSON.stringify({
      launchpad: 'version-1', name, symbol,
      ...(desc ? { desc } : {}),
      ...(xLink ? { x: xLink } : {}),
      ...(imgSha ? { image: { sha256: imgSha } } : {}),
      ...(paired ? {
        pairing: {
          venue: 'pump.fun',
          quote: selectedQuote.id === 'SOL' || selectedQuote.id === 'PUMP'
            ? selectedQuote.id : { ca: pairingCa },
          reservePct,
        },
      } : {}),
      ...(firstBuySol > 0 ? { firstBuy: { sol: firstBuySol } } : {}),
    })));
    const signers = [wallet, mint, mainAcct, ...(reserveAcct ? [reserveAcct] : [])];

    const compiled = compileAccounts(payer, instructions);
    const v1 = encodeV1Transaction({
      compiled, lifetimeSpecifier: lifetime,
      config: { priorityFeeLamports, computeUnitLimit },
      signers,
    });
    const sanitized = decodeAndSanitizeV1(v1.bytes);
    try {
      localStorage.setItem(LAST_TX_STORAGE_KEY, JSON.stringify({
        t: Date.now(), name, symbol, size: v1.bytes.length,
        sections: v1.sections.map(s => ({ label: s.label, hex: toHex(s.bytes) })),
        checks: sanitized.checks,
        config: {
          priorityFeeLamports: String(sanitized.decoded?.config?.priorityFeeLamports ?? 0n),
          computeUnitLimit: sanitized.decoded?.config?.computeUnitLimit ?? null,
        },
      }));
    } catch {}
    log(`v1 tx: ${v1.bytes.length} bytes, ${signers.length} signatures, sanitizer ${sanitized.ok ? 'PASS' : 'FAIL'}`,
      sanitized.ok ? 'ok' : 'err');
    if (!sanitized.ok) throw new Error('v1 transaction failed local sanitization (see admin page)');

    const rentTotal = rentMint + rentAcct * (reserveAcct ? 2 : 1);
    if (balance < rentTotal + 3_000_000) {
      throw new Error(`launch payer needs ~${((rentTotal + 3_000_000) / LAMPORTS_PER_SOL).toFixed(4)} SOL — top it up on the admin page`);
    }

    status('Submitting v1 wire bytes …');
    let usedFormat = 'v1';
    let txSig;
    try {
      txSig = await RPC.sendRawTransaction(v1.bytes);
      log('RPC accepted the SIMD-0385 v1 format natively.', 'ok');
    } catch (e) {
      log(`RPC rejected v1 bytes: ${e.message}`, 'warn');
      usedFormat = 'legacy';
      const microPerCu = computeUnitLimit > 0 ? (priorityFeeLamports * 1_000_000n) / BigInt(computeUnitLimit) : 0n;
      const legacyIxs = [
        ixSetComputeUnitLimit(computeUnitLimit),
        ...(microPerCu > 0n ? [ixSetComputeUnitPrice(microPerCu)] : []),
        ...instructions,
      ];
      const legacy = encodeLegacyTransaction({
        compiled: compileAccounts(payer, legacyIxs), recentBlockhash: lifetime, signers,
      });
      if (legacy.bytes.length > 1232) throw new Error(`legacy fallback is ${legacy.bytes.length} bytes (max 1232) — shorten the description`);
      txSig = await RPC.sendRawTransaction(legacy.bytes);
    }

    status('Confirming …');
    await RPC.confirmSignature(txSig);
    log(`Confirmed (${usedFormat}): ${txSig}`, 'ok');
    status(`$${symbol} is live.`, 'ok');

    launches.unshift({
      name, symbol, mint: b58encode(mint.publicKey), sig: txSig,
      supply: supplyStr, decimals, format: usedFormat, desc, x: xLink,
      quote: paired ? (selectedQuote.id === 'CA' ? 'CA' : selectedQuote.sym) : null,
      ca: paired ? pairingCa : null,
      reservePct: paired ? reservePct : null, firstBuySol,
      owner: connectedB58 || b58encode(payer), revoked: revoke,
      img: pendingImage, imgSha, ts: Date.now(),
    });
    saveLaunches();
    setPendingImage(null);
    switchView('explore');
    renderExplore();
  } catch (e) {
    status(`Launch failed: ${e.message}`, 'err');
    log(`Launch failed: ${e.message}`, 'err');
    console.error(e);
  } finally {
    btn.disabled = false;
  }
}

function saveLaunches() {
  try {
    localStorage.setItem(LAUNCHES_STORAGE_KEY, JSON.stringify(launches));
  } catch {
    const slim = launches.map((l, i) => (i < 3 ? l : { ...l, img: null }));
    try { localStorage.setItem(LAUNCHES_STORAGE_KEY, JSON.stringify(slim)); } catch {}
  }
}

// ------------------------------- charts --------------------------------------
const CHART = { ink: '#0b0d0b', grid: '#e8eae8', muted: '#68706a', up: '#16a34a' };

function buildBuckets(timesSec, N) {
  if (!timesSec.length) return null;
  const now = Math.floor(Date.now() / 1000);
  const min = Math.min(...timesSec, now - 60);
  const span = Math.max(now - min, 60);
  const counts = new Array(N).fill(0);
  for (const t of timesSec) counts[Math.min(N - 1, Math.floor(((t - min) / span) * N))]++;
  return counts;
}

// small trend sparkline for coin cards / hero — single series, 2px line, wash
function trendSVG(timesSec, { w = 240, h = 46, color = CHART.up, tooltips = false } = {}) {
  const counts = buildBuckets(timesSec, 12);
  if (!counts) return null;
  const PX = 3, PT = 6, PB = 4, N = counts.length;
  const max = Math.max(...counts, 1);
  const x = i => PX + (i / (N - 1)) * (w - 2 * PX);
  const y = c => PT + (1 - c / max) * (h - PT - PB);
  const pts = counts.map((c, i) => `${x(i).toFixed(1)},${y(c).toFixed(1)}`);
  const line = `M${pts.join(' L')}`;
  const area = `${line} L${x(N - 1).toFixed(1)},${h - PB} L${x(0).toFixed(1)},${h - PB} Z`;
  const hover = tooltips ? counts.map((c, i) => {
    const bx = PX + (i / N) * (w - 2 * PX);
    return `<rect x="${bx.toFixed(1)}" y="0" width="${((w - 2 * PX) / N).toFixed(1)}" height="${h}" fill="transparent"><title>${c} transaction${c === 1 ? '' : 's'}</title></rect>`;
  }).join('') : '';
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="activity trend">
    <path d="${area}" fill="${color}" opacity="0.10"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(N - 1)}" cy="${y(counts[N - 1])}" r="4" fill="${color}" stroke="#ffffff" stroke-width="2"/>
    ${hover}</svg>`;
}

// modal activity chart — ink series on dark surface, baseline, tooltips
function sparklineSVG(timesSec) {
  const svg = trendSVG(timesSec, { w: 280, h: 72, color: CHART.ink, tooltips: true });
  return svg || `<div class="loading">No on-chain activity yet.</div>`;
}

// holder distribution — horizontal bars ≤24px, 4px rounded data-end, value at tip
function holderBarsSVG(holders, supplyRaw) {
  if (!holders.length) return `<div class="loading">No holders found.</div>`;
  const rows = holders.slice(0, 5);
  const BAR = 16, GAP = 10, LX = 92, W = 280;
  const H = rows.length * (BAR + GAP) - GAP + 4;
  const maxW = W - LX - 46;
  let out = '';
  rows.forEach((h, i) => {
    const pct = Number((BigInt(h.amount) * 10000n) / supplyRaw) / 100;
    const w = Math.max(3, (pct / 100) * maxW);
    const yTop = i * (BAR + GAP) + 2;
    const r = 4;
    const path = `M${LX},${yTop} L${(LX + w - r).toFixed(1)},${yTop} Q${(LX + w).toFixed(1)},${yTop} ${(LX + w).toFixed(1)},${yTop + r}` +
      ` L${(LX + w).toFixed(1)},${yTop + BAR - r} Q${(LX + w).toFixed(1)},${yTop + BAR} ${(LX + w - r).toFixed(1)},${yTop + BAR} L${LX},${yTop + BAR} Z`;
    out += `<text x="0" y="${yTop + BAR - 4}" font-size="10" font-family="ui-monospace,Consolas,monospace" fill="${CHART.muted}">${short(h.address, 4)}</text>` +
      `<path d="${path}" fill="${CHART.ink}"><title>${short(h.address, 6)} — ${pct.toFixed(2)}% of supply</title></path>` +
      `<text x="${(LX + w + 6).toFixed(1)}" y="${yTop + BAR - 4}" font-size="10.5" fill="${CHART.muted}">${pct.toFixed(1)}%</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="top holders, percent of supply">${out}</svg>`;
}

// ------------------------------- live stats -----------------------------------
async function fetchTokenStats(mintB58) {
  // sequential + individually fault-tolerant — the public devnet endpoint
  // rate-limits bursts and throttles some methods much harder than others
  const tryCall = async (method, params) => {
    try { return await RPC.call(method, params); } catch { return null; }
  };
  const supply = await tryCall('getTokenSupply', [mintB58]);
  const largest = await tryCall('getTokenLargestAccounts', [mintB58]);
  const sigs = await tryCall('getSignaturesForAddress', [mintB58, { limit: 50 }]);
  const info = await tryCall('getAccountInfo', [mintB58, { encoding: 'jsonParsed' }]);
  if (!supply && !sigs) throw new Error('RPC unavailable (rate-limited) — try refresh in a minute');

  const holders = largest ? (largest.value || []).filter(a => BigInt(a.amount) > 0n) : null;
  return {
    supplyUi: supply ? supply.value.uiAmountString : null,
    supplyRaw: supply ? BigInt(supply.value.amount) : null,
    holders,
    holdersCount: holders ? holders.length + (holders.length >= 20 ? '+' : '') : '—',
    txCount: sigs ? sigs.length + (sigs.length >= 50 ? '+' : '') : '—',
    txTimes: sigs ? sigs.map(s => s.blockTime).filter(Boolean) : null,
    mintAuthority: info ? (info.value?.data?.parsed?.info?.mintAuthority ?? null) : undefined,
  };
}

// ------------------------------- explore --------------------------------------
function heroStats() {
  $('hs-total').textContent = launches.length;
  $('hs-v1').textContent = launches.filter(l => l.format === 'v1').length;
  $('hs-paired').textContent = launches.filter(l => l.quote).length;
  const times = launches.map(l => Math.floor(l.ts / 1000));
  $('hero-spark').outerHTML = (trendSVG(times, { w: 240, h: 64, color: CHART.up }) ||
    `<svg id="hero-spark" viewBox="0 0 240 64"></svg>`).replace('<svg ', '<svg id="hero-spark" ');
}

function makeAvatar(item, cls) {
  let av;
  if (item.img) {
    av = document.createElement('img');
    av.src = item.img;
    av.alt = item.symbol;
  } else {
    av = document.createElement('div');
    av.textContent = (item.symbol || 'V')[0];
  }
  av.className = cls + (item.img ? '' : ' ph');
  return av;
}

function renderExplore() {
  heroStats();
  const q = $('search').value.trim().toLowerCase();
  let items = launches.filter(l =>
    !q || l.name.toLowerCase().includes(q) || l.symbol.toLowerCase().includes(q) || l.mint.toLowerCase().includes(q));
  if (sortMode === 'supply') items = [...items].sort((a, b) => Number(b.supply) - Number(a.supply));
  else if (sortMode === 'paired') items = [...items].sort((a, b) => (b.quote ? 1 : 0) - (a.quote ? 1 : 0) || b.ts - a.ts);
  else items = [...items].sort((a, b) => b.ts - a.ts);

  const grid = $('coin-grid');
  grid.innerHTML = '';
  $('grid-empty').classList.toggle('hidden', items.length > 0);
  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'coin-card';

    const top = document.createElement('div');
    top.className = 'cc-top';
    top.appendChild(makeAvatar(item, 'cc-av'));
    const names = document.createElement('div');
    names.className = 'cc-names';
    const ticker = document.createElement('div');
    ticker.className = 'cc-ticker';
    ticker.append(`$${item.symbol}`);
    const badge = document.createElement('span');
    badge.className = `cc-badge ${item.format === 'v1' ? 'v1' : ''}`;
    badge.textContent = item.format === 'v1' ? 'v1' : 'legacy';
    ticker.appendChild(badge);
    if (item.revoked) {
      const fx = document.createElement('span');
      fx.className = 'cc-badge';
      fx.textContent = 'fixed';
      ticker.appendChild(fx);
    }
    const nm = document.createElement('div');
    nm.className = 'cc-name';
    nm.textContent = item.name;
    names.append(ticker, nm);
    top.appendChild(names);

    const big = document.createElement('div');
    big.className = 'cc-big';
    big.textContent = fmtCompact(item.supply);
    const pays = document.createElement('div');
    pays.className = 'cc-pays';
    if (item.quote) {
      pays.append('Paired ');
      const chip = document.createElement('span');
      chip.className = 'q';
      chip.textContent = quoteLabel(item);
      pays.appendChild(chip);
    } else {
      pays.textContent = `supply · ${timeAgo(item.ts)}`;
    }

    const spark = document.createElement('div');
    spark.className = 'cc-flat';
    spark.textContent = 'loading activity …';
    spark.dataset.mint = item.mint;

    card.append(top, big, pays, spark);
    card.addEventListener('click', () => openModal(item));
    grid.appendChild(card);
  }
  hydrateCards();
}

// fetch per-card activity one at a time (public RPC hates bursts), cached 2 min
let hydrating = false;
async function hydrateCards() {
  if (hydrating) return;
  hydrating = true;
  try {
    for (const el of [...document.querySelectorAll('.cc-flat[data-mint]')]) {
      if (!el.isConnected) continue;
      const mint = el.dataset.mint;
      let entry = statsCache.get(mint);
      if (!entry || Date.now() - entry.t > 120000) {
        try {
          const sigs = await RPC.call('getSignaturesForAddress', [mint, { limit: 50 }]);
          entry = { t: Date.now(), times: sigs.map(s => s.blockTime).filter(Boolean) };
          statsCache.set(mint, entry);
          await new Promise(r => setTimeout(r, 350));
        } catch {
          el.textContent = 'activity unavailable';
          continue;
        }
      }
      const svg = trendSVG(entry.times);
      if (svg) {
        el.outerHTML = svg;
      } else {
        el.textContent = 'no activity yet';
      }
    }
  } finally {
    hydrating = false;
  }
}

// ------------------------------- modal -----------------------------------------
function openModal(item) {
  const head = $('modal-head');
  head.innerHTML = '';
  head.appendChild(makeAvatar(item, 'cc-av'));
  const t = document.createElement('div');
  t.innerHTML = `<div class="cc-ticker">$${item.symbol}</div><div class="cc-name">${item.name.replace(/</g, '&lt;')}${item.desc ? ` — ${item.desc.replace(/</g, '&lt;')}` : ''}</div>`;
  head.appendChild(t);
  const x = document.createElement('button');
  x.className = 'x';
  x.textContent = '✕';
  x.addEventListener('click', closeModal);
  head.appendChild(x);
  $('modal-bg').classList.remove('hidden');
  loadDetail(item, $('modal-body'));
}

function closeModal() {
  $('modal-bg').classList.add('hidden');
  $('modal-body').innerHTML = '';
}

async function loadDetail(item, detailEl) {
  detailEl.innerHTML = `<div class="loading">Loading live on-chain stats …</div>`;
  try {
    const s = await fetchTokenStats(item.mint);
    const authority = s.mintAuthority === undefined ? '—'
      : s.mintAuthority === null ? 'Revoked' : short(s.mintAuthority);
    const stat = (label, value) =>
      `<div class="stat"><div class="s-label">${label}</div><div class="s-value">${value}</div></div>`;
    const unavailable = msg => `<div class="loading">${msg} unavailable on this RPC right now — refresh in a minute.</div>`;
    detailEl.innerHTML =
      `<div class="stats-grid">` +
        stat('Supply', s.supplyUi !== null ? fmtCompact(s.supplyUi) : '—') +
        stat('Holders', s.holdersCount) +
        stat('Transactions', s.txCount) +
        stat('Mint authority', authority) +
      `</div>` +
      `<div class="chart-block"><div class="chart-title">Activity — transactions over time</div>${
        s.txTimes ? sparklineSVG(s.txTimes) : unavailable('Activity data')}</div>` +
      `<div class="chart-block"><div class="chart-title">Top holders — % of supply</div>${
        s.holders && s.supplyRaw ? holderBarsSVG(s.holders, s.supplyRaw) : unavailable('Holder data')}</div>` +
      `<div class="detail-links">` +
        `<a href="${explorerAddr(item.mint)}" target="_blank">Mint on Explorer</a>` +
        `<a href="${explorerTx(item.sig)}" target="_blank">Launch tx</a>` +
        (item.x ? `<a href="${item.x.startsWith('http') ? item.x : 'https://' + item.x}" target="_blank">X</a>` : '') +
        (item.quote ? `<a href="https://pump.fun/coin/${item.mint}" target="_blank">pump.fun (mainnet)</a>` +
          `<span>${item.reservePct}% reserved vs ${quoteLabel(item)}</span>` : '') +
        (item.firstBuySol > 0 ? `<span>first buy ${item.firstBuySol} SOL</span>` : '') +
        `<span style="margin-left:auto"><a href="#" data-refresh>refresh</a></span>` +
      `</div>`;
    detailEl.querySelector('[data-refresh]').addEventListener('click', e => {
      e.preventDefault();
      loadDetail(item, detailEl);
    });
  } catch (e) {
    detailEl.innerHTML = `<div class="loading">Could not load stats: ${e.message}</div>`;
  }
}

// ------------------------------- views + wiring --------------------------------
function switchView(view) {
  $('nav-explore').classList.toggle('on', view === 'explore');
  $('nav-launch').classList.toggle('on', view === 'launch');
  $('view-explore').classList.toggle('hidden', view !== 'explore');
  $('view-launch').classList.toggle('hidden', view !== 'launch');
  if (view === 'explore') renderExplore();
  else updateSummary();
}

window.addEventListener('DOMContentLoaded', () => {
  $('nav-explore').addEventListener('click', () => switchView('explore'));
  $('nav-launch').addEventListener('click', () => switchView('launch'));
  $('hero-launch').addEventListener('click', () => switchView('launch'));
  $('connect-btn').addEventListener('click', toggleConnect);
  $('ca-pill').addEventListener('click', copyCa);
  $('launch-btn').addEventListener('click', launchToken);
  $('modal-bg').addEventListener('click', e => { if (e.target === $('modal-bg')) closeModal(); });

  // search + sort
  $('search').addEventListener('input', renderExplore);
  for (const b of $('sort-pills').querySelectorAll('button')) {
    b.addEventListener('click', () => {
      sortMode = b.dataset.sort;
      for (const x of $('sort-pills').querySelectorAll('button')) x.classList.toggle('on', x === b);
      renderExplore();
    });
  }

  // image picker
  $('img-box').addEventListener('click', () => $('token-image').click());
  $('token-image').addEventListener('change', async () => {
    const file = $('token-image').files[0];
    if (!file) return;
    try { setPendingImage(await processImage(file)); }
    catch (e) { status(`Image error: ${e.message}`, 'err'); }
    $('token-image').value = '';
  });

  // first buy
  for (const b of $('fb-seg').querySelectorAll('button')) {
    b.addEventListener('click', () => {
      firstBuySol = parseFloat(b.dataset.sol);
      $('fb-custom').value = '';
      for (const x of $('fb-seg').querySelectorAll('button')) x.classList.toggle('on', x === b);
      updateSummary();
    });
  }
  $('fb-custom').addEventListener('input', () => {
    const v = parseFloat($('fb-custom').value);
    if (!isNaN(v) && v >= 0) {
      firstBuySol = v;
      for (const x of $('fb-seg').querySelectorAll('button')) x.classList.remove('on');
      updateSummary();
    }
  });

  // quote tabs
  for (const b of $('qtabs').querySelectorAll('button')) {
    b.addEventListener('click', () => {
      for (const x of $('qtabs').querySelectorAll('button')) x.classList.toggle('on', x === b);
      renderQuoteGrid(b.dataset.cat);
    });
  }

  // live summary
  for (const id of ['token-name', 'token-symbol', 'token-desc', 'token-x', 'reserve-pct', 'ca-input', 'token-supply', 'token-decimals']) {
    $(id).addEventListener('input', () => { updateCounters(); updateSummary(); });
  }
  $('revoke-mint').addEventListener('change', updateSummary);

  loadOrCreateWallet();
  renderConnect();
  renderCaPill();
  renderQuoteGrid('all');
  updateCounters();
  updateSummary();
  renderExplore();
  log('User page loaded.');
});
