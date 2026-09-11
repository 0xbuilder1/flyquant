/**
 * @pons/core/lib — the in-flight log: raw signed bytes on the disk BEFORE any node has seen them.
 *
 * Offered, never demanded. Two properties are the whole value and both were learned the hard way:
 *
 *   1. APPEND AND FSYNC BEFORE BROADCAST. appendFileSync returns once the write reaches the page
 *      cache, which is not the same as the disk. A holder sink appended AFTER the send returned,
 *      which leaves a window where a crash loses the hash entirely. A re-broadcast of the identical
 *      raw transaction is the SAME hash on the SAME nonce and the chain dedupes it, so replay after
 *      a crash physically cannot double-send — but only if the bytes survived the crash.
 *
 *   2. SWEEP EVERY FILE, NOT THIS ROUND'S. A crashed round leaves its log behind under ITS OWN name
 *      while the restarted keeper is on a new one, so sweeping only the current file means the
 *      reconciliation silently never runs and every interrupted payment is sent twice.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** one JSONL log, named by the sink. `key` is the field a drop() call matches on. */
function inflight(file) {
  return {
    file,

    /** fsync'd: a power cut here is exactly the case the ordering claim is about */
    append(row) {
      const fd = fs.openSync(file, 'a');
      try { fs.writeSync(fd, JSON.stringify(row) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    },

    rows() {
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    },

    /** drop the rows `match` accepts and keep everybody else's — the log is shared */
    drop(match) {
      if (!fs.existsSync(file)) return;
      const keep = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).filter((l) => {
        try { return !match(JSON.parse(l)); } catch { return true; }
      });
      if (!keep.length) { try { fs.unlinkSync(file); } catch {} return; }
      fs.writeFileSync(`${file}.tmp`, keep.join('\n') + '\n');
      fs.renameSync(`${file}.tmp`, file);
    },

    unlink() { try { fs.unlinkSync(file); } catch {} },
  };
}

/**
 * Every in-flight log in `dir` whose name matches, INCLUDING the ones a previous round left behind.
 * That is the point: reconciling only the current file is how an interrupted round pays twice.
 */
function sweepAll(dir, re) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => re.test(n)); } catch { return []; }
  return names.map((n) => inflight(path.join(dir, n)));
}

module.exports = { inflight, sweepAll };
