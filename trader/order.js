/**
 * Placing the order, and writing down that it happened.
 *
 * NOTHING SENDS WITHOUT BOTH `--broadcast` AND `trade.armed`. Two independent switches, one on the
 * command and one in the config, because every other product in this family learned that a single
 * seatbelt gets left fastened by accident. The signer holds a third — a maximum notional it will
 * refuse to exceed whatever this file believes.
 *
 * THE FEED IS APPEND-ONLY AND IT RECORDS REFUSALS TOO. A feed that only shows the orders that went
 * through is a highlight reel. Every pass writes a line: what the fly wanted, what the account
 * already held, what the difference was, and either the transaction that resulted or the reason
 * there wasn't one. The site shows that line either way.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { verifyTx, verifyAccount } = require('./account.js');

const FEED_KEEP = 200;

function feedPath(root) {
  return path.join(root || path.join(__dirname, '..', 'keeper', 'state'), 'feed.jsonl');
}

/** append one line, and never let a feed write break a pass */
function record(entry, root) {
  try {
    const p = feedPath(root);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('feed write failed (continuing):', e.message);
  }
  return entry;
}

/** the last N entries, newest first, for the page */
function recent(root, n = 40) {
  try {
    const lines = fs.readFileSync(feedPath(root), 'utf8').trim().split('\n');
    return lines.slice(-Math.min(n, FEED_KEEP)).map((l) => JSON.parse(l)).reverse();
  } catch { return []; }
}

/** run the signer. Resolves with its JSON whatever happened — the caller decides what is fatal. */
function callSigner(order, cfg, broadcast) {
  return new Promise((resolve) => {
    const args = [
      path.join(__dirname, 'signer.py'),
      '--account', String(cfg.accountIndex),
      '--api-key-index', String(cfg.apiKeyIndex == null ? 4 : cfg.apiKeyIndex),
      '--max-notional', String(cfg.maxNotionalUsd || 0),
      '--max-notional-fraction', String(cfg.maxNotionalFractionOfEquity || 0),
    ];
    if (broadcast) args.push('--broadcast');

    const py = process.env.PYTHON || 'python';
    const p = spawn(py, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => resolve({ ok: false, error: `could not run ${py}: ${e.message}` }));
    p.on('close', () => {
      try { resolve(JSON.parse(out.trim().split('\n').pop())); }
      catch { resolve({ ok: false, error: (err || out || 'the signer said nothing').trim().split('\n').pop() }); }
    });
    p.stdin.end(JSON.stringify(order));
  });
}

/**
 * Act on a plan. Returns the feed entry it wrote.
 *
 * `broadcast` is the command-line switch; `cfg.armed` is the config one. A plan with no order still
 * writes a line, because "the fly wanted this and it was too small to send" is exactly the kind of
 * thing that should be visible rather than silently absent.
 */
async function execute({ plan, cfg, broadcast, context = {} }) {
  const at = Date.now();
  const common = {
    at,
    symbol: plan.symbol,
    marketId: plan.marketId,
    action: plan.action,
    flySize: plan.size,
    equity: round(plan.equity),
    held: round(plan.held),
    target: plan.target == null ? null : round(plan.target),
    delta: plan.delta == null ? null : round(plan.delta),
    mark: plan.mark,
    why: plan.order ? plan.order.why : null,
    ...context,
  };

  if (!plan.order) {
    return record({ ...common, status: 'none', note: plan.reason }, cfg.stateRoot);
  }

  const o = plan.order;
  const armed = !!cfg.armed;
  const live = broadcast && armed;

  if (!live) {
    return record({
      ...common,
      status: 'dry',
      side: o.side, sizeBase: o.sizeBase, notional: round(o.notional), reduceOnly: o.reduceOnly,
      execution: o.execution, limitPrice: o.limitPrice, spreadBps: o.spreadBps,
      note: !armed ? 'trade.armed is false' : 'no --broadcast',
      verify: verifyAccount(cfg.accountIndex),
    }, cfg.stateRoot);
  }

  const res = await callSigner({
    marketId: o.marketId,
    isAsk: o.isAsk,
    sizeBase: o.sizeBase,
    sizeDecimals: cfg.sizeDecimals || 0,
    notional: o.notional,
    reduceOnly: o.reduceOnly,
    execution: o.execution || 'market',
    limitPrice: o.limitPrice,
    priceDecimals: cfg.priceDecimals || 6,
    // An unfilled post-only order must be GONE before the next pass computes a fresh target,
    // otherwise two passes' worth of intent rest in the book at once and the account ends up
    // holding double what the fly asked for.
    expirySeconds: cfg.expirySeconds || 170,
    maxSlippage: cfg.maxSlippage == null ? 0.005 : cfg.maxSlippage,
    idealPrice: o.mark,
  }, cfg, true);

  if (!res.ok) {
    return record({
      ...common, status: 'refused',
      side: o.side, sizeBase: o.sizeBase, notional: round(o.notional),
      note: res.error,
    }, cfg.stateRoot);
  }

  return record({
    ...common,
    status: 'sent',
    side: o.side, sizeBase: o.sizeBase, notional: round(o.notional), reduceOnly: o.reduceOnly,
    execution: o.execution, limitPrice: o.limitPrice, spreadBps: o.spreadBps,
    txHash: res.txHash || null,
    clientOrderIndex: res.clientOrderIndex || null,
    verify: res.txHash ? verifyTx(res.txHash) : verifyAccount(cfg.accountIndex),
  }, cfg.stateRoot);
}

const round = (x) => (x == null ? null : Math.round(Number(x) * 1e6) / 1e6);

module.exports = { execute, record, recent, feedPath, callSigner, FEED_KEEP };
