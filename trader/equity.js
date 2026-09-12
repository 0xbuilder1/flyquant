/**
 * The account's value over time. One line per pass, appended, never rewritten.
 *
 * This is the series the site draws, and it is the only long-lived record the keeper keeps about
 * itself. It is deliberately just NUMBERS AND A TIMESTAMP: whatever the account was worth, and what
 * was open at the time. No interpretation, no derived return, no annotation — anything computed from
 * it is computed by whoever reads it, so a bug in the reading can never corrupt the history.
 *
 * It records the account's VALUE, which is what somebody looking at it actually wants to know: the
 * line goes up when the fly makes money and also when money is added, and those are not separated
 * because the question the curve answers is "how big is this now".
 *
 * Append-only on purpose. A curve that can be rewritten is a curve that can be flattered.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_POINTS = 20000;      // roughly six weeks at a pass every three minutes

function file(root) {
  return path.join(root || path.join(__dirname, '..', 'keeper', 'state'), 'equity.jsonl');
}

/** one pass, one line. Never throws into the caller — a history write must not break a trade. */
function record(account, root) {
  if (!account || !Number.isFinite(account.equity)) return null;
  const point = {
    t: Date.now(),
    v: Math.round(Number(account.equity) * 1e6) / 1e6,
    u: Math.round(Number(account.unrealized || 0) * 1e6) / 1e6,
    x: Math.round(Number(account.exposure || 0) * 1e6) / 1e6,
    n: (account.positions || []).length,
  };
  try {
    const p = file(root);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(point) + '\n');
  } catch (e) {
    console.error('equity history write failed (continuing):', e.message);
  }
  return point;
}

/**
 * The series, thinned to `want` points for drawing.
 *
 * Thinning keeps the FIRST and LAST points exactly and strides the middle, so the endpoints of the
 * curve — the two a reader actually reads — are never interpolated away.
 */
function series(root, want = 600) {
  let lines;
  try { lines = fs.readFileSync(file(root), 'utf8').trim().split('\n').filter(Boolean); }
  catch { return []; }
  if (lines.length > MAX_POINTS) lines = lines.slice(-MAX_POINTS);

  const pts = [];
  for (const l of lines) { try { pts.push(JSON.parse(l)); } catch { /* skip a torn line */ } }
  if (pts.length <= want) return pts;

  const stride = Math.ceil(pts.length / want);
  const out = [];
  for (let i = 0; i < pts.length; i += stride) out.push(pts[i]);
  if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
  return out;
}

module.exports = { record, series, file, MAX_POINTS };
