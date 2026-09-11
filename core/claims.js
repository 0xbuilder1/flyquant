/**
 * @pons/core — the honesty guard's harness, and the rows that are true of every PONS token.
 *
 * The site publishes exact numbers: the trade fee, the share that reaches the pot, the chain, the
 * quote asset. Every one of those is a promise, and the ones that come from the keeper live in
 * config.example.json where they can drift out from under the copy. This asserts the page and the
 * config still agree. It is a regression guard on honesty, which is the one thing these projects
 * cannot ship broken.
 *
 * Three layers, and the split is not tidiness:
 *   CORE  (here)              — derived from the config, never from the copy. Every token gets them.
 *   SINK  (sinks/<id>/claims) — what the sink's MECHANICS force, which is wrong to leave to a
 *                               copywriter: which leg the keeper actually performs, which hop it
 *                               refuses, where dollars are allowed to come from.
 *   TOKEN (tokens/<t>/keeper/claims) — this token's own promises: its causes, its unit costs, its
 *                               cadence sentence, its disclosures.
 *
 * A shared assertion file across tokens is explicitly NOT a goal — see CONTRACT.md. Every claim is
 * about one page's promises; only the harness and the derivable rows are shared.
 */
'use strict';

const fs = require('fs');
const path = require('path');

module.exports = function claims(o) {
  const root = o.root;
  const sink = o.sink;
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'));
  // ../site/index.html, unchanged from the single-repo layout. The site lives INSIDE the token
  // folder precisely so this relative path survived the migration: a site is the one artifact that
  // is 100% per-token, and one fewer edit here is worth more than a tidier tree.
  const site = fs.readFileSync(path.join(root, '..', 'site', 'index.html'), 'utf8');
  const distPath = path.join(root, '..', 'site', 'dist', 'index.html');
  const dist = fs.existsSync(distPath) ? fs.readFileSync(distPath, 'utf8') : null;

  const t = {
    cfg, site, dist, sink, root,
    failures: 0,
    distMarkers: [],           // strings the TOKEN says must survive the build; see builtOutput()
    check(name, ok, detail) {
      console.log(`  ${ok ? '✓' : '✗'}  ${name}${detail ? `   ${detail}` : ''}`);
      if (!ok) t.failures++;
    },
    says: (s) => site.includes(s),
    section(title) { console.log(`\n${title}`); },
  };

  /* ── the fee, as published vs as launched ─────────────────────────────────────────────────── */
  t.section('the fee, as published vs as launched');
  const traderPct = 1 + cfg.launch.creatorTaxBps / 100;
  const potPct = 0.7 + cfg.launch.creatorTaxBps / 100;
  t.check('trade fee: page says what a trader actually pays',
    t.says(`<b>${traderPct}%</b>`), `1% curve + ${cfg.launch.creatorTaxBps / 100}% tax = ${traderPct}%`);
  t.check('pot share: page says 2.7% and the split gives 2.7%',
    (t.says(`${potPct}% of all volume`) || t.says(`${potPct}% of volume`)),
    `${potPct}% reaches the pot`);
  t.check('page does NOT claim the pot receives the full 3%', !t.says(`${traderPct}% of volume reaches`));
  t.check('page no longer claims nobody is charged extra', !t.says('Nobody is charged extra'));

  /* ── chain facts ──────────────────────────────────────────────────────────────────────────── */
  t.section('chain facts');
  t.check('chain id matches config', t.says(String(cfg.chain.id)), String(cfg.chain.id));
  const native = !cfg.quote || !cfg.quote.asset || cfg.quote.asset === 'native';
  t.check('native quote: page shows claim() not claimToken()',
    native === (t.says('escrow.claim()') && t.says('0x4e71d92d') && !t.says('0x32f289cf')),
    cfg.quote.asset);
  t.check('page states the quote asset the keeper uses',
    native ? t.says('native ETH') : t.says(cfg.quote.symbol), cfg.quote.asset);

  /* The launch metadata is IMMUTABLE ONCE LAUNCHED, and the name and the ticker are the one part of
     it a page can contradict with nothing on-chain to catch it: they are what a buyer searches for,
     and after the launch transaction there is no version of them to correct.
     socials.website is deliberately NOT asserted — a site does not normally print its own domain,
     and build.js injects the canonical URL into the head rather than the copy. */
  const L = cfg.launch || {};
  const meta = [['name', L.name], ['symbol', L.symbol]].filter(([, v]) => v);
  t.check('the launch metadata on the page is the metadata in the config',
    meta.every(([, v]) => t.says(String(v))),
    meta.filter(([, v]) => !t.says(String(v))).map(([k]) => `${k} is not on the page`).join(', ')
      || meta.map(([, v]) => v).join(' · '));

  /* A tile fed by a key nothing publishes renders a permanent dash and reads as a broken keeper
     rather than a claim nobody makes. The keys the page may read are exactly the ones the core
     writes plus the ones this token's SINK emits, so the guard is derivable rather than a list. */
  t.check('the site does not claim a figure the keeper never emits',
    !t.says('s.sheriff') && !t.says('id="v-sheriff"'),
    'nothing in this composition ever emitted stats.sheriff — the tile read a permanent dash');

  t.check('fees redirected away from the keeper are surfaced too', t.says('s.feesRedirected'));

  /* ── built output ─────────────────────────────────────────────────────────────────────────
     Called LAST, by the token's test-claims.js, so the token has had a chance to name the copy it
     expects to survive the build. On a fresh clone dist/ does not exist at all and this used to be
     the whole failure; the token's `pretest` builds the site first, so the trap is closed by
     construction for every token in the repo. */
  t.builtOutput = function builtOutput() {
    t.section('built output');
    if (!dist) {
      t.check('dist/index.html exists (run: npm run build -w the site workspace)', false);
      return;
    }
    t.check('dist is a complete document',
      dist.startsWith('<!doctype html>') && dist.includes('</html>'));
    t.check('dist has exactly one <title>', (dist.match(/<title>/g) || []).length === 1);
    t.check('dist carries link-preview tags', dist.includes('og:image') && dist.includes('twitter:card'));
    t.check('dist ships unlaunched by default', dist.includes('var CA = null;'));
    t.check('dist is in sync with source (rebuild if this fails)',
      dist.includes(`<b>${traderPct}%</b>`) && t.distMarkers.every((m) => dist.includes(m)),
      `${t.distMarkers.length} token marker(s)`);
  };

  t.done = function done() {
    console.log(`\n${t.failures ? `${t.failures} CLAIM MISMATCH(ES)` : 'site and config agree'}\n`);
    process.exit(t.failures ? 1 : 0);
  };

  return t;
};
