/**
 * @pons/core — publish stats.json so the site can read it.
 *
 * The keeper writes state/stats.json locally every round. The website needs that file from a public
 * URL, and it changes every few minutes, so committing and redeploying is not an option. This
 * uploads it to Vercel Blob under a stable pathname; the site reads it back through /api/stats.
 *
 * Entirely optional. With no BLOB_READ_WRITE_TOKEN in the environment the keeper runs exactly as
 * before and simply keeps the file to itself — publishing must never be able to interrupt or fail a
 * payment. The blob pathname is PONS_BLOB_PATH, documented in .env.example; ROBIN_BLOB_PATH is
 * honoured as a fallback for one release so an existing deployment keeps its stable URL.
 */
'use strict';

let put = null;
try { ({ put } = require('@vercel/blob')); } catch { /* dependency not installed — publishing is off */ }

const PATHNAME = process.env.PONS_BLOB_PATH || process.env.ROBIN_BLOB_PATH || 'stats.json';
let announced = false;
let lastBody = '';

/**
 * @param {object} stats  the same object written to state/stats.json
 * @returns {Promise<string|null>} the public URL, or null if publishing is not configured
 */
async function publishStats(stats, log) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token || !put) return null;

  const body = JSON.stringify(stats, null, 2);
  if (body === lastBody) return null;                  // nothing changed; do not burn a write

  try {
    const res = await put(PATHNAME, body, {
      access: 'public',
      token,
      contentType: 'application/json',
      allowOverwrite: true,
      addRandomSuffix: false,                          // stable URL across rounds
      cacheControlMaxAge: 60,
    });
    lastBody = body;
    if (!announced && log) {
      announced = true;
      log(`publishing stats to ${res.url}`);
      log('set STATS_BLOB_URL to that in Vercel, and the site serves it from /api/stats.');
    }
    return res.url;
  } catch (e) {
    // "the donation path" named ONE sink in a line the core prints for every one of them. What the
    // sentence actually promises is that publishing is fire-and-forget, and that is true whether the
    // money is going to five charities or five thousand discovered wallets.
    if (log) log(`stats publish failed (the money path is unaffected): ${(e && e.message) || e}`);
    return null;
  }
}

module.exports = { publishStats };
