/**
 * @pons/core — the composition root. A token's keeper.js calls run(sink, { root }) and nothing else.
 *
 *   node keeper.js --preflight              # verify every address on-chain, spend nothing
 *   node keeper.js                          # DRY RUN: full plan printed, nothing sent
 *   PRIVATE_KEY=0x.. node keeper.js --broadcast
 *   PRIVATE_KEY=0x.. node keeper.js --broadcast --loop
 *   node keeper.js --config <file>          # point at a throwaway-token config
 *
 * Everything past those five flags belongs to the sink, including every arming flag, every manual
 * command and every extra key. The core keeps: the config, the launch watcher, the harvest, the
 * ceiling, the lock, the preflight frame, stats.json and the loop.
 *
 * SAFETY: no transaction without --broadcast, at any layer. distribute.verified additionally gates
 * the UNATTENDED loop, and the sink's own flags gate the sink.
 */
'use strict';

const path = require('path');
const { privateKeyToAccount } = require('viem/accounts');
const config = require('./config.js');
const sinkApi = require('./sink.js');
const keyMod = require('./key.js');

function run(rawSink, opts) {
  const ROOT = (opts && opts.root) || process.cwd();
  const cfg = config.load(ROOT);
  const { BROADCAST, PREFLIGHT, LOOP, WATCH, DRY, arg, has } = config;

  const sink = sinkApi.loadSink(rawSink);
  // Everything below is required only after the config exists, so each module can capture the live
  // cfg object by reference the way engine.js did — the fake-chain suites reassign cfg.donate and
  // cfg.output after composition, and a copy would freeze the first case into every later one.
  const fmt = require('./fmt.js');
  const io = require('./io.js');
  const chain = require('./chain.js');
  const harvestMod = require('./harvest.js');
  const ceiling = require('./ceiling.js');
  const watch = require('./watch.js');
  const preflightMod = require('./preflight.js');
  const stats = require('./stats.js');
  const lock = require('./lock.js');

  const { lc, short, stamp, log, sleep, wired, outDir, ZERO } = fmt;

  // BEFORE a client is built and BEFORE a key is read: a sink that is wrong should fail on the
  // first line of the process, not three quiet passes later.
  const decl = sinkApi.assertSink(sink);

  /* Every chain client in the process, built ONCE here and never replaced. The source chain is the
     core's; everything else is exactly what declare().clients asked for, and the core has no opinion
     about what any of them is FOR. */
  const clients = { source: chain.source };
  for (const spec of decl.clients) {
    clients[spec.key] = chain.makePublicClient(spec);
  }

  const out = fmt.makeOut(decl);
  const paths = {
    root: () => ROOT,
    outDir,
    statsFile: () => stats.statsFile(),
    stateFile: (name) => path.join(outDir(), name),
    sinkDir: () => path.join(outDir(), decl.id),
  };

  const ctx = sinkApi.buildCtx({
    cfg, decl, clients, paths,
    io: {
      readJson: io.readJson, readLedgerJson: io.readLedgerJson,
      writeJson: io.writeJson, ensureDir: io.ensureDir,
    },
    fmt: {
      log, fq: fmt.fq, fOut: out.fOut, qSym: fmt.qSym, outSym: out.outSym,
      lc, short, stamp, now: fmt.now,
    },
    chain: { id: cfg.chain.id, name: cfg.chain.name, explorer: (cfg.chain && cfg.chain.explorer) || null },
    harvest: {
      claimedRaw: () => BigInt(harvestMod.readHarvest().claimedTotal || '0'),
      gasRaw: () => BigInt(harvestMod.readHarvest().gasRaw || '0'),
      pendingClaims: () => (harvestMod.readHarvest().pendingClaims || []).slice(),
      file: harvestMod.harvestFile,
      recordClaim: harvestMod.recordClaim,
      recordGas: harvestMod.recordGas,
      measureDelta: harvestMod.measureDelta,
      /* who the escrow is supposed to pay, and whether that is somebody other than this keeper.
         A sink that declared a contract recipient does its own money-in and needs to know it. */
      expectedRecipient: () => harvestMod.expectedRecipient(cfg.feeWallet.address),
      payableElsewhere: (addr) => harvestMod.payableElsewhere(addr),
    },
    ceiling: { donatable: ceiling.donatable, feesAvailable: ceiling.feesAvailable },
    stats: { write: () => stats.write() },
    lib: {
      scanLogs: require('./lib/scanlogs.js').scanLogs,
      ledger: require('./lib/ledger.js').ledger,
      inflight: require('./lib/inflight.js'),
      nonces: require('./lib/nonces.js'),
      tokenFacts: require('./lib/tokenfacts.js').tokenFacts,
    },
  });

  ceiling.bind(sink);
  preflightMod.bind(sink);
  stats.bind(sink);
  harvestMod.bind(decl);
  sink.configure(ctx);

  /* ═══════════════════════════════════════════════════════════════════════════════════════════ */
  async function fire(wc, addr, accounts) {
    const s = stamp();
    const claimed = await harvestMod.harvest(wc, addr, s);
    stats.write();                    // publish every pass: the site's live state comes from here

    if (DRY) {
      // `null` means NOTHING TO DO THIS PASS and is normal, not a failure — the pot is below a floor,
      // the snapshot is too early, a batch is still open. The sink has already logged its own reason
      // and the core must not add a second, vaguer one on top of it.
      const pl = sink.plan ? await sink.plan({ addr, s, pendingCredit: claimed, dry: DRY, accounts }) : null;
      if (!pl) return;
      if (sink.printPlan) sink.printPlan(pl, s);
      io.writeJson(path.join(outDir(), 'last-dry-plan.json'), pl);
      if (sink.fire) await sink.fire({ addr, accounts, wc, dry: DRY, s, plan: pl });
      return;
    }
    // The gate that lets the UNATTENDED loop act, and the only one the core owns. Every other arming
    // flag is the sink's, because what "armed" means differs with what is being armed.
    if (cfg.distribute.verified !== true) {
      log(s, 'the loop is BLOCKED — set distribute.verified=true only after a full throwaway-token cycle.');
      return;
    }
    /* RECONCILE is a phase the CORE drives, not something a sink is trusted to remember. Both real
       sinks already did it and both buried it — one inside its donate(), one inside its pay() — so a
       third sink would have had to rediscover that anything signed and not yet banked must be
       settled against the chain before anything new is priced against a balance that has moved.
       Not on a dry run: a dry run may not have side effects. */
    if (sink.reconcile) await sink.reconcile({ addr, accounts, wc, dry: DRY, s });
    if (sink.fire) await sink.fire({ addr, accounts, wc, dry: DRY, s, plan: null });
  }

  /* ── --next ──────────────────────────────────────────────────────────────────────────────────
     WHAT IS STILL UNDONE, at any moment, without a key and without a lock.

     A launched token that nobody is harvesting looks exactly like a launched token that somebody
     is: it trades, the explorer is busy, the site works. The only visible difference is a number
     in an escrow that nobody is looking at. That gap has already cost a real launch its first
     hour of fees, so this exists to be the thing an operator can run when they are not sure, and
     to answer in one screen rather than in a runbook.

     It reads. It signs nothing, takes no lock, and needs no environment at all. */
  async function nextSteps() {
    const pc = chain.source;
    const say = (ok, name, detail) => console.log(`  ${ok === null ? '·' : ok ? '✓' : '✗'}  ${name}${detail ? `   ${detail}` : ''}`);
    const eth = (v) => `${(Number(v) / 1e18).toFixed(6)} ETH`;
    const todo = [];

    console.log(`\n$${cfg.token.symbol} · what is left   (${path.basename(config.file())})\n`);

    const launched = wired(cfg.token.token);
    say(launched, 'token launched', launched ? cfg.token.token : 'not yet — run: node launch.js serve');
    if (!launched) { console.log('\n  start there; nothing below can be true yet.\n'); return; }

    /* WHERE THE ESCROW PAYS is the one that cannot be corrected afterwards, so it is read back off
       the factory rather than trusted from the config that was written by the same run. */
    let recipient = null;
    try {
      const info = await watch.launchedTokenInfo(cfg.token.token);
      recipient = info && info.feeRecipient;
    } catch { /* unreadable: reported as unknown rather than as agreement */ }
    const want = cfg.feeWallet.address;
    say(recipient ? lc(recipient) === lc(want) : null, 'fees go where the config says',
      recipient ? recipient : 'could not read the factory');

    let pending = 0n;
    try {
      pending = await pc.readContract({
        address: cfg.pons.escrow,
        abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
        functionName: 'balanceOf', args: [recipient || want],
      });
    } catch { /* zero credit reverts on this escrow, which is the normal case */ }
    say(null, 'waiting in the escrow', eth(pending));

    /* IS ANYTHING ACTUALLY HARVESTING. The lock is the only cross-process evidence there is, and a
       lock file left behind by a crash is not evidence, so the pid is probed too. */
    const held = io.readJson(lock.lockPath(), null);
    let alive = false;
    if (held && held.pid) { try { process.kill(held.pid, 0); alive = true; } catch { alive = false; } }
    say(alive, 'a keeper is running',
      alive ? `pid ${held.pid} since ${held.startedAt || '?'}`
        : held ? `stale lock from pid ${held.pid} — delete ${lock.lockPath()}` : 'nothing holds the lock');
    if (!alive) todo.push(['NOTHING IS HARVESTING. Fees sit in the escrow until this runs:',
      ['set PRIVATE_KEY=0xyourkey', 'node keeper.js --broadcast --loop']]);

    /* The site is built elsewhere and this process cannot see it, so this is stated rather than
       checked -- a step that is easy to skip is worth naming even when it cannot be verified. */
    console.log('');
    say(null, 'the site is built from an env var, not from this config',
      `TUMBLE_TOKEN_ADDRESS = ${cfg.token.token}`);

    if (todo.length) {
      console.log('\n  next:\n');
      for (const [why, cmds] of todo) {
        console.log(`  ${why}\n`);
        for (const c of cmds) console.log(`      ${c}`);
      }
    } else {
      console.log('\n  nothing outstanding that this can see.');
    }
    console.log('');
  }

  async function main() {
    /* before the key check: --next is for the operator who does not yet know what to set */
    if (has('--next')) { await nextSteps(); return; }

    /* readKey, not process.env directly: cmd's `set PRIVATE_KEY=0x.. && node keeper.js` captures
       the space before the && as part of the key, and the failure that produced was viem's
       "invalid private key, expected hex or 32 bytes, got string" — which names neither the
       variable nor the space. See core/key.js. */
    const keyIn = keyMod.readKey('PRIVATE_KEY');
    const pk = keyIn.value;
    if (keyIn.repaired) console.log(`note: PRIVATE_KEY had ${keyIn.repaired}; using the key inside it.`);
    /* PRIVATE_KEY is the source chain's signer and the core's own, so the core asks for it — but a
       sink command that signs on a DIFFERENT chain with a different key does not need it, and
       demanding it there would refuse a payout run on a machine that deliberately holds only the
       payout key. declare().signerOptionalFor names those commands; the sink says which, because the
       core cannot know. */
    const sinkCmd = (decl.signerOptionalFor || []).some((c) => has(c)) || decl.readOnlyCommands.some((c) => has(c));
    if (BROADCAST && !pk && !sinkCmd) {
      console.error('set PRIVATE_KEY (the token creatorFeeRecipient) to --broadcast');
      process.exit(1);
    }
    let account;
    if (pk) {
      try { account = privateKeyToAccount(pk); }
      catch (e) {
        /* the library's message describes a type, not a mistake anybody made */
        console.error(`\nPRIVATE_KEY is not a usable key: ${keyMod.keyProblem(pk)}.`);
        console.error('\nSet it like this:\n');
        console.error(keyMod.keyHint('PRIVATE_KEY'));
        console.error('');
        process.exit(1);
      }
    }
    const addr = account ? account.address : cfg.feeWallet.address;
    const wc = account ? chain.makeWalletClient(account) : undefined;

    /* Every OTHER key the sink needs. The core never names one: the env var, when it is required,
       what address it must equal and how to describe it all come out of declare().keys, so a sink
       that signs on a second chain does not put its own vocabulary into this function. */
    const accounts = { signer: account };
    for (const k of decl.keys) {
      const raw = process.env[k.env];
      let acct;
      if (raw) { try { acct = privateKeyToAccount(raw); } catch { acct = undefined; } }
      accounts[k.role] = acct;
      const need = typeof k.requiredWhen === 'function'
        ? k.requiredWhen({ broadcast: BROADCAST, dry: DRY, has, arg })
        : false;
      if (need && !acct) {
        console.error(`set ${k.env} (${k.hint || 'required for this command'}) to run this`);
        process.exit(1);
      }
      const mustEqual = typeof k.mustEqual === 'function' ? k.mustEqual() : null;
      if (need && acct && mustEqual && lc(acct.address) !== lc(mustEqual)) {
        console.error(`${k.env} holds ${acct.address}, not ${mustEqual} — refusing.`);
        process.exit(1);
      }
    }

    // printing a bare 0x0 here reads as "the keeper's address", and 0x0 is a real wallet holding real
    // ETH — the same confusion an unset feeWallet used to hand the operator further down.
    const { isAddress } = require('viem');
    const addrSet = isAddress(String(addr || '')) && lc(addr) !== ZERO;
    console.log(`$${cfg.token.symbol} keeper · ${PREFLIGHT ? 'PREFLIGHT' : DRY ? 'DRY RUN (no tx)' : 'BROADCAST'} · ${path.basename(config.file())} · keeper ${addrSet ? addr : '— unset —'}`);

    /* A cold clone has no config.json and falls back to the committed template without saying so.
       Naming the file in the banner is not enough: nothing on screen tells a first-time operator that
       every address in it is a placeholder, so the zeros and the empty ledger below read as breakage
       rather than as a repo nobody has configured yet. */
    if (config.usedDefault() && config.isTemplate()) {
      console.log(`no config.json — reading committed ${path.basename(config.file())}; its addresses are placeholders, so nothing here is wired yet.`);
      // NOT --config config.test.json: persistCfg refuses to write a committed template, so --watch
      // would keep the launched token in memory only and every later step would re-read 0x0 with the
      // launch already paid for. TESTING.md says copy it; the banner must not say something else.
      console.log('   throwaway-token test: cp config.test.json config.json (see TESTING.md).');
      console.log('   for real: cp config.example.json config.json and fill it in. config.json is gitignored.');
    }

    // Set exitCode and return rather than process.exit(): exiting hard while the HTTP transport
    // still holds handles trips a libuv assertion on Windows and prints a crash after a clean report.
    if (PREFLIGHT) { const ok = await preflightMod.preflight(addr, accounts); process.exitCode = ok ? 0 : 1; return; }

    // The sink's read-only commands are the only ones that skip the lock. Everything else touches
    // the ledger or can sign, so it takes the lock first: two keepers over one state directory is
    // two batches on consecutive nonces, or two payment runs on one nonce sequence.
    const readOnly = decl.readOnlyCommands.some((c) => has(c));
    if (!readOnly && !lock.acquireLock(stamp())) { process.exitCode = 1; return; }

    if (sink.cli && await sink.cli({ argv: process.argv, arg, has, dry: DRY, wc, account, accounts, addr, s: stamp() })) return;

    if (!wired() && WATCH) {
      const hit = await watch.watchForLaunch(addr, stamp());
      if (!hit) return;
    }
    if (!wired()) {
      // same trap as preflight: wired() is false for a mis-pasted address too, and "no token wired
      // yet" then sends an operator who HAS launched off to --watch to wait for an event that already
      // happened. A filled-in field that fails isAddress is a typo, and it is worth naming as one.
      const raw = String(cfg.token.token == null ? '' : cfg.token.token).trim();
      if (!raw || lc(raw) === ZERO) {
        console.log('idle — no token wired yet.');
        console.log('Run with --watch and set watch.creator to have the keeper find the launch itself.');
      } else {
        console.log(`idle — config.token.token is "${raw}", which is not an address (${raw.replace(/^0[xX]/, '').length} hex chars after 0x, need 40).`);
        console.log('That is a typo, not a missing launch: fix the address in the config.');
      }
      if (!LOOP) return;
    }
    if (!LOOP) {
      try { await fire(wc, addr, accounts); } catch (e) { console.log('fire error:', short(e)); }
      return;
    }
    const iv = (cfg.loop && cfg.loop.intervalMs) || 600000;
    console.log(`loop: every ${iv}ms`);
    for (;;) {
      if (wired()) { try { await fire(wc, addr, accounts); } catch (e) { console.log('fire error:', short(e)); } }
      await sleep(iv);
    }
  }

  /* The module surface a token's keeper.js re-exports. It is deliberately the same shape the old
     single-file engine exported, because the fake-chain suites hold `cfg` and the client objects by
     reference and fake a chain by assigning over their methods. `plan` keeps its positional
     signature for the same reason; the sink's own plan() takes the ctx-shaped object. */
  const surface = {
    cfg,
    sink,
    root: ROOT,          // the token's keeper directory: where config.json and state/ live
    declare: decl,
    clients,
    plan: (addr, s, claimed) => (sink.plan ? sink.plan({ addr, s, pendingCredit: claimed, dry: DRY, accounts: {} }) : null),
    printPlan: (pl, s) => (sink.printPlan ? sink.printPlan(pl, s) : undefined),
    preflight: (addr, accounts) => preflightMod.preflight(addr, accounts),
    updateStats: () => stats.write(),
    recordClaim: harvestMod.recordClaim,
    recordGas: harvestMod.recordGas,
    harvest: harvestMod.harvest,
    measureDelta: harvestMod.measureDelta,
    donatable: ceiling.donatable,
    feesAvailable: ceiling.feesAvailable,
    findLaunch: watch.findLaunch,
    launchedTokenInfo: watch.launchedTokenInfo,
    persistCfg: config.persistCfg,
    acquireLock: lock.acquireLock,
    fire,
    main,
  };

  // the token's keeper.js is `require.main` when it is run directly, so this is that file's
  // `if (require.main === module)` — one layer up, and the only place main() is ever called
  // (a test harness that lives beside keeper.js requires the sink, not the keeper — but it can also
  // sit in this same directory, so a `test-` entry never starts the keeper)
  const entry = require.main;
  if (entry && path.resolve(path.dirname(entry.filename)) === path.resolve(ROOT)
      && !/^test-/.test(path.basename(entry.filename))) {
    main().catch((e) => { console.error(short(e)); process.exitCode = 1; });
  }

  return surface;
}

module.exports = { run, API_VERSION: sinkApi.API_VERSION };
