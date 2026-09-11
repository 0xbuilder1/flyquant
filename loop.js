#!/usr/bin/env node
/**
 * Keep the fly going, so the site has something to show.
 *
 *   node loop.js                 a pass every 60s, 400ms of fly time
 *   node loop.js --every 30      faster
 *   node loop.js --ms 600        longer passes
 *
 * Each pass is a FRESH PROCESS on purpose. The graph reload costs ~70ms, and in exchange a pass
 * that throws cannot poison the next one, memory cannot creep across passes, and the loop keeps
 * running when the exchange has a bad minute. Nothing here can trade.
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const every = Number(arg('every', 180)) * 1000;
const ms = arg('ms', '400');
const warmupS = Number(arg('warmup', 20));
// --broadcast has to reach the child or the loop can never trade; it is listed explicitly rather
// than forwarded wholesale so nothing else leaks through by accident
const passthrough = ['--broadcast'];

let n = 0, failures = 0;

function pass() {
  n++;
  const seed = n;   // a different fly each pass, and the seed is published with the result
  const args = [path.join(__dirname, 'fly.js'), '--ms', ms, '--seed', String(seed)];
  // the first pass warms up so the fly has a real window to look at, and can act inside a minute
  // instead of waiting a whole interval for its second pass
  if (n === 1) args.push('--warmup', String(warmupS));
  for (const f of passthrough) if (process.argv.includes(f)) args.push(f);
  const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('close', (code) => {
    const line = out.split('\n').find((l) => /^  (LONG|SHORT|HOLD|ESCAPE)/.test(l)) || '';
    const stamp = new Date().toTimeString().slice(0, 8);
    if (code === 0) {
      failures = 0;
      console.log(`${stamp}  pass ${n} seed ${seed} ${line.trim() || '(no decision line)'}`);
    } else {
      failures++;
      console.log(`${stamp}  pass ${n} FAILED (${failures} in a row)\n${out.trim().split('\n').slice(-3).join('\n')}`);
    }
    setTimeout(pass, every);
  });
}

console.log(`fly loop: a pass every ${every / 1000}s, ${ms}ms of fly time each` +
  `, ${warmupS}s warmup on the first` +
  (process.argv.includes('--broadcast') ? ', BROADCAST ON' : ', dry') + '. Ctrl-C to stop.');
pass();
