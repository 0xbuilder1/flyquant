/**
 * $FLY's launch entrypoint. The core does the work; this only says which keeper directory.
 *
 *   node keeper/launch.js                 SIMULATE — builds the calldata, sends nothing
 *   node keeper/launch.js serve           the local launch form: YOUR wallet signs, in a browser
 *
 * `serve` is the one to use. The keeper never sees a private key, the metadata is editable with
 * live byte counts, and the calldata is built server-side from what the server actually holds.
 *
 * THE METADATA IS IMMUTABLE ONCE LAUNCHED. Name, symbol, description, logo and every social are
 * baked into the launch call and cannot be edited afterwards — the website URL especially, which
 * means the site needs its address decided BEFORE this runs, not after.
 */
'use strict';

module.exports = require('../core/launch.js').run(__dirname);
