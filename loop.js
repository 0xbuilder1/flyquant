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
const every = Number(arg('every', 60)) * 1000;
const ms = arg('ms', '400');

let n = 0, failures = 0;

function pass() {
  n++;
  const seed = n;   // a different fly each pass, and the seed is published with the result
  const p = spawn(process.execPath, [path.join(__dirname, 'fly.js'), '--ms', ms, '--seed', String(seed)],
                  { stdio: ['ignore', 'pipe', 'pipe'] });
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

console.log(`fly loop: a pass every ${every / 1000}s, ${ms}ms of fly time each. Ctrl-C to stop.`);
pass();
