/**
 * @pons/core — THE CONTRACT. See CONTRACT.md for the prose; this file is what enforces it.
 *
 * A sink is a plain CommonJS module. assertSink() runs at startup, BEFORE a client is built or a key
 * is read, and names any missing member — a sink that is wrong should fail on the first line of the
 * process, not three quiet passes later.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const API_VERSION = 1;

/** every member the core will call. Anything not here is the sink's own business. */
const REQUIRED = [
  'declare',        // static, read BEFORE configure — what the core must build
  'configure',      // dependency injection, exactly once, at composition
  'audit',          // the sink's own equality: {ok, deltaRaw}
  'spentRaw',       // wei that has already left
  'reservedRaw',    // wei promised but not yet sent
  'stats',          // the sink's half of the file the CORE writes
];
const OPTIONAL = [
  'preflight', 'reconcile', 'plan', 'printPlan', 'fire', 'cli', 'declaredFloatRaw',
];

function loadSink(mod) {
  if (typeof mod === 'string') return require(mod);
  return mod;
}

/**
 * A sink may NEVER construct a chain client.
 *
 * The charity sink's verifyLeg once built one inline with createPublicClient, which made it the only
 * network path in that module a fake chain could not intercept — and therefore the only one with no
 * test behind it, sitting behind the one leg a human types in. So the sink's own source is read and
 * refused if it names the constructor. Skipped silently when the sink's directory cannot be found
 * (a bundled or generated sink), and turned off with PONS_STRICT_SINK=0.
 */
function assertNoClients(sink) {
  if (process.env.PONS_STRICT_SINK === '0') return [];
  let dir = null;
  try {
    const entry = Object.values(require.cache).find((m) => m && m.exports === sink);
    if (entry) dir = path.dirname(entry.filename);
  } catch { /* no cache introspection: skip */ }
  if (!dir) return [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.js$/.test(f) && !/^test-/.test(f)); } catch { return []; }
  const bad = [];
  for (const f of files) {
    let src = '';
    try { src = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    // the comment in this very file names the constructor, so only a CALL counts
    if (/createPublicClient\s*\(/.test(src) || /createWalletClient\s*\(/.test(src)) bad.push(f);
  }
  return bad;
}

function assertSink(sink) {
  if (!sink || typeof sink !== 'object') throw new Error('@pons/core: no sink was passed to run().');
  const missing = REQUIRED.filter((k) => typeof sink[k] !== 'function');
  if (missing.length) {
    throw new Error(`@pons/core: this sink is missing ${missing.join(', ')} — see core/CONTRACT.md (api ${API_VERSION}).`);
  }
  const decl = sink.declare(require('./config.js').current());
  if (!decl || typeof decl !== 'object') throw new Error('@pons/core: sink.declare(cfg) returned nothing.');
  if (Number(decl.api) !== API_VERSION) {
    throw new Error(`@pons/core: this sink declares api ${decl.api}, and this core speaks api ${API_VERSION}.`);
  }
  if (!decl.id) throw new Error('@pons/core: sink.declare().id is required — it is the log prefix and the state namespace.');
  if (!decl.configKey) throw new Error('@pons/core: sink.declare().configKey is required — it names the one subtree of the config the core hands back.');
  const built = assertNoClients(sink);
  if (built.length) {
    throw new Error(
      `@pons/core: ${built.join(', ')} constructs a chain client. A sink may never do that — a client it built `
      + 'itself is the one network path a fake chain cannot intercept, and therefore the one with no test behind it. '
      + 'Declare the chain in declare().clients and take it from ctx.clients.');
  }
  return Object.assign({
    clients: [], keys: [], readOnlyCommands: [], commands: [], signerOptionalFor: [],
    outAsset: 'native', outLabel: 'out',
    /* WHO THE ESCROW IS SUPPOSED TO PAY.
       Null means "this keeper's own address", which is every sink that has ever existed here and
       stays the default. A sink returns an address instead when the fees are deliberately payable
       to something else — the short desk points them at its own contract so the vault fills with
       no operator in the middle.
       This is a declare field rather than a core config key on purpose: the core must not learn
       that a desk exists, and CONTRACT.md is explicit that `if (sink === 'x')` in core/ means the
       design is wrong. The core only asks "is the chain still paying who my sink said it would". */
    feeRecipient: null,
  }, decl);
}

/**
 * ctx — frozen at the top level, its members are not.
 *
 * Three of these are functions rather than values and it is not style: sinkCfg() and paths.outDir()
 * are re-read on every call because the fake-chain suites swap cfg.donate and cfg.output wholesale
 * AFTER configure(), and a captured object or a captured string would freeze the first case's config
 * into every later one.
 */
function buildCtx(o) {
  const ctx = {
    api: API_VERSION,
    cfg: o.cfg,
    sinkCfg: () => o.cfg[o.decl.configKey] || {},
    clients: o.clients,
    paths: o.paths,
    io: o.io,
    fmt: o.fmt,
    chain: o.chain,
    harvest: o.harvest,
    ceiling: o.ceiling,
    stats: o.stats,
    halt: null,              // the sink owns its own halt semantics — see CONTRACT.md
    lib: o.lib,
  };
  return Object.freeze(ctx);
}

module.exports = { API_VERSION, REQUIRED, OPTIONAL, loadSink, assertSink, buildCtx };
