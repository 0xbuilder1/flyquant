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
 * Write a blob without being told what kind of store this is.
 *
 * Vercel Blob stores are public or private, a store created today defaults to private, and a public
 * write into a private store is refused outright: "Cannot use public access on a private store."
 * Which kind the operator made is not something the keeper should have to be configured with, so it
 * tries public, and on that one specific refusal switches to private and remembers for the rest of
 * the process.
 *
 * Public is preferred when it is available because the page can then read the blob straight off the
 * CDN — every byte otherwise goes through a serverless function, and the activity alone is 273KB a
 * pass. BLOB_ACCESS pins it either way if the operator would rather not have it guess.
 */
let access = process.env.BLOB_ACCESS || 'public';
async function putEither(pathname, body, opts) {
  try {
    return await put(pathname, body, { ...opts, access });
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (access === 'public' && /private store|public access/i.test(msg)) {
      access = 'private';
      return put(pathname, body, { ...opts, access });
    }
    throw e;
  }
}

/** which kind of store we ended up writing to — the caller needs it to know if a url is fetchable */
function blobAccess() { return access; }

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
    const res = await putEither(PATHNAME, body, {
      token,
      contentType: 'application/json',
      allowOverwrite: true,
      addRandomSuffix: false,                          // stable URL across rounds
      // ZERO, AND IT IS THE WHOLE REASON THE PAGE LAGGED. This file is the live one: a CDN copy
      // sixty seconds old is worse than no answer, because it looks current. It is 78KB and it
      // changes every pass, so there is nothing here worth caching.
      cacheControlMaxAge: 0,
    });
    lastBody = body;
    if (!announced && log) {
      announced = true;
      log(`publishing stats to ${res.url}`);
      log('set FLY_STATS_URL to that in Vercel, and the site serves it from /api/stats.');
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

/**
 * Put any file where the site can read it, under a stable name.
 *
 * publishStats() is for the JSON the page prints numbers from. This is for everything ELSE the page
 * needs live — the neuron activity in particular, which is binary, 273KB a pass, and is what makes
 * the fly on the page light up with what actually just fired rather than with whatever was committed
 * to git.
 *
 * Same posture as publishStats: no token, no upload, no complaint, and never able to fail a pass.
 */
async function publishFile(pathname, body, contentType) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token || !put) return null;
  const res = await putEither(pathname, body, {
    token,
    contentType: contentType || 'application/octet-stream',
    allowOverwrite: true,
    addRandomSuffix: false,           // stable URL, so the page never has to be told a new one
    // the page appends ?t=<pass timestamp>, so each pass is a new URL and the cache is busted by
    // the request. Short anyway, so a stale copy cannot outlive a pass.
    cacheControlMaxAge: 10,
  });
  return res.url;
}

module.exports = { publishStats, publishFile, blobAccess };
