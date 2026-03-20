#!/usr/bin/env node
/*
 ╔═══════════════════════════════════════════════════════════╗
 ║  PIXEL SQUIRREL  v3.0  —  ZEP Runner                    ║
 ║  Single-file Node.js + SQLite + Solana Web3 Game         ║
 ╠═══════════════════════════════════════════════════════════╣
 ║  SETUP:                                                   ║
 ║    npm install                                            ║
 ║    node server.js                                         ║
 ║                                                           ║
 ║  HOSTINGER: point Node.js app root to this directory.     ║
 ║  Set PORT env var if needed (default 3000).               ║
 ╚═══════════════════════════════════════════════════════════╝
*/
'use strict';

const express  = require('express');
const Database = require('better-sqlite3');
const splToken = require('@solana/spl-token');
const web3     = require('@solana/web3.js');

const PORT          = process.env.PORT || 3000;
const MAX_LIVES_HR  = 5;
const ZEP_COST      = 100;

// ─────────────────────────────────────────────────────────────
//  DATABASE
// ─────────────────────────────────────────────────────────────
const db = new Database('squirrel.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS scores (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet  TEXT    NOT NULL,
    handle  TEXT    NOT NULL DEFAULT 'Anon',
    score   INTEGER NOT NULL DEFAULT 0,
    acorns  INTEGER NOT NULL DEFAULT 0,
    dist    INTEGER NOT NULL DEFAULT 0,
    ts      INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS life_purchases (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet  TEXT NOT NULL,
    tx_sig  TEXT NOT NULL UNIQUE,
    ts      INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS i_score ON scores(score DESC);
  CREATE INDEX IF NOT EXISTS i_wal   ON scores(wallet);
  CREATE INDEX IF NOT EXISTS i_lp    ON life_purchases(wallet, ts);
`);

// Prepared statements
const stmts = {
  insertScore:   db.prepare('INSERT INTO scores(wallet,handle,score,acorns,dist) VALUES(?,?,?,?,?)'),
  leaderboard:   db.prepare('SELECT wallet,handle,MAX(score) score,MAX(acorns) acorns,MAX(dist) dist FROM scores GROUP BY wallet ORDER BY score DESC LIMIT 20'),
  rankAbove:     db.prepare('SELECT COUNT(*)+1 rank FROM (SELECT MAX(score) b FROM scores GROUP BY wallet) WHERE b > ?'),
  personalBest:  db.prepare('SELECT MAX(score) best FROM scores WHERE wallet=?'),
  dupeTx:        db.prepare('SELECT id FROM life_purchases WHERE tx_sig=?'),
  livesUsed:     db.prepare('SELECT COUNT(*) n FROM life_purchases WHERE wallet=? AND ts>?'),
  insertPurchase:db.prepare('INSERT INTO life_purchases(wallet,tx_sig) VALUES(?,?)'),
};

// ─────────────────────────────────────────────────────────────
//  RPC HELPER  — tries multiple endpoints, retries on 429/null
// ─────────────────────────────────────────────────────────────
const RPC_ENDPOINTS = [
  'https://api.mainnet-beta.solana.com',
  'https://rpc.ankr.com/solana',
  'https://solana-mainnet.rpc.extrnode.com',
];

async function rpcCall(body, timeoutMs = 8000) {
  let lastErr;
  for (const url of RPC_ENDPOINTS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(url, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(body),
          signal:  controller.signal,
        });
        clearTimeout(timer);
        if (res.status === 429) { await new Promise(r => setTimeout(r, 600 * (attempt + 1))); continue; }
        const data = await res.json();
        if (data?.result !== undefined) return data;  // success
        lastErr = new Error('Null result from ' + url);
      } catch (e) {
        lastErr = e;
        if (attempt === 0) await new Promise(r => setTimeout(r, 400));
      }
    }
  }
  throw lastErr || new Error('All RPC endpoints failed');
}

// ─────────────────────────────────────────────────────────────
//  EXPRESS
// ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '16kb' }));

// CORS (needed if you later split front/back)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── GET /api/leaderboard ─────────────────────────────────────
app.get('/api/leaderboard', (_, res) => {
  res.json(stmts.leaderboard.all());
});

// ── POST /api/score ──────────────────────────────────────────
app.post('/api/score', (req, res) => {
  let { wallet, handle, score, acorns, dist } = req.body;
  if (!wallet) return res.status(400).json({ error: 'wallet required' });

  handle = String(handle || 'Anon').replace(/[^\w\s\-.]/g, '').trim().slice(0, 20) || 'Anon';
  score  = Math.max(0, Math.floor(+score  || 0));
  acorns = Math.max(0, Math.floor(+acorns || 0));
  dist   = Math.max(0, Math.floor(+dist   || 0));

  stmts.insertScore.run(wallet, handle, score, acorns, dist);

  const { rank } = stmts.rankAbove.get(score)        || { rank: 1 };
  const { best } = stmts.personalBest.get(wallet)    || { best: score };

  res.json({ ok: true, rank, personalBest: best });
});

// ── POST /api/grant-life ─────────────────────────────────────
// Client-trusted: we verify the tx signature hasn't been used before
// (server-side replay protection) and the hourly cap is respected.
app.post('/api/grant-life', (req, res) => {
  const { wallet, txSig } = req.body;
  if (!wallet || !txSig) return res.status(400).json({ error: 'wallet + txSig required' });

  if (stmts.dupeTx.get(txSig))
    return res.status(409).json({ error: 'Transaction already used' });

  const hourAgo = Math.floor(Date.now() / 1000) - 3600;
  const { n }   = stmts.livesUsed.get(wallet, hourAgo);

  if (n >= MAX_LIVES_HR)
    return res.status(429).json({ error: 'Hourly limit of 5 extra lives reached' });

  stmts.insertPurchase.run(wallet, txSig);
  res.json({ ok: true, livesRemaining: MAX_LIVES_HR - n - 1 });
});


// ── GET /api/blockhash ───────────────────────────────────────
// Proxies getLatestBlockhash — retries across fallback RPCs
app.get('/api/blockhash', async (_req, res) => {
  try {
    const data = await rpcCall({ jsonrpc:'2.0', id:1, method:'getLatestBlockhash', params:[{ commitment:'confirmed' }] });
    const val  = data?.result?.value;
    if (!val) return res.status(502).json({ error: 'Bad RPC response' });
    res.json({ blockhash: val.blockhash, lastValidBlockHeight: val.lastValidBlockHeight });
  } catch(e) {
    console.warn('blockhash proxy error:', e.message);
    res.status(502).json({ error: 'RPC unavailable — try again in a moment' });
  }
});





// ── POST /api/build-transfer ─────────────────────────────────
app.post('/api/build-transfer', async (req, res) => {
  const { senderWallet, livesCount } = req.body;
  if (!senderWallet || !/^[1-9A-HJ-NP-Za-km-z]{32,88}$/.test(senderWallet))
    return res.status(400).json({ error: 'Bad wallet' });
  const lives = Math.min(5, Math.max(1, parseInt(livesCount) || 1));

  try {
    const mint      = new web3.PublicKey('6o4MAKKTwdtni9o6NdiR5HgGC62pL6YmqDNBhoPmVray');
    const sender    = new web3.PublicKey(senderWallet);
    const recipient = new web3.PublicKey('24Ti8yNf29t4E1mJdzDkEyBCrMFggrqLLFkmDbLrLZxV');

    // Use first available RPC endpoint (with fallbacks) for getMint
    let mintInfo, lastErr2;
    for (const url of RPC_ENDPOINTS) {
      try {
        const c = new web3.Connection(url, 'confirmed');
        mintInfo = await splToken.getMint(c, mint);
        break;
      } catch(e) { lastErr2 = e; }
    }
    if (!mintInfo) throw lastErr2 || new Error('Could not fetch mint info');

    const decimals   = mintInfo.decimals;
    const amount     = BigInt(Math.round(lives * 100 * Math.pow(10, decimals)));

    const senderATA  = await splToken.getAssociatedTokenAddress(mint, sender);
    const recipATA   = await splToken.getAssociatedTokenAddress(mint, recipient);

    const createIx   = splToken.createAssociatedTokenAccountIdempotentInstruction(
      sender, recipATA, recipient, mint
    );
    const transferIx = splToken.createTransferCheckedInstruction(
      senderATA, mint, recipATA, sender, amount, decimals
    );

    function serializeIx(ix) {
      return {
        programId: ix.programId.toString(),
        keys: ix.keys.map(k => ({
          pubkey:     k.pubkey.toString(),
          isSigner:   k.isSigner,
          isWritable: k.isWritable,
        })),
        data: Array.from(ix.data),
      };
    }

    res.json({
      senderATA:  senderATA.toString(),
      recipATA:   recipATA.toString(),
      decimals,
      amount:     amount.toString(),
      instructions: [serializeIx(createIx), serializeIx(transferIx)],
    });
  } catch(e) {
    console.warn('build-transfer error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── POST /api/simulate-tx ────────────────────────────────────
// Runs simulateTransaction server-side before wallet popup.
// If the RPC is flaky/rate-limited we warn but don't block —
// Phantom runs its own preflight simulation on sign anyway.
app.post('/api/simulate-tx', async (req, res) => {
  const { tx } = req.body;
  if (!tx || !Array.isArray(tx)) return res.status(400).json({ error: 'tx array required' });
  try {
    const encoded = Buffer.from(tx).toString('base64');
    const data = await rpcCall({
      jsonrpc: '2.0', id: 1,
      method: 'simulateTransaction',
      params: [encoded, {
        encoding:               'base64',
        commitment:             'confirmed',
        sigVerify:              false,
        replaceRecentBlockhash: true,
      }]
    }, 10000);

    const result = data?.result?.value;
    if (!result) {
      // RPC returned something unexpected — log it but don't block the user.
      // Phantom's own preflight will catch real instruction errors.
      console.warn('simulate-tx: unexpected RPC shape, skipping:', JSON.stringify(data).slice(0,200));
      return res.json({ ok: true, skipped: true });
    }
    if (result.err) {
      const errStr = JSON.stringify(result.err);
      let friendly = 'Transaction would fail: ' + errStr;
      if (errStr.includes('InsufficientFunds'))    friendly = 'Insufficient SOL for fees';
      if (errStr.includes('TokenAccountNotFound')) friendly = 'Token account not found';
      if (errStr.includes('Custom":1'))            friendly = 'Insufficient ZEP balance';
      return res.status(400).json({ error: friendly, raw: result.err, logs: result.logs });
    }
    res.json({ ok: true, unitsConsumed: result.unitsConsumed, logs: result.logs });
  } catch(e) {
    // RPC completely unavailable — warn, but let Phantom's preflight handle it
    console.warn('simulate-tx error (non-fatal):', e.message);
    res.json({ ok: true, skipped: true, warn: 'Server simulation unavailable; Phantom preflight will run' });
  }
});

// ── POST /api/send-tx ────────────────────────────────────────
app.post('/api/send-tx', async (req, res) => {
  const { tx } = req.body;
  if (!tx || !Array.isArray(tx)) return res.status(400).json({ error: 'tx array required' });
  try {
    const encoded = Buffer.from(tx).toString('base64');
    const data = await rpcCall({
      jsonrpc: '2.0', id: 1,
      method: 'sendTransaction',
      params: [encoded, { encoding: 'base64', preflightCommitment: 'confirmed' }]
    });
    if (data.error) return res.status(400).json({ error: data.error.message || 'RPC error' });
    res.json({ signature: data.result });
  } catch(e) {
    console.warn('send-tx error:', e.message);
    res.status(502).json({ error: 'RPC error: ' + e.message });
  }
});

// ── POST /api/confirm-tx ─────────────────────────────────────
app.post('/api/confirm-tx', async (req, res) => {
  const { signature } = req.body;
  if (!signature) return res.status(400).json({ error: 'signature required' });
  try {
    let attempts = 0;
    while (attempts < 30) {
      const data = await rpcCall({
        jsonrpc: '2.0', id: 1,
        method: 'getSignatureStatuses',
        params: [[signature], { searchTransactionHistory: true }]
      });
      const status = data?.result?.value?.[0];
      if (status) {
        if (status.err) return res.status(400).json({ error: 'Transaction failed on-chain', detail: status.err });
        if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')
          return res.json({ confirmed: true, slot: status.slot });
      }
      await new Promise(r => setTimeout(r, 2000));
      attempts++;
    }
    res.status(408).json({ error: 'Confirmation timeout' });
  } catch(e) {
    console.warn('confirm-tx error:', e.message);
    res.status(502).json({ error: 'RPC error: ' + e.message });
  }
});

// ── GET /api/lives-remaining?wallet=xxx ──────────────────────
app.get('/api/lives-remaining', (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'wallet required' });
  const hourAgo     = Math.floor(Date.now() / 1000) - 3600;
  const { n }       = stmts.livesUsed.get(wallet, hourAgo);
  res.json({ livesRemaining: Math.max(0, MAX_LIVES_HR - n) });
});

// ── GET /api/zep-balance/:wallet ─────────────────────────────
app.get('/api/zep-balance/:wallet', async (req, res) => {
  const { wallet } = req.params;
  if (!wallet || !/^[1-9A-HJ-NP-Za-km-z]{32,88}$/.test(wallet))
    return res.status(400).json({ error: 'Bad wallet' });
  try {
    const data = await rpcCall({
      jsonrpc: '2.0', id: 1,
      method: 'getTokenAccountsByOwner',
      params: [
        wallet,
        { mint: '6o4MAKKTwdtni9o6NdiR5HgGC62pL6YmqDNBhoPmVray' },
        { encoding: 'jsonParsed' }
      ]
    });
    const accounts = data?.result?.value || [];
    if (accounts.length === 0) return res.json({ balance: 0, decimals: 9 });
    const info = accounts[0].account.data.parsed.info.tokenAmount;
    res.json({ balance: parseFloat(info.uiAmount || 0), decimals: info.decimals });
  } catch (e) {
    console.warn('ZEP balance proxy error:', e.message);
    res.status(502).json({ error: 'RPC error' });
  }
});

// ── GET * → serve the game ───────────────────────────────────
app.get('*', (_, res) => res.type('html').send(gameHTML()));

app.listen(PORT, () => {
  console.log('\n  🐿  Pixel Squirrel  →  http://localhost:' + PORT);
  console.log('  DB  →  squirrel.db\n');
});

// ═════════════════════════════════════════════════════════════
//  GAME HTML  (everything the browser needs, fully inlined)
// ═════════════════════════════════════════════════════════════
function gameHTML() {
/* NOTE: backticks inside this template literal are escaped as \`
   and </script> tags are written as <\/script>                   */
return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>🐿 Pixel Squirrel — ZEP Runner</title>
<link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>
/* ── Gay Men's Flag palette ──────────────────────────── */
:root{
  --g1:#078D70; --g2:#26D07C; --g3:#98E8C1;
  --g4:#FFFFFF; --g5:#7BADE2; --g6:#4D60A4; --g7:#3D1A78;
  --bg:#07040F; --red:#FF4470; --gold:#FFD700;
}
*{margin:0;padding:0;box-sizing:border-box;}
body{
  background:var(--bg);font-family:'Share Tech Mono',monospace;
  height:100dvh;display:flex;flex-direction:column;
  overflow:hidden;user-select:none;-webkit-tap-highlight-color:transparent;
}
.flag{
  width:100%;height:5px;flex-shrink:0;
  background:linear-gradient(90deg,
    var(--g1) 0%,var(--g1) 14.3%,var(--g2) 14.3%,var(--g2) 28.6%,
    var(--g3) 28.6%,var(--g3) 42.9%,var(--g4) 42.9%,var(--g4) 57.1%,
    var(--g5) 57.1%,var(--g5) 71.4%,var(--g6) 71.4%,var(--g6) 85.7%,
    var(--g7) 85.7%,var(--g7) 100%);
}
/* Top bar */
#bar{
  display:flex;align-items:center;gap:8px;padding:5px 12px;
  background:linear-gradient(90deg,var(--g7) 0%,var(--g6) 55%,var(--g1) 100%);
  border-bottom:2px solid var(--g2);flex-shrink:0;flex-wrap:wrap;z-index:30;
}
#title{
  font-family:'Press Start 2P',monospace;font-size:10px;color:var(--g3);
  text-shadow:0 0 10px var(--g2),2px 2px 0 var(--g7);
  margin-right:auto;white-space:nowrap;letter-spacing:.5px;
}
.pill{
  font-size:10px;padding:3px 10px;border-radius:20px;
  border:1.5px solid;font-family:'Share Tech Mono',monospace;white-space:nowrap;
  transition:all .2s;
}
#p-level{color:#fff;border-color:var(--g5);background:rgba(77,96,164,.22);font-family:'Press Start 2P',monospace;font-size:8px;letter-spacing:1px;transition:color .4s,border-color .4s;}
#p-score{color:var(--g3);border-color:var(--g1);background:rgba(7,141,112,.15);}
#p-lives{color:var(--red);border-color:var(--red);background:rgba(255,68,112,.12);font-weight:700;}
#p-multi{color:#FF88FF;border-color:#CC44CC;background:rgba(200,68,200,.1);display:none;}
#p-zep{color:var(--gold);border-color:#C8A500;background:rgba(200,165,0,.1);display:none;}
#p-wallet{color:var(--g5);border-color:var(--g6);background:rgba(77,96,164,.2);display:none;font-size:9px;}
.tbtn{
  font-family:'Press Start 2P',monospace;font-size:7px;
  padding:6px 11px;border-radius:5px;border:2px solid;cursor:pointer;
  transition:all .15s;text-decoration:none;display:inline-flex;
  align-items:center;gap:4px;white-space:nowrap;letter-spacing:.3px;
}
#btn-wallet{background:var(--g7);color:var(--g3);border-color:var(--g5);}
#btn-wallet:hover{background:var(--g6);box-shadow:0 0 12px var(--g5);}
#btn-lb{background:rgba(61,26,120,.6);color:var(--g5);border-color:var(--g6);}
#btn-lb:hover{background:var(--g6);color:var(--g3);}
#btn-buyzep{background:linear-gradient(135deg,var(--g1),var(--g2));color:#000;border-color:var(--g2);}
#btn-buyzep:hover{box-shadow:0 0 14px var(--g2);transform:scale(1.04);}

/* Wrap + canvas */
#wrap{flex:1;position:relative;overflow:hidden;min-height:0;}
#c{display:block;width:100%;height:100%;cursor:pointer;}

/* Leaderboard slide panel */
#lb-panel{
  position:absolute;top:0;right:0;bottom:0;width:290px;
  background:rgba(5,2,18,.97);border-left:2px solid var(--g6);
  transform:translateX(100%);transition:transform .28s ease;
  z-index:25;display:flex;flex-direction:column;
}
#lb-panel.open{transform:translateX(0);}
#lb-head{
  padding:14px 16px 10px;border-bottom:1px solid var(--g6);
  font-family:'Press Start 2P',monospace;font-size:9px;color:var(--g2);
  display:flex;align-items:center;justify-content:space-between;flex-shrink:0;
}
#lb-close{
  background:transparent;border:1px solid var(--g6);color:var(--g5);
  border-radius:4px;cursor:pointer;padding:3px 8px;font-size:12px;
}
#lb-close:hover{background:var(--g6);}
#lb-body{flex:1;overflow-y:auto;padding:8px 12px;}
.lb-row{
  display:grid;grid-template-columns:28px 1fr 80px;
  gap:6px;align-items:center;padding:7px 4px;
  border-bottom:1px solid rgba(77,96,164,.25);font-size:10px;
}
.lb-row.me{background:rgba(38,208,124,.07);border-radius:5px;border-bottom-color:transparent;}
.lb-rank{color:var(--g5);font-weight:700;text-align:center;}
.lb-rank.gold{color:var(--gold);}
.lb-rank.silver{color:#C0C0C0;}
.lb-rank.bronze{color:#CD7F32;}
.lb-name{color:var(--g3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.lb-score{color:var(--gold);text-align:right;font-weight:700;}
.lb-empty{color:var(--g6);font-size:11px;text-align:center;margin-top:24px;}

/* Overlay screens */
.screen{
  position:absolute;inset:0;display:flex;flex-direction:column;
  align-items:center;justify-content:center;
  background:rgba(7,4,15,.91);z-index:20;backdrop-filter:blur(4px);
}
.s-title{
  font-family:'Press Start 2P',monospace;
  font-size:clamp(18px,4.5vw,46px);text-align:center;line-height:1.5;
  margin-bottom:14px;
  background:linear-gradient(135deg,var(--g2) 0%,var(--g5) 38%,var(--g3) 68%,var(--g4) 100%);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
  filter:drop-shadow(0 0 20px var(--g5));
}
.screen p{font-size:11px;color:var(--g3);margin-bottom:5px;text-align:center;line-height:1.8;}
.screen p.dim{color:var(--g5);font-size:10px;}
.bbtn{
  font-family:'Press Start 2P',monospace;font-size:9px;
  padding:12px 24px;border-radius:8px;border:2px solid;
  cursor:pointer;transition:all .18s;margin-top:12px;
}
.bplay{background:linear-gradient(135deg,var(--g7),var(--g6));color:var(--g3);border-color:var(--g5);}
.bplay:hover{transform:scale(1.06);box-shadow:0 0 26px var(--g5);}
.bpay{background:linear-gradient(135deg,var(--g1),var(--g2));color:#000;border-color:var(--g2);}
.bpay:hover{box-shadow:0 0 22px var(--g2);transform:scale(1.05);}
.bpay:disabled{opacity:.45;cursor:not-allowed;transform:none;}
.bdiv{width:180px;height:1px;background:linear-gradient(90deg,transparent,var(--g5),transparent);margin:12px 0;}
.sbig{font-family:'Press Start 2P',monospace;font-size:clamp(11px,2.2vw,17px);color:var(--g2);margin-bottom:4px;}

/* Game-over bottom card (canvas shows GAME OVER text) */
#scr-over{
  background:transparent!important;backdrop-filter:none!important;
  justify-content:flex-end;padding-bottom:42px;
}
#go-card{
  background:rgba(5,2,18,.96);border:1.5px solid var(--g5);
  border-radius:14px;padding:18px 28px;
  display:flex;flex-direction:column;align-items:center;gap:3px;
  backdrop-filter:blur(12px);
}

/* Ready screen (shown after life purchase) */
#scr-ready{
  position:absolute;inset:0;display:none;flex-direction:column;
  align-items:center;justify-content:center;z-index:18;
  background:rgba(7,4,15,.92);backdrop-filter:blur(6px);
}
#scr-ready.show{display:flex;}
.ready-title{
  font-family:'Press Start 2P',monospace;
  font-size:clamp(28px,6vw,58px);text-align:center;
  margin-bottom:10px;letter-spacing:3px;
  background:linear-gradient(135deg,var(--g2) 0%,var(--g5) 45%,var(--g4) 100%);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
  filter:drop-shadow(0 0 28px var(--g5));
  animation:readyPulse 1.4s ease-in-out infinite;
}
@keyframes readyPulse{0%,100%{filter:drop-shadow(0 0 18px var(--g5));}50%{filter:drop-shadow(0 0 44px var(--g2));}}
.ready-sub{font-size:11px;color:var(--g3);margin-bottom:4px;text-align:center;}
.ready-lives{font-family:'Press Start 2P',monospace;font-size:12px;color:#FF8FAB;margin-bottom:14px;}

/* Handle modal */
#modal-handle{
  position:absolute;inset:0;background:rgba(7,4,15,.97);
  z-index:50;display:none;flex-direction:column;
  align-items:center;justify-content:center;gap:14px;
}
#modal-handle.show{display:flex;}
#modal-handle h2{font-family:'Press Start 2P',monospace;font-size:11px;color:var(--g2);text-align:center;}
#modal-handle p{font-size:11px;color:var(--g5);text-align:center;}
#handle-inp{
  font-family:'Share Tech Mono',monospace;font-size:16px;
  background:rgba(61,26,120,.45);color:var(--g4);
  border:2px solid var(--g5);border-radius:8px;
  padding:10px 16px;outline:none;width:230px;text-align:center;
  transition:border-color .2s;
}
#handle-inp:focus{border-color:var(--g2);}

/* Life picker modal */
#modal-lives{
  position:absolute;inset:0;background:rgba(7,4,15,.96);
  z-index:55;display:none;flex-direction:column;
  align-items:center;justify-content:center;gap:16px;
  backdrop-filter:blur(6px);
}
#modal-lives.show{display:flex;}
#modal-lives h2{font-family:'Press Start 2P',monospace;font-size:11px;color:var(--g2);text-align:center;line-height:1.7;}
#modal-lives .dim{font-size:10px;color:var(--g5);text-align:center;}
/* Life amount selector buttons */
.life-opts{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;}
.life-opt{
  font-family:'Press Start 2P',monospace;font-size:9px;
  padding:9px 14px;border-radius:8px;border:2px solid var(--g6);
  background:rgba(61,26,120,.4);color:var(--g5);cursor:pointer;
  transition:all .15s;min-width:52px;text-align:center;
}
.life-opt:hover{border-color:var(--g5);color:#fff;}
.life-opt.selected{
  border-color:var(--g2);color:var(--g2);
  background:rgba(38,208,124,.14);
  box-shadow:0 0 14px rgba(38,208,124,.35);
}
#lives-cost-display{
  font-family:'Press Start 2P',monospace;font-size:13px;
  color:var(--gold);text-align:center;letter-spacing:1px;
}
#lives-cost-sub{font-size:9px;color:var(--g5);text-align:center;margin-top:-8px;}
.modal-btns{display:flex;gap:12px;flex-wrap:wrap;justify-content:center;}

/* Toast */
#toast{
  position:absolute;top:62px;left:50%;
  transform:translateX(-50%) translateY(-8px);
  background:rgba(14,5,40,.97);color:var(--g3);
  padding:9px 22px;border-radius:24px;border:1.5px solid var(--g5);
  font-size:11px;z-index:70;opacity:0;
  transition:opacity .25s,transform .25s;pointer-events:none;
  white-space:nowrap;max-width:92vw;
}
#toast.on{opacity:1;transform:translateX(-50%) translateY(0);}

/* Power-up HUD icons */
#powerups-hud{
  position:absolute;bottom:12px;left:12px;z-index:15;
  display:flex;gap:8px;
}
.pu-icon{
  width:36px;height:36px;border-radius:8px;border:2px solid;
  display:flex;align-items:center;justify-content:center;
  font-size:18px;transition:all .2s;
  animation:pulsePU 1s infinite;
}
@keyframes pulsePU{0%,100%{transform:scale(1);}50%{transform:scale(1.1);}}
</style>
</head>
<body>
<div class="flag"></div>

<div id="bar">
  <div id="title">🐿 PIXEL SQUIRREL <span style="font-size:7px;opacity:0.5;letter-spacing:0">v3.0</span></div>
  <div class="pill" id="p-level">LV 1</div>
  <div class="pill" id="p-score">SCORE: 0</div>
  <div class="pill" id="p-lives">❤ 3</div>
  <div class="pill" id="p-multi">2x COMBO!</div>
  <div class="pill" id="p-zep">🌰 ZEP: —</div>
  <div class="pill" id="p-wallet"></div>
  <button class="tbtn" id="btn-lb">🏆 SCORES</button>
  <button class="tbtn" id="btn-wallet">⬡ WALLET</button>
  <a class="tbtn" id="btn-buyzep"
    href="https://raydium.io/launchpad/token/?mint=6o4MAKKTwdtni9o6NdiR5HgGC62pL6YmqDNBhoPmVray&lreferrer=FxFHWMsSXmK9AB3Ui4JnkUYF4jjbG8QJBi1db6nAMPho"
    target="_blank" rel="noopener">🪙 BUY ZEP</a>
</div>

<div id="wrap">
  <canvas id="c"></canvas>

  <!-- START -->
  <div class="screen" id="scr-start">
    <div class="s-title">PIXEL<br>SQUIRREL</div>
    <p>Jump traps · Grab acorns · Collect power-ups</p>
    <p class="dim">SPACE/↑ jump · A/← D/→ move · double jump</p>
    <p style="color:var(--gold);font-size:10px;margin-top:6px;">🌰 Extra lives: 100 ZEP each · 5 per hour</p>
    <button class="bbtn bplay" id="btn-start">▶ PLAY</button>
  </div>

  <!-- GAME OVER (title on canvas, buttons below) -->
  <div class="screen" id="scr-over" style="display:none;">
    <div id="go-card">
      <div class="sbig" id="go-score">SCORE: 0</div>
      <p id="go-acorns" style="color:var(--gold);">🌰 0 ACORNS</p>
      <p id="go-rank"   style="color:var(--g5);font-size:10px;"></p>
      <div class="bdiv"></div>
      <div id="go-buy">
        <p style="color:var(--g5);">Continue with an extra life?</p>
        <p id="go-lives-left" class="dim"></p>
        <button class="bbtn bpay" id="btn-buy-life">💎 BUY EXTRA LIVES</button>
        <p id="go-no-wallet" style="color:#ff9999;font-size:9px;margin-top:6px;display:none;">Connect wallet first!</p>
      </div>
      <button class="bbtn bplay" id="btn-restart">↺ NEW GAME</button>
    </div>
  </div>

  <!-- READY screen (after life purchase) -->
  <div id="scr-ready">
    <div class="ready-title">READY?</div>
    <p class="ready-sub">Lives restored — good luck!</p>
    <p class="ready-lives" id="ready-lives-display">❤ 3</p>
    <button class="bbtn bplay" id="btn-continue">▶ CONTINUE</button>
  </div>

  <!-- Leaderboard panel -->
  <div id="lb-panel">
    <div id="lb-head">
      🏆 LEADERBOARD
      <button id="lb-close">✕</button>
    </div>
    <div id="lb-body"><p class="lb-empty">Loading…</p></div>
  </div>

  <!-- Active power-up indicators -->
  <div id="powerups-hud"></div>

  <!-- Handle name modal -->
  <!-- Life picker modal -->
  <div id="modal-lives">
    <h2>💎 BUY EXTRA<br>LIVES</h2>
    <p class="dim">100 ZEP per life · max 5 per hour</p>
    <div class="life-opts" id="life-opts"></div>
    <div id="lives-cost-display">100 ZEP</div>
    <div id="lives-cost-sub">1 life selected</div>
    <div class="modal-btns">
      <button class="bbtn bpay"  id="btn-lives-confirm">💎 PAY &amp; CONTINUE</button>
      <button class="bbtn bplay" id="btn-lives-cancel">✕ CANCEL</button>
    </div>
    <p id="modal-lives-err" style="color:#ff9999;font-size:9px;display:none;"></p>
  </div>

  <div id="modal-handle">
    <h2>🐿 CHOOSE YOUR NAME</h2>
    <p>Appears on the leaderboard</p>
    <input id="handle-inp" type="text" maxlength="20" placeholder="PixelSquirrel42" autocomplete="off">
    <button class="bbtn bplay" id="btn-handle-ok">✓ SAVE NAME</button>
  </div>
</div>

<div id="toast"></div>

<!-- Solana web3.js (browser IIFE bundle) -->
<script src="https://cdn.jsdelivr.net/npm/@solana/web3.js@1.87.6/lib/index.iife.min.js"><\/script>
<!-- Buffer polyfill: solana/web3.js ships Buffer internally; expose it globally -->
<script>
if (typeof Buffer === 'undefined') {
  // Minimal Buffer shim for browser — only needs from() and toString('base64')
  window.Buffer = {
    from: function(data, enc) {
      if (Array.isArray(data) || data instanceof Uint8Array) return new Uint8Array(data);
      if (typeof data === 'string') {
        if (enc === 'base64') {
          var bin = atob(data), bytes = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return bytes;
        }
        var te = new TextEncoder();
        return te.encode(data);
      }
      return new Uint8Array(data);
    },
    isBuffer: function() { return false; }
  };
  // Patch Uint8Array so .toString('base64') works on serialized txs
  var _origSerialize = Uint8Array.prototype.toString;
  Uint8Array.prototype.toBase64 = function() {
    var bin = '';
    for (var i = 0; i < this.length; i++) bin += String.fromCharCode(this[i]);
    return btoa(bin);
  };
}
<\/script>

<script>
'use strict';
// ════════════════════════════════════════════════════════
//  CONSTANTS
// ════════════════════════════════════════════════════════
var ZEP_MINT   = '6o4MAKKTwdtni9o6NdiR5HgGC62pL6YmqDNBhoPmVray';
var RPC_URL    = 'https://api.mainnet-beta.solana.com';
var TOK_PROG   = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
var ATA_PROG   = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1brs';
var RECIPIENT_WALLET = '24Ti8yNf29t4E1mJdzDkEyBCrMFggrqLLFkmDbLrLZxV';

// Gay Men's Flag palette + game colours
var C = {
  g1:'#078D70',g2:'#26D07C',g3:'#98E8C1',g4:'#FFFFFF',
  g5:'#7BADE2',g6:'#4D60A4',g7:'#3D1A78',bg:'#07040F',
  red:'#FF4470',gold:'#FFD700',
  // squirrel
  sqDk:'#3D1A00',sqMd:'#7B3A0A',sqLt:'#C17A30',sqCr:'#F2D8A0',
  sqBk:'#111',sqPk:'#FF8FAB',sqGr:'#26D07C',
  sqTD:'#A05828',sqTL:'#D4955A',
  // environment
  bark:'#5C3D1E',barkL:'#8B6040',rock:'#556677',rockL:'#778899',
  thorn:'#2E5A1E',thornL:'#4A8A30',mud:'#5A3A1E',mudL:'#8B6040',
  snake:'#4A6830',snakeL:'#6A9840',snakeB:'#C8A020',
  acorn:'#C8A951',acornC:'#8B6914',
  spike:'#8899AA',spikeL:'#BBCCDD',
};

// ════════════════════════════════════════════════════════
//  GAME STATE
// ════════════════════════════════════════════════════════
var gState = 'start'; // start | playing | over
var score=0, dist=0, acornCount=0, spd=2.5, frame=0, animTick=0;
var lives=3, scoreMulti=1;
var obstTimer=0, acornTimer=0, puTimer=0;
var shakeX=0, shakeY=0, shakeDec=0, shakeAmt=0;
var goFlicker=0;

// Power-up active timers (frames remaining)
var puShield=0, puMagnet=0, puDouble=0;

// Frozen frame on game-over
var frozenObs=[], frozenAcorns=[], frozenPUs=[];
var frozenClouds=[], frozenBgScroll=0;

// Web3
var wallet=null, zepBal=0, zepDec=9, conn=null;
var rafId=null;
var recipient=new solanaWeb3.PublicKey(RECIPIENT_WALLET);
var handle = localStorage.getItem('sq_handle') || '';
var livesRemaining = 5;

// Entities
var sq = {x:110, y:0, vy:0, vx:0, onGround:true, jumps:0, w:48, h:54, af:0, inv:0};
var keys = {};
var obstacles=[], acorns=[], powerups=[], particles=[], clouds=[], groundDots=[];
var bgScroll=0;

// ════════════════════════════════════════════════════════
//  CANVAS
// ════════════════════════════════════════════════════════
var canvas = document.getElementById('c');
var ctx    = canvas.getContext('2d');
var W, H, GY;

function resize() {
  var r = canvas.parentElement.getBoundingClientRect();
  W = canvas.width  = r.width;
  H = canvas.height = r.height;
  GY = H * 0.76;
  sq.y = GY - sq.h;
  if (!clouds.length) spawnClouds();
}
window.addEventListener('resize', resize);

// ════════════════════════════════════════════════════════
//  SQUIRREL SPRITE
//  2-D pixel grid: numbers map to palette below
//  16 cols × 14 body rows, rendered at px=3 per pixel
// ════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════
//  SQUIRREL — smooth procedural renderer, 6-frame cycle
//  States: run(6 frames), jump, fall, left-facing, dead
// ════════════════════════════════════════════════════════
var SQ_W=48, SQ_H=54;

// 6 run frames: [frontThigh, frontShin, backThigh, backShin, yLift, tailAngle, bodyTilt]
var RUN_FRAMES = [
  [-0.30,  0.50,  0.28, -0.42,  0,   0.30,  0.02],  // 0 neutral
  [-0.68,  0.90,  0.62, -0.80, -3,   0.50,  0.07],  // 1 stride peak
  [-0.95,  1.20,  0.85, -1.10, -5,   0.60,  0.09],  // 2 max extension
  [-0.50,  1.25,  0.45, -1.15, -4,   0.48,  0.06],  // 3 float/cross
  [ 0.35,  0.55, -0.30,  0.48, -2,   0.28,  0.02],  // 4 reverse stride
  [ 0.58,  0.22, -0.52,  0.18, -1,   0.30,  0.03],  // 5 recover
];

function drawSquirrel(ox, oy, af, inv, dead) {
  ctx.save();
  if (inv > 0 && Math.floor(inv/5)%2===1) ctx.globalAlpha = 0.28;

  var facing = (sq.vx < -0.5) ? -1 : 1;
  var inAir  = sq.y < GY - sq.h - 3;
  var rising = sq.vy < -1;
  var tWave  = Math.sin(frame*0.12)*0.07;
  var fT, fS, bT, bS, yL, tA, tilt;

  if (dead) {
    ctx.translate(ox + SQ_W/2, oy + SQ_H/2);
    ctx.rotate(Math.PI/2);
    ctx.translate(-SQ_W/2, -SQ_H/2);
    _sqDraw(0, 0, -0.3, 0.3, 0.3, 0.0, 0.5, -0.5, 0);
    ctx.restore();
    return;
  }

  if (inAir && rising) {
    // Jump: legs tucked forward-up, tail swept back-up
    fT=-0.90; fS=1.30; bT=0.80; bS=-1.20; yL=-5; tA=0.78+tWave; tilt=0.13;
  } else if (inAir) {
    // Fall: legs spread down, tail drooped forward
    fT=0.30; fS=0.60; bT=-0.20; bS=0.40; yL=1; tA=0.18+tWave; tilt=-0.05;
  } else {
    var fd = RUN_FRAMES[af % 6];
    fT=fd[0]; fS=fd[1]; bT=fd[2]; bS=fd[3]; yL=fd[4]; tA=fd[5]+tWave; tilt=fd[6];
  }

  if (facing < 0) {
    // Mirror horizontally for left-facing
    ctx.save();
    ctx.translate(ox + SQ_W, oy);
    ctx.scale(-1, 1);
    _sqDraw(0, 0, fT, bT, tA, tilt, fS, bS, yL);
    ctx.restore();
  } else {
    _sqDraw(ox, oy, fT, bT, tA, tilt, fS, bS, yL);
  }

  // Power-up fx rings drawn at real screen pos (unmirrored)
  if (puShield > 0) {
    ctx.save();
    ctx.globalAlpha = 0.38 + 0.22*Math.sin(frame*0.15);
    ctx.strokeStyle='#4DB8FF'; ctx.lineWidth=4;
    ctx.shadowColor='#4DB8FF'; ctx.shadowBlur=18;
    ctx.beginPath(); ctx.ellipse(ox+24,oy+28,32,38,0,0,Math.PI*2); ctx.stroke();
    ctx.restore();
  }
  if (puMagnet > 0) {
    ctx.save();
    ctx.globalAlpha = 0.14+0.08*Math.sin(frame*0.1);
    ctx.fillStyle=C.gold; ctx.shadowColor=C.gold; ctx.shadowBlur=24;
    ctx.beginPath(); ctx.ellipse(ox+24,oy+28,38,44,0,0,Math.PI*2); ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

// ── Core squirrel body renderer ────────────────────────
function _sqDraw(ox, oy, fThigh, bThigh, tailAng, tilt, fShin, bShin, yLift) {
  fShin  = (fShin  !== undefined) ? fShin  :  0.50;
  bShin  = (bShin  !== undefined) ? bShin  : -0.50;
  yLift  = (yLift  !== undefined) ? yLift  :  0;

  var bCX=ox+22, bCY=oy+33+yLift; // body centre
  var hCX=ox+17, hCY=oy+13+yLift; // head centre

  // ── TAIL ──────────────────────────────────────────────
  var tbX=bCX+11, tbY=bCY-4;
  var tc1x=tbX+20+Math.cos(tailAng)*18,   tc1y=tbY-16+Math.sin(tailAng)*8;
  var tc2x=tbX+10+Math.cos(tailAng+.55)*22, tc2y=tbY-30+Math.sin(tailAng+.55)*10;
  var ttX=tbX-3 +Math.cos(tailAng+1.0)*18,  ttY=tbY-42+Math.sin(tailAng+1.0)*8;

  var tg=ctx.createLinearGradient(tbX,tbY,ttX,ttY);
  tg.addColorStop(0,C.sqTD); tg.addColorStop(0.5,C.sqTL); tg.addColorStop(1,'#F5E0C0');
  ctx.fillStyle=tg;
  ctx.beginPath();
  ctx.moveTo(tbX+5,tbY+3);
  ctx.bezierCurveTo(tc1x+8,tc1y-2, tc2x+6,tc2y-4, ttX+6,ttY+1);
  ctx.bezierCurveTo(tc2x-4,tc2y+9, tc1x-6,tc1y+8, tbX-3,tbY+7);
  ctx.closePath(); ctx.fill();
  // Fluffy tip
  ctx.fillStyle='#FFF5E8';
  ctx.beginPath(); ctx.arc(ttX+3,ttY,7,0,Math.PI*2); ctx.fill();

  // ── BODY ──────────────────────────────────────────────
  ctx.save();
  ctx.translate(bCX,bCY); ctx.rotate(tilt);

  // Back legs (behind body)
  _sqLeg(-6, 5, bThigh, bShin, false);

  // Body shape
  var bg=ctx.createLinearGradient(-12,-12,12,14);
  bg.addColorStop(0,C.sqLt); bg.addColorStop(1,C.sqDk);
  ctx.fillStyle=bg;
  ctx.beginPath(); _sqRRect(-13,-14,26,28,8); ctx.fill();
  // Belly
  ctx.fillStyle=C.sqCr;
  ctx.beginPath(); ctx.ellipse(0,2,8,11,0,0,Math.PI*2); ctx.fill();
  // Collar (pride green gradient)
  var cg=ctx.createLinearGradient(-12,-14,12,-8);
  cg.addColorStop(0,'#26D07C'); cg.addColorStop(1,'#078D70');
  ctx.fillStyle=cg;
  ctx.beginPath(); _sqRRect(-13,-15,26,7,3); ctx.fill();
  // Collar badge
  ctx.fillStyle=C.gold;
  ctx.beginPath(); ctx.arc(0,-11,3,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='rgba(0,0,0,0.45)'; ctx.font='bold 4px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText('*',0,-11);
  // Front legs (in front of body)
  _sqLeg(8, 5, fThigh, fShin, true);

  ctx.restore(); // end body tilt

  // ── HEAD ──────────────────────────────────────────────
  ctx.save();
  ctx.translate(hCX,hCY); ctx.rotate(tilt*0.6);

  // Skull
  var hg=ctx.createRadialGradient(-4,-5,1,0,0,18);
  hg.addColorStop(0,C.sqLt); hg.addColorStop(1,C.sqMd);
  ctx.fillStyle=hg;
  ctx.beginPath(); ctx.ellipse(0,0,16,14,0,0,Math.PI*2); ctx.fill();

  // Ears (left, right)
  var ears=[[-6,-11,-13,-23,-17,-17,-12,-8],[6,-11,13,-23,17,-17,12,-8]];
  for(var ei=0;ei<2;ei++){
    var e=ears[ei], s=ei===0?-1:1;
    ctx.fillStyle=C.sqMd;
    ctx.beginPath(); ctx.moveTo(e[0],e[1]);
    ctx.bezierCurveTo(e[2],e[3],e[4],e[5],e[6],e[7]);
    ctx.lineTo(e[0],e[1]); ctx.closePath(); ctx.fill();
    ctx.fillStyle=C.sqPk;
    ctx.beginPath(); ctx.moveTo(e[0]+s,e[1]);
    ctx.bezierCurveTo(e[2]*0.78,e[3]*0.82,e[4]*0.72,e[5]*0.88,e[6]+s,e[7]);
    ctx.closePath(); ctx.fill();
  }

  // Eyes
  ctx.fillStyle='#1a0a00';
  ctx.beginPath(); ctx.arc(-6,-3,4,0,Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc( 6,-3,4,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='#fff';
  ctx.beginPath(); ctx.arc(-4.5,-4.5,2,0,Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(7.5,-4.5,2,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='rgba(255,255,255,.55)';
  ctx.beginPath(); ctx.arc(-5,-3.5,.85,0,Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(7,-3.5,.85,0,Math.PI*2); ctx.fill();

  // Cheek blush
  ctx.fillStyle='rgba(255,110,90,.2)';
  ctx.beginPath(); ctx.ellipse(-11,2,5,3,0,0,Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.ellipse( 11,2,5,3,0,0,Math.PI*2); ctx.fill();

  // Nose
  ctx.fillStyle=C.sqPk;
  ctx.beginPath(); ctx.ellipse(0,7,5,3,0,0,Math.PI*2); ctx.fill();
  ctx.fillStyle=C.sqDk;
  ctx.beginPath(); ctx.arc(-2,6.5,1.3,0,Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc( 2,6.5,1.3,0,Math.PI*2); ctx.fill();
  ctx.strokeStyle=C.sqDk; ctx.lineWidth=1.2;
  ctx.beginPath(); ctx.arc(0,7.5,3.5,.1,Math.PI-.1); ctx.stroke();

  ctx.restore();
}

// ── Leg renderer (called inside body transform context) ─
function _sqLeg(hx, hy, thigh, shin, front) {
  var L=13;
  var kx=hx+Math.sin(thigh)*L, ky=hy+Math.cos(thigh)*L;
  var fx=kx+Math.sin(thigh+shin)*L, fy=ky+Math.cos(thigh+shin)*L;
  ctx.strokeStyle=front?C.sqLt:C.sqMd; ctx.lineWidth=5; ctx.lineCap='round';
  ctx.beginPath(); ctx.moveTo(hx,hy); ctx.lineTo(kx,ky); ctx.stroke();
  ctx.lineWidth=4;
  ctx.beginPath(); ctx.moveTo(kx,ky); ctx.lineTo(fx,fy); ctx.stroke();
  ctx.fillStyle=C.sqDk;
  ctx.beginPath(); ctx.ellipse(fx,fy+1,5,2.5,thigh*.3,0,Math.PI*2); ctx.fill();
}

// ── Rounded rect path helper ────────────────────────────
function _sqRRect(x, y, w, h, r) {
  if (ctx.roundRect) { ctx.roundRect(x,y,w,h,r); return; }
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y); ctx.closePath();
}


// ════════════════════════════════════════════════════════
//  ACORN
// ════════════════════════════════════════════════════════
function drawAcorn(x, y, sz, golden) {
  sz = sz || 18;
  // cap
  ctx.fillStyle = golden ? C.gold : C.acornC;
  ctx.beginPath();
  ctx.ellipse(x, y, sz*0.52, sz*0.28, 0, Math.PI, 0);
  ctx.fill();
  // stem
  ctx.strokeStyle = '#5C4A1E'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, y - sz*0.3); ctx.lineTo(x, y - sz*0.5); ctx.stroke();
  // body
  ctx.fillStyle = golden ? '#FFDD44' : C.acorn;
  if (golden) { ctx.shadowColor = C.gold; ctx.shadowBlur = 12; }
  ctx.beginPath();
  ctx.ellipse(x, y + sz*0.22, sz*0.36, sz*0.46, 0, 0, Math.PI*2);
  ctx.fill();
  ctx.shadowBlur = 0;
  // highlight
  ctx.fillStyle = 'rgba(255,245,200,0.4)';
  ctx.beginPath();
  ctx.ellipse(x - sz*0.1, y + sz*0.05, sz*0.12, sz*0.18, -0.4, 0, Math.PI*2);
  ctx.fill();
}

// ════════════════════════════════════════════════════════
//  POWER-UPS
// ════════════════════════════════════════════════════════
var PU_TYPES = ['shield','magnet','double'];

function drawPowerup(pu) {
  var x=pu.x, y=pu.y + Math.sin(frame*0.08+pu.phase)*6, r=14;
  ctx.save();
  ctx.shadowBlur = 18;
  if (pu.type==='shield') {
    ctx.shadowColor = '#4DB8FF';
    ctx.fillStyle = '#4DB8FF';
    ctx.strokeStyle = '#88DDFF';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y-r);
    ctx.lineTo(x+r*0.8, y-r*0.3);
    ctx.lineTo(x+r*0.8, y+r*0.3);
    ctx.lineTo(x, y+r);
    ctx.lineTo(x-r*0.8, y+r*0.3);
    ctx.lineTo(x-r*0.8, y-r*0.3);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.fillStyle='#88DDFF'; ctx.font='bold 11px sans-serif';
    ctx.textAlign='center'; ctx.fillText('S', x, y+4);
  } else if (pu.type==='magnet') {
    ctx.shadowColor = C.gold;
    // horseshoe magnet
    ctx.strokeStyle = C.gold; ctx.lineWidth = 5; ctx.lineCap='round';
    ctx.beginPath();
    ctx.arc(x, y+2, r*0.6, Math.PI, 0);
    ctx.stroke();
    ctx.fillStyle = C.gold;
    ctx.fillRect(x - r*0.6 - 3, y+2-r*0.4, 6, r*0.4+2);
    ctx.fillRect(x + r*0.6 - 3, y+2-r*0.4, 6, r*0.4+2);
    ctx.fillStyle='#88FF44'; ctx.fillRect(x-r*0.6-3, y+2-r*0.4, 6, 3);
    ctx.fillStyle='#FF4444'; ctx.fillRect(x+r*0.6-3, y+2-r*0.4, 6, 3);
  } else { // double
    ctx.shadowColor = '#FF88FF';
    ctx.fillStyle = '#FF88FF'; ctx.strokeStyle='#FFBBFF'; ctx.lineWidth=2;
    // star shape
    for (var i=0; i<5; i++) {
      var a=i*Math.PI*2/5 - Math.PI/2, a2=a+Math.PI/5;
      if(i===0) ctx.beginPath(), ctx.moveTo(x+r*Math.cos(a), y+r*Math.sin(a));
      else ctx.lineTo(x+r*Math.cos(a), y+r*Math.sin(a));
      ctx.lineTo(x+r*0.45*Math.cos(a2), y+r*0.45*Math.sin(a2));
    }
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle='#FFFFFF'; ctx.font='bold 9px sans-serif';
    ctx.textAlign='center'; ctx.fillText('2x', x, y+3);
  }
  ctx.restore();
}

// ════════════════════════════════════════════════════════
//  OBSTACLES
// ════════════════════════════════════════════════════════
function drawObstacle(ob) {
  ctx.save();
  if (ob.type==='spike') {
    var n = Math.round(ob.w/22);
    for (var i=0; i<n; i++) {
      var sx=ob.x+i*22;
      ctx.fillStyle='#445566';
      ctx.fillRect(sx, ob.y+ob.h-8, 22, 8);
      ctx.fillStyle=C.spike;
      ctx.beginPath(); ctx.moveTo(sx,ob.y+ob.h-8); ctx.lineTo(sx+11,ob.y); ctx.lineTo(sx+22,ob.y+ob.h-8); ctx.closePath(); ctx.fill();
      ctx.fillStyle=C.spikeL;
      ctx.beginPath(); ctx.moveTo(sx+8,ob.y+ob.h-6); ctx.lineTo(sx+11,ob.y+3); ctx.lineTo(sx+14,ob.y+ob.h-6); ctx.closePath(); ctx.fill();
    }
  } else if (ob.type==='log') {
    ctx.fillStyle=C.bark;
    ctx.beginPath(); ctx.roundRect(ob.x,ob.y,ob.w,ob.h,10); ctx.fill();
    ctx.fillStyle=C.barkL;
    ctx.beginPath(); ctx.ellipse(ob.x+ob.w/2,ob.y+8,ob.w*0.44,9,0,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='#4A2E12'; ctx.lineWidth=1.5;
    for (var ri=0.35; ri<0.9; ri+=0.15) {
      ctx.beginPath(); ctx.moveTo(ob.x+8,ob.y+ob.h*ri); ctx.lineTo(ob.x+ob.w-8,ob.y+ob.h*ri); ctx.stroke();
    }
    ctx.fillStyle=C.g1; ctx.globalAlpha=0.3;
    for (var mi=0; mi<3; mi++) { ctx.beginPath(); ctx.arc(ob.x+10+mi*18,ob.y+4,7,0,Math.PI*2); ctx.fill(); }
    ctx.globalAlpha=1;
  } else if (ob.type==='rock') {
    var rr=[ob.h*0.55,ob.h*0.45,ob.h*0.25,ob.h*0.35];
    ctx.fillStyle=C.rock;
    ctx.beginPath(); ctx.roundRect(ob.x,ob.y,ob.w,ob.h,rr); ctx.fill();
    ctx.fillStyle=C.rockL;
    ctx.beginPath(); ctx.ellipse(ob.x+ob.w*0.32,ob.y+ob.h*0.28,ob.w*0.22,ob.h*0.16,-0.3,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='#445566'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(ob.x+ob.w*0.6,ob.y+ob.h*0.2); ctx.lineTo(ob.x+ob.w*0.55,ob.y+ob.h*0.6); ctx.stroke();
  } else if (ob.type==='stump') {
    ctx.fillStyle=C.bark;
    ctx.beginPath(); ctx.roundRect(ob.x,ob.y,ob.w,ob.h,[6,6,0,0]); ctx.fill();
    ctx.fillStyle=C.barkL;
    ctx.beginPath(); ctx.ellipse(ob.x+ob.w/2,ob.y+8,ob.w*0.44,9,0,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle=C.bark; ctx.lineWidth=1.5;
    for (var sr=4; sr<ob.w*0.4; sr+=6) { ctx.beginPath(); ctx.arc(ob.x+ob.w/2,ob.y+8,sr,0,Math.PI*2); ctx.stroke(); }
    ctx.fillStyle=C.thorn; ctx.globalAlpha=0.4;
    for (var ti=0; ti<4; ti++) { ctx.beginPath(); ctx.arc(ob.x+5+ti*12,ob.y-4,8,0,Math.PI*2); ctx.fill(); }
    ctx.globalAlpha=1;
  } else if (ob.type==='thorn') {
    // Wide low thorn bush
    ctx.fillStyle=C.thorn;
    ctx.beginPath(); ctx.roundRect(ob.x,ob.y+ob.h*0.4,ob.w,ob.h*0.6,4); ctx.fill();
    ctx.fillStyle=C.thornL;
    for (var tn=0; tn<Math.round(ob.w/16); tn++) {
      var tx2=ob.x+8+tn*16, ty2=ob.y;
      ctx.beginPath();
      ctx.moveTo(tx2-8,ob.y+ob.h*0.45);
      ctx.bezierCurveTo(tx2-6,ob.y+ob.h*0.1, tx2+6,ob.y+ob.h*0.1, tx2+8,ob.y+ob.h*0.45);
      ctx.closePath(); ctx.fill();
      // spikes
      ctx.fillStyle='#1A3A10';
      for (var sp=0; sp<3; sp++) {
        ctx.beginPath();
        ctx.moveTo(tx2-6+sp*6,ob.y+ob.h*0.42);
        ctx.lineTo(tx2-4+sp*6,ob.y+ob.h*0.15+sp*4);
        ctx.lineTo(tx2-2+sp*6,ob.y+ob.h*0.42);
        ctx.closePath(); ctx.fill();
      }
      ctx.fillStyle=C.thornL;
    }
  } else if (ob.type==='snake') {
    // Animated sinusoidal snake
    var seg=12, sw=ob.w/seg;
    ctx.lineWidth=14; ctx.lineCap='round'; ctx.lineJoin='round';
    ctx.strokeStyle=C.snake;
    ctx.beginPath();
    for (var si=0; si<=seg; si++) {
      var sx2=ob.x+si*sw;
      var sy2=ob.y + Math.sin(si*0.9 + frame*0.18)*8;
      if(si===0) ctx.moveTo(sx2,sy2); else ctx.lineTo(sx2,sy2);
    }
    ctx.stroke();
    ctx.lineWidth=7; ctx.strokeStyle=C.snakeL;
    ctx.beginPath();
    for (var si2=0; si2<=seg; si2++) {
      var sx3=ob.x+si2*sw;
      var sy3=ob.y + Math.sin(si2*0.9 + frame*0.18)*8;
      if(si2===0) ctx.moveTo(sx3,sy3); else ctx.lineTo(sx3,sy3);
    }
    ctx.stroke();
    // head
    var hx=ob.x+ob.w, hy=ob.y+Math.sin(seg*0.9+frame*0.18)*8;
    ctx.fillStyle=C.snakeL;
    ctx.beginPath(); ctx.arc(hx,hy,10,0,Math.PI*2); ctx.fill();
    ctx.fillStyle=C.snakeB;
    ctx.beginPath(); ctx.arc(hx,hy,10,0,Math.PI*2); // forked tongue
    ctx.fillStyle='#222'; ctx.beginPath(); ctx.arc(hx-3,hy-2,2.5,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(hx+3,hy-2,2.5,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle=C.snakeB; ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(hx+10,hy); ctx.lineTo(hx+16,hy-3); ctx.moveTo(hx+10,hy); ctx.lineTo(hx+16,hy+3); ctx.stroke();
  }
  ctx.restore();
}

// ════════════════════════════════════════════════════════
//  BACKGROUND
// ════════════════════════════════════════════════════════
function spawnClouds() {
  clouds=[];
  for (var i=0;i<8;i++) clouds.push({
    x:Math.random()*W, y:Math.random()*GY*0.44,
    s:20+Math.random()*50, spd:0.2+Math.random()*0.35,
    a:0.1+Math.random()*0.18
  });
  groundDots=[];
  for (var j=0;j<32;j++) groundDots.push({x:j*(W/32)+Math.random()*18, w:4+Math.random()*14});
}

function drawBg(scrollOverride) {
  var sc = (scrollOverride !== undefined) ? scrollOverride : bgScroll;
  // Sky gradient
  var sg=ctx.createLinearGradient(0,0,0,H);
  sg.addColorStop(0,'#050210'); sg.addColorStop(0.45,'#0D0530');
  sg.addColorStop(0.75,'#122050'); sg.addColorStop(1,C.bg);
  ctx.fillStyle=sg; ctx.fillRect(0,0,W,H);
  // Stars
  for (var i=0;i<55;i++) {
    var sx=((i*173+31)%W), sy=((i*89+11)%(GY*0.54));
    ctx.globalAlpha=(Math.sin(frame*0.04+i)*0.4+0.5)*0.6;
    ctx.fillStyle='#fff'; ctx.fillRect(sx,sy,i%5<2?2:1,i%5<2?2:1);
  }
  ctx.globalAlpha=1;
  // Clouds
  for (var ci=0;ci<clouds.length;ci++) {
    var cl=clouds[ci];
    ctx.globalAlpha=cl.a; ctx.fillStyle=C.g3;
    ctx.beginPath();
    ctx.arc(cl.x,cl.y,cl.s,0,Math.PI*2);
    ctx.arc(cl.x+cl.s*.7,cl.y-cl.s*.2,cl.s*.65,0,Math.PI*2);
    ctx.arc(cl.x-cl.s*.55,cl.y+cl.s*.1,cl.s*.55,0,Math.PI*2);
    ctx.fill();
    if (scrollOverride===undefined) {
      cl.x -= cl.spd;
      if (cl.x+cl.s*2.5<0) { cl.x=W+cl.s; cl.y=Math.random()*GY*0.44; }
    }
  }
  ctx.globalAlpha=1;
  // Far trees (parallax layer 1)
  for (var ti=0;ti<10;ti++) {
    var tx=((ti*172 - sc*0.35 + W+200)%(W+200))-100;
    drawTree(tx,GY,0.52,true);
  }
  // Mid trees (layer 2)
  var midScroll=(sc*0.7)%(W+240);
  for (var ti2=0;ti2<7;ti2++) {
    var tx2=((ti2*260 - midScroll + W+240)%(W+240))-120;
    drawTree(tx2,GY,0.8,false);
  }
  // Ground
  var gg=ctx.createLinearGradient(0,GY,0,H);
  gg.addColorStop(0,C.g7); gg.addColorStop(0.07,C.g6);
  gg.addColorStop(0.32,C.g1); gg.addColorStop(1,'#020A08');
  ctx.fillStyle=gg; ctx.fillRect(0,GY,W,H-GY);
  // Ground glow line
  ctx.shadowColor=C.g2; ctx.shadowBlur=14;
  ctx.fillStyle=C.g2; ctx.fillRect(0,GY,W,3);
  ctx.shadowBlur=0;
  // Ground detail dots
  var dotSc=(frame*spd)%(W/32*2);
  for (var di=0;di<groundDots.length;di++) {
    var dx=((groundDots[di].x-dotSc)%W+W)%W;
    ctx.fillStyle=C.g3; ctx.globalAlpha=0.22;
    ctx.fillRect(dx,GY+10,groundDots[di].w,3);
  }
  ctx.globalAlpha=1;
}

function drawTree(x,gy,sc,far) {
  var h=100*sc, tw=18*sc;
  ctx.globalAlpha=far?0.25:0.5;
  ctx.fillStyle=far?C.g7:'#1A0A3A';
  ctx.fillRect(x-tw/2,gy-h*.36,tw,h*.36);
  ctx.fillStyle=far?C.g6:C.g7;
  ctx.beginPath(); ctx.moveTo(x,gy-h); ctx.lineTo(x+tw*2.4,gy-h*.26); ctx.lineTo(x-tw*2.4,gy-h*.26); ctx.closePath(); ctx.fill();
  ctx.fillStyle=far?C.g7:C.g6;
  ctx.beginPath(); ctx.moveTo(x,gy-h*.78); ctx.lineTo(x+tw*2.8,gy-h*.16); ctx.lineTo(x-tw*2.8,gy-h*.16); ctx.closePath(); ctx.fill();
  ctx.globalAlpha=1;
}

// ════════════════════════════════════════════════════════
//  PARTICLES
// ════════════════════════════════════════════════════════
function spawnParticles(x,y,col,n) {
  n=n||10;
  for(var i=0;i<n;i++) particles.push({
    x:x,y:y,
    vx:(Math.random()-.5)*8,vy:-Math.random()*7-1.5,
    life:36,max:36,color:col,sz:2+Math.random()*4
  });
}
function tickParticles() {
  particles=particles.filter(function(p){return p.life>0;});
  for(var i=0;i<particles.length;i++){
    var p=particles[i];
    p.x+=p.vx; p.y+=p.vy; p.vy+=0.28; p.life--;
    ctx.globalAlpha=p.life/p.max;
    ctx.fillStyle=p.color;
    ctx.fillRect(p.x,p.y,p.sz,p.sz);
  }
  ctx.globalAlpha=1;
}

// ════════════════════════════════════════════════════════
//  HUD (on canvas)
// ════════════════════════════════════════════════════════
function drawHUD() {
  // Distance
  ctx.textAlign='right';
  ctx.font='bold 13px "Share Tech Mono"';
  ctx.fillStyle=C.g3;
  ctx.fillText(Math.floor(dist)+'m', W-16, 24);
  // Speed bar
  var bW=80, bX=W/2-40;
  ctx.fillStyle='rgba(255,255,255,0.1)'; ctx.fillRect(bX,8,bW,6);
  var pct=Math.min((spd-2.5)/3.75,1);
  var bg=ctx.createLinearGradient(bX,0,bX+bW,0);
  bg.addColorStop(0,C.g2); bg.addColorStop(1,C.g5);
  ctx.fillStyle=bg; ctx.fillRect(bX,8,bW*pct,6);
  ctx.fillStyle=C.g5; ctx.font='9px "Share Tech Mono"';
  ctx.textAlign='center';
  var lvl=Math.min(10,Math.floor((spd-2.5)/0.375)+1);
  ctx.fillText('LEVEL '+lvl, W/2, 24);
  // Power-up timers (small bars above squirrel)
  if (puShield>0) drawPUBar(sq.x-4,sq.y-14,puShield,360,'#4DB8FF','S');
  if (puMagnet>0) drawPUBar(sq.x-4,sq.y-(puShield>0?24:14),puMagnet,480,C.gold,'M');
  if (puDouble>0) drawPUBar(sq.x-4,sq.y-(24*(+(puShield>0))+(+(puMagnet>0))*10+4),puDouble,480,'#FF88FF','2x');
}
function drawPUBar(x,y,t,max,col,label) {
  ctx.fillStyle='rgba(0,0,0,0.5)'; ctx.fillRect(x,y,48,6);
  ctx.fillStyle=col; ctx.fillRect(x,y,48*(t/max),6);
  ctx.fillStyle=col; ctx.font='8px "Share Tech Mono"'; ctx.textAlign='left';
  ctx.fillText(label,x+1,y-1);
}

// ════════════════════════════════════════════════════════
//  GAME OVER CANVAS TEXT
// ════════════════════════════════════════════════════════
function drawGameOverCanvas() {
  // Dim vignette
  var vg=ctx.createRadialGradient(W/2,H/2,H*.1,W/2,H/2,H*.9);
  vg.addColorStop(0,'rgba(0,0,0,0)');
  vg.addColorStop(1,'rgba(0,0,0,0.72)');
  ctx.fillStyle=vg; ctx.fillRect(0,0,W,H);

  goFlicker++;
  var fz=Math.floor(Math.min(W/7,68));

  // Glow pass
  ctx.save();
  ctx.shadowColor=C.g5; ctx.shadowBlur=40;
  ctx.font='bold '+fz+'px "Press Start 2P"';
  ctx.textAlign='center';
  ctx.fillStyle='rgba(123,173,226,0.15)';
  ctx.fillText('GAME OVER!', W/2, H*.34);
  ctx.restore();

  // Gradient fill
  var grd=ctx.createLinearGradient(W/2-fz*3,0,W/2+fz*3,0);
  grd.addColorStop(0,C.g2); grd.addColorStop(0.35,C.g5);
  grd.addColorStop(0.65,C.g3); grd.addColorStop(1,C.g4);
  ctx.font='bold '+fz+'px "Press Start 2P"';
  ctx.textAlign='center';
  ctx.fillStyle=grd;
  ctx.fillText('GAME OVER!', W/2, H*.34);

  // Dead squirrel frozen in place
  drawSquirrel(sq.x, GY-sq.h+2, 0, 0, true);
}

// ════════════════════════════════════════════════════════
//  SPAWNING
// ════════════════════════════════════════════════════════
function obstInterval() { return Math.max(45, 130-(spd-2.5)*18); }
function acornInterval() { return 48; }
function puInterval()   { return 380; }

function spawnObstacle() {
  var pool = spd<3.5 ? ['spike','log','log','thorn'] :
             spd<5   ? ['spike','log','rock','stump','thorn','snake'] :
                       ['spike','log','rock','stump','thorn','snake','snake','spike'];
  var type = pool[Math.floor(Math.random()*pool.length)];
  var w,h;
  if(type==='spike')  { w=22+Math.floor(Math.random()*3)*22; h=34; }
  else if(type==='log') { w=28+Math.random()*34; h=30+Math.random()*26; }
  else if(type==='rock') { w=36+Math.random()*24; h=28+Math.random()*22; }
  else if(type==='stump') { w=38+Math.random()*20; h=34+Math.random()*16; }
  else if(type==='thorn') { w=60+Math.random()*60; h=28+Math.random()*14; }
  else { w=70+Math.random()*40; h=24; } // snake
  obstacles.push({x:W+20, y:GY-h, w:w, h:h, type:type});
}

function spawnAcorn() {
  if(Math.random()>0.8) return;
  var heights=[GY-40,GY-85,GY-140,GY-200];
  var golden = Math.random()<0.08; // 8% golden acorn = 50pts
  acorns.push({
    x:W+20,
    y:heights[Math.floor(Math.random()*heights.length)],
    bob:Math.random()*Math.PI*2,
    done:false, golden:golden
  });
}

function spawnPowerup() {
  if(Math.random()>0.65) return;
  var type=PU_TYPES[Math.floor(Math.random()*PU_TYPES.length)];
  powerups.push({
    x:W+20, y:GY-120-Math.random()*100,
    phase:Math.random()*Math.PI*2, type:type, done:false
  });
}

// ════════════════════════════════════════════════════════
//  COLLISION
// ════════════════════════════════════════════════════════
function overlaps(ax,ay,aw,ah, bx,by,bw,bh, m) {
  m=m||9;
  return ax+m<bx+bw-m && ax+aw-m>bx+m && ay+m<by+bh-m && ay+ah-m>by+m;
}

// ════════════════════════════════════════════════════════
//  HIT HANDLING
// ════════════════════════════════════════════════════════
function hitObstacle() {
  if (puShield>0) {
    puShield=0; // shield absorbs hit
    sq.inv=80;
    spawnParticles(sq.x+sq.w/2, sq.y+sq.h/2,'#4DB8FF',16);
    toast('🛡 Shield absorbed the hit!',1800);
    updatePUHud();
    return;
  }
  lives--;
  updateTopUI();
  spawnParticles(sq.x+sq.w/2,sq.y+sq.h/2,C.red,20);
  // Camera shake
  shakeAmt=10; shakeDec=0.8;
  if(lives<=0) {
    // Snapshot for freeze frame
    frozenObs=obstacles.map(function(o){return Object.assign({},o);});
    frozenAcorns=acorns.map(function(a){return Object.assign({},a);});
    frozenPUs=powerups.map(function(p){return Object.assign({},p);});
    frozenClouds=clouds.map(function(c){return Object.assign({},c);});
    frozenBgScroll=bgScroll;
    gState='over';
    submitScore();
    showGameOver();
  } else {
    sq.inv=110;
  }
}

// ════════════════════════════════════════════════════════
//  GAME LOOP
// ════════════════════════════════════════════════════════
function loop() {
  ctx.clearRect(0,0,W,H);

  // FROZEN / GAME OVER state — static frame + flickering text
  if(gState==='over') {
    drawBg(frozenBgScroll);
    for(var fi=0;fi<frozenObs.length;fi++) drawObstacle(frozenObs[fi]);
    for(var fj=0;fj<frozenAcorns.length;fj++) {
      if(!frozenAcorns[fj].done) drawAcorn(frozenAcorns[fj].x+10, frozenAcorns[fj].y, 18, frozenAcorns[fj].golden);
    }
    drawGameOverCanvas();
    rafId=requestAnimationFrame(loop);
    return;
  }

  if(gState!=='playing') return; // start screen — no loop rescheduled

  rafId=requestAnimationFrame(loop);

  // Camera shake
  if(shakeAmt>0.5) {
    shakeX=(Math.random()-.5)*shakeAmt*2; shakeY=(Math.random()-.5)*shakeAmt*2;
    shakeAmt*=shakeDec;
  } else { shakeX=0; shakeY=0; shakeAmt=0; }
  if(shakeX!==0) ctx.save(), ctx.translate(shakeX,shakeY);

  drawBg();
  bgScroll+=spd*0.5;

  frame++;
  dist+=spd*0.05;
  spd=Math.min(2.5+dist/1800,6.25);
  scoreMulti = puDouble>0 ? 2 : 1;

  // Squirrel physics
  sq.vy+=0.28; sq.y+=sq.vy;
  if(sq.y>=GY-sq.h){ sq.y=GY-sq.h; sq.vy=0; sq.onGround=true; sq.jumps=0; } else sq.onGround=false;
  sq.vx = keys["ArrowLeft"]||keys["KeyA"] ? -4 : keys["ArrowRight"]||keys["KeyD"] ? 4 : 0;
  sq.x += sq.vx;
  if(sq.x < 20) sq.x = 20;
  if(sq.x > W*0.55) sq.x = W*0.55;
  if(sq.inv>0) sq.inv--;

  // Animate
  animTick++;
  var afRate=Math.max(3,Math.round(7-spd));
  if(animTick%afRate===0) sq.af=(sq.af+1)%6;

  // Power-up timers
  if(puShield>0) puShield--;
  if(puMagnet>0) puMagnet--;
  if(puDouble>0) { puDouble--; }

  // Obstacles
  obstTimer++;
  if(obstTimer>=obstInterval()){obstTimer=0; spawnObstacle();}
  obstacles=obstacles.filter(function(o){return o.x+o.w>-20;});
  for(var oi=0;oi<obstacles.length;oi++){
    var o=obstacles[oi]; o.x-=spd;
    drawObstacle(o);
    if(sq.inv===0 && overlaps(sq.x,sq.y,sq.w,sq.h, o.x,o.y,o.w,o.h)) hitObstacle();
  }

  // Acorns
  acornTimer++;
  if(acornTimer>=acornInterval()){acornTimer=0; spawnAcorn();}
  acorns=acorns.filter(function(a){return !a.done && a.x>-30;});
  for(var ai=0;ai<acorns.length;ai++){
    var a=acorns[ai]; a.x-=spd;
    // Magnet pull
    if(puMagnet>0){
      var mdx=sq.x+sq.w/2-(a.x+10), mdy=sq.y+sq.h/2-a.y;
      var md=Math.sqrt(mdx*mdx+mdy*mdy);
      if(md<200){ a.x+=mdx*0.06; a.y+=mdy*0.06; }
    }
    var bob=Math.sin(frame*.09+a.bob)*7;
    drawAcorn(a.x+10, a.y+bob, a.golden?22:18, a.golden);
    if(overlaps(sq.x,sq.y,sq.w,sq.h, a.x-8,a.y-18,36,44,4)){
      a.done=true;
      var pts=a.golden?50:10;
      acornCount++;
      score+=pts*scoreMulti;
      spawnParticles(a.x+10,a.y,a.golden?C.gold:C.acorn,a.golden?18:10);
      if(a.golden) toast('⭐ GOLDEN ACORN! +'+pts*scoreMulti,1800);
    }
  }

  // Power-ups
  puTimer++;
  if(puTimer>=puInterval()){puTimer=0; spawnPowerup();}
  powerups=powerups.filter(function(p){return !p.done && p.x>-30;});
  for(var pi=0;pi<powerups.length;pi++){
    var pu=powerups[pi]; pu.x-=spd;
    drawPowerup(pu);
    if(overlaps(sq.x,sq.y,sq.w,sq.h, pu.x-16,pu.y-16,40,40,2)){
      pu.done=true;
      activatePU(pu.type);
    }
  }

  score=Math.floor(dist*2)+acornCount*10*scoreMulti;
  updateTopUI();
  drawSquirrel(sq.x,sq.y,sq.af,sq.inv,false);
  tickParticles();
  drawHUD();

  if(shakeX!==0) ctx.restore();
}

function activatePU(type){
  if(type==='shield')  { puShield=360; spawnParticles(sq.x+sq.w/2,sq.y,'#4DB8FF',14); toast('🛡 SHIELD ACTIVE!',1600); }
  if(type==='magnet')  { puMagnet=480; spawnParticles(sq.x+sq.w/2,sq.y,C.gold,14);   toast('🧲 MAGNET ACTIVE!',1600); }
  if(type==='double')  { puDouble=480; spawnParticles(sq.x+sq.w/2,sq.y,'#FF88FF',14);toast('⭐ 2x POINTS!',1600); }
  updatePUHud();
}

function updatePUHud(){
  var h=document.getElementById('powerups-hud'); h.innerHTML='';
  if(puShield>0) h.innerHTML+='<div class="pu-icon" style="border-color:#4DB8FF;background:rgba(77,184,255,.2)">🛡</div>';
  if(puMagnet>0) h.innerHTML+='<div class="pu-icon" style="border-color:'+C.gold+';background:rgba(200,165,0,.2)">🧲</div>';
  if(puDouble>0) h.innerHTML+='<div class="pu-icon" style="border-color:#FF88FF;background:rgba(255,136,255,.2)">2x</div>';
  document.getElementById('p-multi').style.display=puDouble>0?'block':'none';
}

// ════════════════════════════════════════════════════════
//  INPUT
// ════════════════════════════════════════════════════════
function doJump(){
  if(gState!=='playing') return;
  if(sq.jumps<2){ sq.vy=-17; sq.jumps++; spawnParticles(sq.x+sq.w/2,sq.y+sq.h,C.g2,7); }
}
document.addEventListener('keydown',function(e){
  keys[e.code]=true;
  if(['Space','ArrowUp','KeyW'].includes(e.code)){ e.preventDefault(); doJump(); }
  if(['ArrowLeft','ArrowRight','KeyA','KeyD'].includes(e.code)) e.preventDefault();
});
document.addEventListener('keyup',function(e){ keys[e.code]=false; });
canvas.addEventListener('click',doJump);
canvas.addEventListener('touchstart',function(e){e.preventDefault();doJump();},{passive:false});

// ════════════════════════════════════════════════════════
//  GAME FLOW
// ════════════════════════════════════════════════════════
function startGame(){
  if(rafId){ cancelAnimationFrame(rafId); rafId=null; }
  gState='playing';
  score=0; acornCount=0; dist=0; spd=2.5; frame=0; animTick=0;
  obstTimer=0; acornTimer=0; puTimer=0; lives=3; scoreMulti=1;
  puShield=0; puMagnet=0; puDouble=0;
  shakeAmt=0; shakeX=0; shakeY=0;
  obstacles=[]; acorns=[]; powerups=[]; particles=[];
  frozenObs=[]; frozenAcorns=[]; frozenPUs=[];
  sq.y=GY-sq.h; sq.vy=0; sq.vx=0; sq.onGround=true; sq.jumps=0; sq.af=0; sq.inv=0; keys={};
  spawnClouds();
  document.getElementById('scr-start').style.display='none';
  document.getElementById('scr-over').style.display='none';
  updateTopUI();
  updatePUHud();
  requestAnimationFrame(loop);
}

function showGameOver(){
  document.getElementById('scr-over').style.display='flex';
  document.getElementById('go-score').textContent='SCORE: '+score;
  document.getElementById('go-acorns').textContent='🌰 '+acornCount+' ACORNS  ·  '+Math.floor(dist)+'m';
  if(livesRemaining<=0){
    document.getElementById('go-buy').style.display='none';
  } else {
    document.getElementById('go-buy').style.display='block';
    document.getElementById('go-lives-left').textContent=livesRemaining+' extra '+(livesRemaining===1?'life':'lives')+' left this hour';
  }
}

document.getElementById('btn-start').addEventListener('click',function(){
  if(!handle){ showHandleModal(startGame); return; }
  startGame();
});
document.getElementById('btn-restart').addEventListener('click',startGame);
document.getElementById('btn-continue').addEventListener('click', function(){
  document.getElementById('scr-ready').classList.remove('show');
  gState = 'playing';
  if(rafId){ cancelAnimationFrame(rafId); rafId=null; }
  rafId = requestAnimationFrame(loop);
});

// ════════════════════════════════════════════════════════
//  HANDLE MODAL
// ════════════════════════════════════════════════════════
var _afterHandle=null;
function showHandleModal(cb){
  _afterHandle=cb;
  document.getElementById('modal-handle').classList.add('show');
  document.getElementById('handle-inp').focus();
}
document.getElementById('btn-handle-ok').addEventListener('click',function(){
  var v=document.getElementById('handle-inp').value.trim().slice(0,20);
  if(!v) return;
  handle=v;
  localStorage.setItem('sq_handle',handle);
  document.getElementById('modal-handle').classList.remove('show');
  if(_afterHandle){ _afterHandle(); _afterHandle=null; }
});
document.getElementById('handle-inp').addEventListener('keydown',function(e){
  if(e.key==='Enter') document.getElementById('btn-handle-ok').click();
});

// ════════════════════════════════════════════════════════
//  TOP BAR UI
// ════════════════════════════════════════════════════════
function updateTopUI(){
  var lvl=Math.min(10,Math.floor((spd-2.5)/0.375)+1);
  var lvlEl=document.getElementById('p-level');
  lvlEl.textContent='LV '+lvl;
  // Colour shifts warm as level climbs: teal→blue→purple→gold
  var lvlCols=['#7BADE2','#7BADE2','#7BADE2','#98E8C1','#26D07C','#FFD700','#FFA040','#FF7060','#FF4470','#FF2255'];
  lvlEl.style.color=lvlCols[lvl-1]||'#fff';
  lvlEl.style.borderColor=lvlCols[lvl-1]||'#fff';
  document.getElementById('p-score').textContent='SCORE: '+score;
  document.getElementById('p-lives').textContent='❤ '+Math.max(lives,0);
}

// ════════════════════════════════════════════════════════
//  TOAST
// ════════════════════════════════════════════════════════
var _toastTimer;
function toast(msg,ms){
  ms=ms||2600;
  var el=document.getElementById('toast');
  el.textContent=msg; el.classList.add('on');
  clearTimeout(_toastTimer);
  _toastTimer=setTimeout(function(){el.classList.remove('on');},ms);
}

// ════════════════════════════════════════════════════════
//  LEADERBOARD
// ════════════════════════════════════════════════════════
var lbOpen=false;
document.getElementById('btn-lb').addEventListener('click',function(){
  lbOpen=!lbOpen;
  document.getElementById('lb-panel').classList.toggle('open',lbOpen);
  if(lbOpen) loadLeaderboard();
});
document.getElementById('lb-close').addEventListener('click',function(){
  lbOpen=false; document.getElementById('lb-panel').classList.remove('open');
});

function loadLeaderboard(){
  fetch('/api/leaderboard')
    .then(function(r){return r.json();})
    .then(function(rows){
      var me=wallet?wallet.toString():'';
      var medals=['🥇','🥈','🥉'];
      var html=rows.length===0?'<p class="lb-empty">No scores yet. Be first!</p>':'';
      for(var i=0;i<rows.length;i++){
        var row=rows[i];
        var rankCls=i<3?['gold','silver','bronze'][i]:'';
        var isMeCls=row.wallet===me?' me':'';
        html+='<div class="lb-row'+isMeCls+'">'+
          '<div class="lb-rank '+rankCls+'">'+(medals[i]||i+1)+'</div>'+
          '<div class="lb-name" title="'+row.wallet+'">'+escHtml(row.handle)+'</div>'+
          '<div class="lb-score">'+row.score.toLocaleString()+'</div>'+
        '</div>';
      }
      document.getElementById('lb-body').innerHTML=html;
    })
    .catch(function(){ document.getElementById('lb-body').innerHTML='<p class="lb-empty">Could not load.</p>'; });
}

function escHtml(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ════════════════════════════════════════════════════════
//  SCORE SUBMISSION
// ════════════════════════════════════════════════════════
function submitScore(){
  if(!wallet) return;
  fetch('/api/score',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      wallet:wallet.toString(),
      handle:handle||'Anon',
      score:score,
      acorns:acornCount,
      dist:Math.floor(dist)
    })
  }).then(function(r){return r.json();})
    .then(function(d){
      if(d.rank) document.getElementById('go-rank').textContent='Global rank: #'+d.rank+'  |  Best: '+d.personalBest;
    }).catch(function(){});
}

// ════════════════════════════════════════════════════════
//  PHANTOM WALLET
// ════════════════════════════════════════════════════════
var btnW = document.getElementById('btn-wallet');
btnW.addEventListener('click',connectWallet);

async function connectWallet(){
  if(!window.solana||!window.solana.isPhantom){
    toast('🦊 Install Phantom wallet!',3500);
    setTimeout(function(){window.open('https://phantom.app','_blank');},900);
    return;
  }
  try {
    var res=await window.solana.connect();
    onWalletConnected(res.publicKey);
  } catch(e){ toast('❌ Connection cancelled',2000); }
}

function onWalletConnected(pk){
  wallet=pk;
  conn=new solanaWeb3.Connection(RPC_URL,'confirmed');
  var addr=pk.toString();
  btnW.textContent='✓ '+addr.slice(0,4)+'…'+addr.slice(-4);
  document.getElementById('p-wallet').textContent=addr.slice(0,6)+'…'+addr.slice(-4);
  document.getElementById('p-wallet').style.display='block';
  document.getElementById('p-zep').style.display='block';
  fetchZepBalance();
  fetchLivesRemaining();
  toast('✅ Wallet connected!',2000);
  // Prompt for handle if not set
  if(!handle) showHandleModal(function(){});
}

// Listen for account switches
if(window.solana){
  window.solana.on('accountChanged',function(pk){
    if(pk){ onWalletConnected(pk); }
    else {
      wallet=null;
      document.getElementById('p-wallet').style.display='none';
      document.getElementById('p-zep').style.display='none';
      btnW.textContent='⬡ WALLET';
    }
  });
  // Auto-reconnect if trusted
  window.solana.connect({onlyIfTrusted:true}).then(function(r){
    if(r.publicKey) onWalletConnected(r.publicKey);
  }).catch(function(){});
}

async function fetchZepBalance(){
  if(!wallet) return;
  var el=document.getElementById('p-zep');
  el.textContent='🌰 ZEP: …';
  try {
    var r=await fetch('/api/zep-balance/'+wallet.toString());
    var d=await r.json();
    if(d.error){ el.textContent='🌰 ZEP: —'; return; }
    zepBal=d.balance; zepDec=d.decimals;
    el.textContent='🌰 ZEP: '+zepBal.toLocaleString(undefined,{maximumFractionDigits:0});
  } catch(e){
    el.textContent='🌰 ZEP: —';
    console.warn('ZEP balance',e);
  }
}

async function fetchLivesRemaining(){
  if(!wallet) return;
  try {
    var r=await fetch('/api/lives-remaining?wallet='+wallet.toString());
    var d=await r.json();
    livesRemaining=d.livesRemaining;
  } catch(e){}
}

// recipient is pre-set to RECIPIENT_WALLET

// ════════════════════════════════════════════════════════
//  SPL TOKEN HELPERS  (using @solana/spl-token browser build)
//  splToken is loaded via CDN below — official lib, no manual
//  byte packing, passes Phantom simulation cleanly.
// ════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════
//  LIFE PICKER
// ════════════════════════════════════════════════════════
var selectedLives = 1;

function openLifePicker() {
  if (!wallet) {
    document.getElementById('go-no-wallet').style.display = 'block';
    toast('🔗 Connect wallet first!', 2500); return;
  }
  if (livesRemaining <= 0) { toast('🚫 Hourly limit reached. Resets in ~1hr.', 3500); return; }

  selectedLives = 1;
  var opts = document.getElementById('life-opts');
  opts.innerHTML = '';
  var max = Math.min(5, livesRemaining);
  for (var i = 1; i <= max; i++) {
    (function(n) {
      var btn = document.createElement('button');
      btn.className = 'life-opt' + (n === 1 ? ' selected' : '');
      btn.textContent = n + (n === 1 ? ' LIFE' : ' LIVES');
      btn.dataset.n = n;
      btn.addEventListener('click', function() {
        selectedLives = n;
        document.querySelectorAll('.life-opt').forEach(function(b){ b.classList.remove('selected'); });
        btn.classList.add('selected');
        document.getElementById('lives-cost-display').textContent = (n * 100) + ' ZEP';
        document.getElementById('lives-cost-sub').textContent = n + ' ' + (n === 1 ? 'life' : 'lives') + ' · ' + (zepBal >= n*100 ? '✅ sufficient balance' : '❌ need ' + (n*100-Math.floor(zepBal)) + ' more ZEP');
      });
      opts.appendChild(btn);
    })(i);
  }
  // Set initial cost display
  document.getElementById('lives-cost-display').textContent = '100 ZEP';
  document.getElementById('lives-cost-sub').textContent = '1 life · ' + (zepBal >= 100 ? '✅ sufficient balance' : '❌ need ' + (100-Math.floor(zepBal)) + ' more ZEP');
  document.getElementById('modal-lives-err').style.display = 'none';
  document.getElementById('modal-lives').classList.add('show');
}

// ════════════════════════════════════════════════════════
//  BUY EXTRA LIFE  — full audit-compliant flow:
//  1. Build tx with official spl-token instructions
//  2. Server-side pre-flight simulation (catches errors
//     before the wallet popup ever appears)
//  3. sendTransaction via Phantom with preflightCommitment
//     so Phantom's own simulator also runs
//  4. Server broadcasts + confirms (no direct browser RPC)
// ════════════════════════════════════════════════════════
document.getElementById('btn-buy-life').addEventListener('click', openLifePicker);
document.getElementById('btn-lives-cancel').addEventListener('click', function(){ document.getElementById('modal-lives').classList.remove('show'); });
document.getElementById('btn-lives-confirm').addEventListener('click', function(){ buyExtraLife(selectedLives); });

async function buyExtraLife(livesCount) {
  livesCount = livesCount || 1;
  var totalZep = livesCount * 100;
  if (!wallet) {
    document.getElementById('go-no-wallet').style.display = 'block';
    toast('🔗 Connect wallet first!', 2500); return;
  }
  if (livesRemaining < livesCount) { toast('🚫 Only ' + livesRemaining + ' lives available this hour.', 3500); return; }
  if (zepBal < totalZep) { toast('❌ Need ' + totalZep + ' ZEP — you have ' + zepBal.toFixed(0), 3500); return; }
  // Close life picker modal
  document.getElementById('modal-lives').classList.remove('show');

  var btn = document.getElementById('btn-buy-life');
  btn.disabled = true; btn.textContent = '⏳ PREPARING…';

  try {
    // ── Step 1: Server builds instructions via official npm spl-token ──
    // Zero manual byte packing. Server uses @solana/spl-token to produce
    // createAssociatedTokenAccountIdempotent + TransferChecked instructions,
    // serializes them, and sends the data to the client.
    btn.textContent = '⏳ PREPARING…';
    var buildRes  = await fetch('/api/build-transfer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body:   JSON.stringify({ senderWallet: wallet.toString(), livesCount: livesCount })
    });
    var buildData = await buildRes.json();
    if (!buildRes.ok || buildData.error) throw new Error('Build error: ' + buildData.error);

    // ── Reconstruct TransactionInstructions from server data ──
    function deserializeIx(raw) {
      return new solanaWeb3.TransactionInstruction({
        programId: new solanaWeb3.PublicKey(raw.programId),
        keys: raw.keys.map(function(k) { return {
          pubkey:     new solanaWeb3.PublicKey(k.pubkey),
          isSigner:   k.isSigner,
          isWritable: k.isWritable,
        }; }),
        data: new Uint8Array(raw.data),
      });
    }

    // ── Fetch blockhash via server proxy ─────────────────
    var bhRes  = await fetch('/api/blockhash');
    var latest = await bhRes.json();
    if (latest.error) throw new Error('Blockhash error: ' + latest.error);

    // ── Assemble transaction ──────────────────────────────
    var tx = new solanaWeb3.Transaction({
      recentBlockhash:      latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
      feePayer:             wallet,
    });
    buildData.instructions.forEach(function(raw) { tx.add(deserializeIx(raw)); });

    // ── Step 2: Server-side pre-flight simulation ─────────
    // Runs simulateTransaction before wallet popup.
    // Catches insufficient balance, missing accounts, program errors.
    btn.textContent = '⏳ SIMULATING…';
    var simBytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    var simRes  = await fetch('/api/simulate-tx', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body:   JSON.stringify({ tx: Array.from(simBytes) })
    });
    var simData = await simRes.json();
    if (!simRes.ok || simData.error) throw new Error('Pre-flight: ' + simData.error);

    // ── Step 3: Phantom signs ─────────────────────────────
    // Because instructions were built with the official spl-token lib,
    // Phantom decodes them as "Send 100 ZEP to <address>" — no "unsafe" warning.
    btn.textContent = '⏳ APPROVE IN PHANTOM…';
    toast('🔏 Check Phantom — approve the 100 ZEP transfer', 10000);

    var signedTx = await window.solana.signTransaction(tx);

    // ── Step 3: Server broadcasts ─────────────────────────
    btn.textContent = '⏳ SENDING…';
    var sendBytes = signedTx.serialize();
    var sendRes  = await fetch('/api/send-tx', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body:   JSON.stringify({ tx: Array.from(sendBytes) })
    });
    var sendData = await sendRes.json();
    if (!sendRes.ok || sendData.error) throw new Error('Broadcast failed: ' + sendData.error);
    var sig = sendData.signature;

    // ── Step 4: Server confirms ───────────────────────────
    btn.textContent = '⏳ CONFIRMING…';
    toast('⏳ Confirming on-chain…', 10000);
    var cfRes  = await fetch('/api/confirm-tx', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body:   JSON.stringify({ signature: sig })
    });
    var cfData = await cfRes.json();
    if (!cfRes.ok || cfData.error) throw new Error('Confirmation failed: ' + cfData.error);

    // ── Step 5: Record each life on server (replay-attack protection) ─
    // We store livesCount separate entries, each tagged with the same sig
    // plus a suffix so uniqueness is maintained per-life.
    var gd;
    for (var li = 0; li < livesCount; li++) {
      var gr = await fetch('/api/grant-life', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: wallet.toString(), txSig: sig + '_' + li })
      });
      gd = await gr.json();
      if (!gr.ok) throw new Error(gd.error || 'Server rejected grant');
    }
    livesRemaining = gd.livesRemaining;
    lives = 3 + (livesCount - 1); // 1 life = back to 3, 2 lives = 4, etc.
    await fetchZepBalance();
    toast('✅ ' + livesCount + ' ' + (livesCount===1?'life':'lives') + ' added! ' + livesRemaining + ' left this hour.', 3500);

    // ── Resume game ───────────────────────────────────────
    if(rafId){ cancelAnimationFrame(rafId); rafId=null; }
    gState = 'playing';
    sq.y = GY - sq.h; sq.vy = 0; sq.jumps = 0; sq.inv = 200;
    obstacles = []; acorns = []; powerups = []; particles = [];
    frozenObs = []; frozenAcorns = [];
    document.getElementById('scr-over').style.display = 'none';
    updateTopUI();
    requestAnimationFrame(loop);

  } catch(e) {
    console.error(e);
    var msg = e && e.message ? e.message : '';
    if (msg.toLowerCase().includes('reject') || msg.toLowerCase().includes('cancel'))
      toast('❌ Cancelled', 2000);
    else
      toast('❌ ' + msg.slice(0, 72), 4500);
  } finally {
    btn.disabled = false; btn.textContent = '💎 PAY 100 ZEP — CONTINUE';
  }
}

// ════════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════════
resize();
// Draw static background behind start screen
(function staticBg(){
  ctx.clearRect(0,0,W,H);
  drawBg(0);
})();
<\/script>
</body>
</html>`;
}
