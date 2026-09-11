/**
 * @pons/core — the config, and the two places it is allowed to be written back.
 *
 * ROOT is the TOKEN's keeper directory, handed in by core.run(sink, { root }); the core has no
 * directory of its own that a config could live in. Everything else here is engine.js's config
 * block unchanged.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Both templates are committed. --watch used to write the detected token straight back into
// whichever config it had loaded, so the documented throwaway run dirtied a tracked file and could
// commit a launched address into the shipped example. The keeper now refuses and tells you what it
// would have written; copy the template to config.json (gitignored) and re-run.
const TEMPLATES = new Set(['config.example.json', 'config.test.json']);

const BROADCAST = process.argv.includes('--broadcast');
const PREFLIGHT = process.argv.includes('--preflight');
const LOOP = process.argv.includes('--loop');
const WATCH = process.argv.includes('--watch');
const DRY = !BROADCAST;

const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; };
const has = (name) => process.argv.includes(name);

let cfg = null;
let cfgPath = null;
let cfgFlag = -1;
let ROOT = null;

/**
 * Load the config for a token whose keeper lives at `root`.
 *
 * This is called from core.run(), which a token's keeper.js calls at MODULE SCOPE — outside
 * main()'s catch, exactly as engine.js's load was. A mistyped --config or a trailing comma in a
 * hand-edited config.json used to exit through Node's own handler: a stack trace into node:fs with
 * an errno dump, naming neither the config nor the fix. Both are first-run mistakes — the operator
 * is told to copy config.example.json and hand-edit five addresses into it.
 */
function load(root) {
  if (cfg) return cfg;
  ROOT = root;
  // --config <path> lets you point the keeper at a throwaway-token config without touching the real
  // one. Falls back to config.json, then to the committed example.
  cfgFlag = process.argv.indexOf('--config');
  cfgPath = cfgFlag > -1 && process.argv[cfgFlag + 1]
    ? path.resolve(process.argv[cfgFlag + 1])
    : fs.existsSync(path.join(ROOT, 'config.json'))
      ? path.join(ROOT, 'config.json')
      : path.join(ROOT, 'config.example.json');
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      console.error(`no config at ${cfgPath}`);
      console.error('   cp config.example.json config.json and fill it in, or pass --config <file>.');
    } else if (e instanceof SyntaxError) {
      console.error(`${path.basename(cfgPath)} is not valid JSON: ${e.message}`);
      console.error('   a trailing comma or an unquoted key is the usual cause.');
    } else {
      console.error(`cannot read ${cfgPath}: ${(e && e.message) || e}`);
    }
    process.exit(1);
  }
  return cfg;
}

/** the live config object, captured by reference — never a copy, so a test that reassigns
 *  cfg.donate or cfg.output after composition is seen by every module that holds it. */
function current() {
  if (!cfg) throw new Error('@pons/core: config.load(root) has not run — call core.run(sink, { root }) first.');
  return cfg;
}

function root() { return ROOT; }
function file() { return cfgPath; }
function isTemplate() { return TEMPLATES.has(path.basename(cfgPath || '')); }
function usedDefault() { return cfgFlag === -1; }

/** never persist into a committed template — see TEMPLATES above */
function persistCfg(s) {
  const { log } = require('./fmt.js');
  const short = (e) => String((e && (e.shortMessage || e.message)) || e).split('\n')[0];
  if (isTemplate()) {
    log(s, `not writing ${path.basename(cfgPath)} — it is committed; copy it to config.json and re-run.`);
    log(s, `   token ${cfg.token.token} · curve ${cfg.token.curve} · launchBlock ${cfg.distribute.launchBlock}`);
    return;
  }
  try {
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    log(s, `wired into ${path.basename(cfgPath)} — token, curve and launchBlock persisted.`);
  } catch (e) { log(s, `could not write config (${short(e)}); continuing in memory.`); }
}

module.exports = {
  load, current, root, file, isTemplate, usedDefault, persistCfg,
  TEMPLATES, BROADCAST, PREFLIGHT, LOOP, WATCH, DRY, arg, has,
};
