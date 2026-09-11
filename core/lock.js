/* ═══════════════════════════════════════════════════════════════════════════════════════════
   MUTUAL EXCLUSION — one keeper at a time, per state directory
   ═══════════════════════════════════════════════════════════════════════════════════════════
   The documented workflow is a `--loop` process plus an operator typing a sink command by hand.
   Both read the ledger as idle, both take a pending nonce, both sign — and a CAPPED batch (amount
   well under the balance, the normal case whenever operator float exists) funds both, so the same
   ceiling leaves twice. O_EXCL is the cheapest thing that makes that impossible.

   It covers EVERY chain the sink declared and every key it loads: a payout run races a nonce
   sequence on a second chain as well as the sink's nonce on 4663, and five transfers signed twice on
   one sequence is the same failure with five times the blast radius. One state directory, one lock,
   all chains.

   Which commands are exempt is NOT decided here — it is declare().readOnlyCommands, because the core
   cannot know which of a sink's flags only read.
   ═══════════════════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const { log, outDir } = require('./fmt.js');
const { ensureDir, readJson } = require('./io.js');

function lockPath() { return path.join(outDir(), 'keeper.lock'); }

function acquireLock(s) {
  ensureDir();
  const body = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), argv: process.argv.slice(2) });
  try {
    fs.writeFileSync(lockPath(), body, { flag: 'wx' });
  } catch (e) {
    if (!e || e.code !== 'EEXIST') throw e;
    const held = readJson(lockPath(), {});
    /* A LOCK IS EVIDENCE OF A PROCESS, NOT OF A FILE. A keeper killed with the window closed, or
       taken out by a reboot, leaves this behind and every later start refused with "another keeper
       holds it" — which is false, and the instruction was to go and delete a file by hand. On a
       launch day that is a keeper that does not start and fees that do not move, for a reason that
       reads like a safety feature working.

       So the owner is probed. `process.kill(pid, 0)` sends no signal; it throws ESRCH when there is
       no such process and EPERM when there is one we may not signal — and EPERM is a LIVE process,
       so it must be treated as held. Anything else we cannot interpret is also treated as held,
       because the failure that matters here is two keepers on one nonce sequence, and the cost of
       being wrong in that direction is money rather than an error message. */
    let ownerAlive = true;
    if (held && held.pid) {
      try { process.kill(held.pid, 0); }
      catch (err) { if (err && err.code === 'ESRCH') ownerAlive = false; }
    }
    if (!ownerAlive) {
      log(s, `taking over a stale ${path.basename(lockPath())} — pid ${held.pid} is gone (held since ${held.startedAt || '?'}).`);
      try { fs.unlinkSync(lockPath()); fs.writeFileSync(lockPath(), body, { flag: 'wx' }); }
      catch (e2) {
        /* somebody else won the race between the unlink and the create: they hold it, we do not */
        log(s, `another keeper took ${path.basename(lockPath())} first — not running.`);
        return false;
      }
      const releaseStale = () => { try { fs.unlinkSync(lockPath()); } catch {} };
      process.on('exit', releaseStale);
      for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { releaseStale(); process.exit(130); });
      return true;
    }
    log(s, `another keeper holds ${path.basename(lockPath())} (pid ${held.pid || '?'} since ${held.startedAt || '?'}), and it is running.`);
    log(s, '   refusing to run: two keepers sign two batches on consecutive nonces and both can mine.');
    log(s, `   stop that process, or delete ${lockPath()} if you are certain it is gone.`);
    return false;
  }
  const release = () => { try { fs.unlinkSync(lockPath()); } catch {} };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { release(); process.exit(130); });
  return true;
}

module.exports = { lockPath, acquireLock };
