/**
 * @pons/core — reading and writing the state directory.
 *
 * Two readers, deliberately. readJson is lenient and is for the published stats file; readLedgerJson
 * is strict and is for anything a sink spends against. The strict one is NOT optional at the seam:
 * ctx.io.readLedgerJson is this function and a sink has no way to substitute the lenient one for it.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { outDir } = require('./fmt.js');

function ensureDir() { const d = outDir(); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); return d; }
function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }

/**
 * The ledger files get a stricter reader than the stats file does. readJson cannot tell "this file
 * has never existed" from "this file is half-written", and for a donation ledger the difference is
 * everything: a truncated ledger read as an empty one restarts seq at 0, reuses batch ids over the
 * top of real receipts, and republishes the cumulative totals as zeros. A missing file is a fresh
 * keeper; a corrupt one is a stop-and-look-at-it.
 */
function readLedgerJson(p, fallback) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch (e) { if (e && e.code === 'ENOENT') return fallback; throw e; }
  try { return JSON.parse(raw); }
  catch (e) {
    throw new Error(`${path.basename(p)} is corrupt (${(e && e.message) || e}) — refusing to read it as an empty ledger. Restore it or move it aside deliberately.`);
  }
}

// temp + rename, so a crash or a full disk mid-write cannot leave a half-written ledger behind.
// {mkdir:true} creates the file's OWN directory first: a sink that files one document per batch
// under state/donations/ used to re-implement this whole function purely to get the mkdirSync.
function writeJson(p, obj, opts) {
  ensureDir();
  if (opts && opts.mkdir) {
    const d = path.dirname(p);
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(obj, null, 2));
  fs.renameSync(`${p}.tmp`, p);
}

module.exports = { ensureDir, readJson, readLedgerJson, writeJson, outDir };
