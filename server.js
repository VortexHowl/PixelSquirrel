#!/usr/bin/env node
/*
 ╔═══════════════════════════════════════════════════════════╗
 ║  PIXEL SQUIRREL  v2.0  —  ZEP Runner                    ║
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
    const rpcRes = await fetch('https://api.mainnet-beta.solana.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getTokenAccountsByOwner',
        params: [
          wallet,
          { mint: '6o4MAKKTwdtni9o6NdiR5HgGC62pL6YmqDNBhoPmVray' },
          { encoding: 'jsonParsed' }
        ]
      })
    });
    const data = await rpcRes.json();
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
  <div id="title">🐿 PIXEL SQUIRREL</div>
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
        <button class="bbtn bpay" id="btn-buy-life">💎 PAY 100 ZEP — CONTINUE</button>
        <p id="go-no-wallet" style="color:#ff9999;font-size:9px;margin-top:6px;display:none;">Connect wallet first!</p>
      </div>
      <button class="bbtn bplay" id="btn-restart">↺ NEW GAME</button>
    </div>
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

<script>
'use strict';
// ════════════════════════════════════════════════════════
//  CONSTANTS
// ════════════════════════════════════════════════════════
var ZEP_MINT   = '6o4MAKKTwdtni9o6NdiR5HgGC62pL6YmqDNBhoPmVray';
var RPC_URL    = 'https://api.mainnet-beta.solana.com';
var TOK_PROG   = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
var ATA_PROG   = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1brs';
var SNS_URL    = 'https://sns-sdk-proxy.bonfida.workers.dev/resolve/vortexhowl';

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
var wallet=null, zepBal=0, zepDec=9, recipient=null, conn=null;
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
var SQ_PAL = [
  null,        // 0 transparent
  C.sqDk,      // 1 very dark brown
  C.sqMd,      // 2 dark brown
  C.sqLt,      // 3 medium brown
  C.sqCr,      // 4 cream
  C.sqBk,      // 5 black (eyes)
  C.sqPk,      // 6 pink (nose/ears)
  C.sqGr,      // 7 teal (collar)
  C.sqTD,      // 8 tail outer
  C.sqTL,      // 9 tail highlight
];

// Each row is 16 columns (0 = transparent)
var SQ_BODY = [
  [0,2,0,0,2,0,0,0,0,0,0,0,0,0,0,0], // 0  ear tips
  [2,3,2,0,2,3,2,0,0,0,0,0,0,0,0,0], // 1  ears
  [2,6,6,2,2,6,6,2,0,0,0,0,0,0,0,0], // 2  inner ear pink
  [1,2,2,2,2,2,2,1,0,0,0,0,0,0,0,8], // 3  head + tail tip
  [2,5,3,3,3,3,5,2,0,0,0,0,0,0,8,9], // 4  eyes + tail
  [2,3,3,3,3,3,3,2,0,0,0,0,0,8,9,9], // 5  face + tail
  [2,3,6,3,3,6,3,2,0,0,0,0,8,9,9,8], // 6  nose + tail
  [1,2,2,2,2,2,2,1,0,0,0,8,9,9,8,0], // 7  chin + tail
  [0,7,7,7,7,7,7,0,0,0,8,9,9,8,0,0], // 8  collar (pride green) + tail
  [0,2,3,4,4,3,2,0,0,8,9,9,8,0,0,0], // 9  body/belly + tail
  [0,2,4,4,4,4,2,0,8,9,9,8,0,0,0,0], // 10 belly + tail
  [0,2,4,4,4,4,2,0,8,9,8,0,0,0,0,0], // 11 belly lower
  [0,1,2,2,2,2,1,0,8,8,0,0,0,0,0,0], // 12 body
  [0,0,2,2,2,2,0,0,0,0,0,0,0,0,0,0], // 13 body bottom
];
var SQ_PX = 3; // pixels per sprite cell

// Leg positions [frontCol, backCol] for 4 animation frames
// Each frame is drawn as two 2×4px rectangles at row 14
var LEG_FRAMES = [
  {f:[2,14], b:[5,13]}, // frame 0: symmetric
  {f:[2,13], b:[5,15]}, // frame 1: stride fwd
  {f:[2,14], b:[5,14]}, // frame 2: mid
  {f:[2,15], b:[5,13]}, // frame 3: stride back
];

function drawSquirrel(ox, oy, af, inv, dead) {
  ctx.save();
  if (inv > 0 && Math.floor(inv/5)%2===1) ctx.globalAlpha = 0.28;
  if (dead) {
    ctx.translate(ox + sq.w/2, oy + sq.h/2);
    ctx.rotate(Math.PI/2);
    ctx.translate(-sq.w/2, -sq.h/2);
    ox = 0; oy = 0;
  }
  // Shield glow ring
  if (puShield > 0 && !dead) {
    ctx.save();
    ctx.globalAlpha = 0.5 + 0.4*Math.sin(frame*0.15);
    ctx.strokeStyle = '#4DB8FF';
    ctx.lineWidth = 4;
    ctx.shadowColor = '#4DB8FF';
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.ellipse(ox + sq.w/2, oy + sq.h/2, sq.w*0.7, sq.h*0.6, 0, 0, Math.PI*2);
    ctx.stroke();
    ctx.restore();
  }
  // Magnet glow
  if (puMagnet > 0 && !dead) {
    ctx.save();
    ctx.globalAlpha = 0.3 + 0.2*Math.sin(frame*0.1);
    ctx.fillStyle = C.gold;
    ctx.shadowColor = C.gold;
    ctx.shadowBlur = 20;
    ctx.beginPath();
    ctx.ellipse(ox + sq.w/2, oy + sq.h/2, sq.w*0.85, sq.h*0.75, 0, 0, Math.PI*2);
    ctx.fill();
    ctx.restore();
  }
  // Body pixel grid
  for (var r=0; r<SQ_BODY.length; r++) {
    for (var cl=0; cl<SQ_BODY[r].length; cl++) {
      var v = SQ_BODY[r][cl];
      if (!v) continue;
      ctx.fillStyle = SQ_PAL[v];
      ctx.fillRect(ox + cl*SQ_PX, oy + r*SQ_PX, SQ_PX, SQ_PX);
    }
  }
  // Animated legs
  var lf = LEG_FRAMES[af % 4];
  ctx.fillStyle = C.sqMd;
  ctx.fillRect(ox + lf.f[0]*SQ_PX, oy + lf.f[1]*SQ_PX, 2*SQ_PX, 4*SQ_PX);
  ctx.fillRect(ox + lf.b[0]*SQ_PX, oy + lf.b[1]*SQ_PX, 2*SQ_PX, 4*SQ_PX);
  // Feet
  ctx.fillStyle = C.sqDk;
  ctx.fillRect(ox + (lf.f[0]-0.5)*SQ_PX, oy + (lf.f[1]+4)*SQ_PX, 3*SQ_PX, SQ_PX);
  ctx.fillRect(ox + (lf.b[0]-0.5)*SQ_PX, oy + (lf.b[1]+4)*SQ_PX, 3*SQ_PX, SQ_PX);
  ctx.restore();
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
  ctx.fillText('SPD '+spd.toFixed(1)+' / 6.25', W/2, 24);
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
    requestAnimationFrame(loop);
    return;
  }

  if(gState!=='playing') return; // start screen — no loop rescheduled

  requestAnimationFrame(loop);

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
  if(animTick%6===0) sq.af=(sq.af+1)%4;

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
  resolveRecipient();
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

// ── Recipient resolution (vortexhowl.sol) ───────────────
async function resolveRecipient(){
  if(recipient) return;
  try {
    var r=await fetch(SNS_URL);
    var d=await r.json();
    if(d&&d.result) recipient=new solanaWeb3.PublicKey(d.result);
  } catch(e){ console.warn('SNS resolve',e); }
}

// ════════════════════════════════════════════════════════
//  SPL TOKEN HELPERS (no extra lib needed)
// ════════════════════════════════════════════════════════
async function getATA(owner,mint){
  var res=await solanaWeb3.PublicKey.findProgramAddress(
    [owner.toBuffer(), new solanaWeb3.PublicKey(TOK_PROG).toBuffer(), mint.toBuffer()],
    new solanaWeb3.PublicKey(ATA_PROG)
  );
  return res[0];
}

function makeTransferChecked(src,mint,dst,owner,amount,dec){
  var buf=new Uint8Array(10); buf[0]=12;
  var n=BigInt(amount);
  for(var i=1;i<=8;i++){ buf[i]=Number(n&BigInt(0xff)); n>>=BigInt(8); }
  buf[9]=dec;
  return new solanaWeb3.TransactionInstruction({
    keys:[
      {pubkey:src,  isSigner:false,isWritable:true},
      {pubkey:mint, isSigner:false,isWritable:false},
      {pubkey:dst,  isSigner:false,isWritable:true},
      {pubkey:owner,isSigner:true, isWritable:false},
    ],
    programId:new solanaWeb3.PublicKey(TOK_PROG),
    data:buf
  });
}

function makeCreateATA(payer,ata,owner,mint){
  return new solanaWeb3.TransactionInstruction({
    keys:[
      {pubkey:payer,isSigner:true, isWritable:true},
      {pubkey:ata,  isSigner:false,isWritable:true},
      {pubkey:owner,isSigner:false,isWritable:false},
      {pubkey:mint, isSigner:false,isWritable:false},
      {pubkey:solanaWeb3.SystemProgram.programId,isSigner:false,isWritable:false},
      {pubkey:new solanaWeb3.PublicKey(TOK_PROG),isSigner:false,isWritable:false},
    ],
    programId:new solanaWeb3.PublicKey(ATA_PROG),
    data:new Uint8Array([1]) // 1 = CreateIdempotent
  });
}

// ════════════════════════════════════════════════════════
//  BUY EXTRA LIFE
// ════════════════════════════════════════════════════════
document.getElementById('btn-buy-life').addEventListener('click',buyExtraLife);

async function buyExtraLife(){
  if(!wallet){
    document.getElementById('go-no-wallet').style.display='block';
    toast('🔗 Connect wallet first!',2500); return;
  }
  if(livesRemaining<=0){ toast('🚫 5-life hourly limit reached. Resets in ~1hr.',3500); return; }
  if(zepBal<100){ toast('❌ Need 100 ZEP. You have '+zepBal.toFixed(0),3500); return; }
  if(!recipient){
    toast('🔄 Resolving vortexhowl.sol…',2000);
    await resolveRecipient();
    if(!recipient){ toast('❌ Could not resolve vortexhowl.sol',3500); return; }
  }

  var btn=document.getElementById('btn-buy-life');
  btn.disabled=true; btn.textContent='⏳ SENDING…';

  try {
    var mintPk=new solanaWeb3.PublicKey(ZEP_MINT);
    var amount=BigInt(Math.round(100*Math.pow(10,zepDec)));
    var senderATA=await getATA(wallet,mintPk);
    var recipATA =await getATA(recipient,mintPk);

    var tx=new solanaWeb3.Transaction();
    // Always include idempotent createATA — safe no-op if account already exists,
    // avoids needing a getAccountInfo RPC call from the browser (CORS-prone)
    tx.add(makeCreateATA(wallet,recipATA,recipient,mintPk));
    tx.add(makeTransferChecked(senderATA,mintPk,recipATA,wallet,amount,zepDec));

    var latest=await conn.getLatestBlockhash();
    tx.recentBlockhash=latest.blockhash;
    tx.feePayer=wallet;

    toast('🔏 Approve in Phantom…',9000);
    var signed=await window.solana.signAndSendTransaction(tx);
    var sig=signed.signature;

    toast('⏳ Confirming on-chain…',9000);
    await conn.confirmTransaction({signature:sig,blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight},'confirmed');

    // Tell server — replay-protected
    var gr=await fetch('/api/grant-life',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({wallet:wallet.toString(),txSig:sig})
    });
    var gd=await gr.json();
    if(!gr.ok) throw new Error(gd.error||'Server rejected grant');

    livesRemaining=gd.livesRemaining;
    lives=3;
    await fetchZepBalance();

    toast('✅ Extra life granted! '+livesRemaining+' left this hour.',3500);

    // Resume game
    gState='playing';
    sq.y=GY-sq.h; sq.vy=0; sq.jumps=0; sq.inv=200;
    obstacles=[]; acorns=[]; powerups=[]; particles=[];
    frozenObs=[]; frozenAcorns=[];
    document.getElementById('scr-over').style.display='none';
    updateTopUI();
    requestAnimationFrame(loop);

  } catch(e){
    console.error(e);
    var msg=e&&e.message?e.message:'';
    if(msg.includes('rejected')||msg.includes('cancel')) toast('❌ Cancelled',2000);
    else toast('❌ '+msg.slice(0,60),4000);
  } finally {
    btn.disabled=false; btn.textContent='💎 PAY 100 ZEP — CONTINUE';
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
