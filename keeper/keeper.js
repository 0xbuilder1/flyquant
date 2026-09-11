/**
 * The whole of the $FLY keeper: the core, composed with the fly's sink.
 *
 * Launch detection, the escrow harvest, the ledger, the ceiling, the lock, the preflight frame and
 * the stats writer all live in core/ and are identical to every other token in this family. What is
 * unique to this one is trader/sink.js and the site. Never edited after it is created.
 */
'use strict';

const core = require('../core');
const sink = require('../trader/sink.js');

module.exports = core.run(sink, { root: __dirname });
