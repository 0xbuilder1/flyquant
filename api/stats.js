/**
 * The site's window onto the keeper.
 *
 * The keeper runs on a machine somewhere and writes stats.json every pass. The page needs that file
 * from a URL that changes every few minutes, so committing and redeploying is not an option: the
 * keeper uploads it to Vercel Blob and this hands the browser whatever is there now.
 *
 * TWO WAYS IN, BECAUSE BLOB STORES COME BOTH WAYS.
 *
 *   PRIVATE STORE (the default for a store created today, and what this project uses). The blob has
 *   no publicly fetchable URL at all — a browser cannot read it and neither can a plain proxy. This
 *   function reads it BY PATHNAME with the store's own token, which it already has because Vercel
 *   injects BLOB_READ_WRITE_TOKEN into every project the store is connected to. Nothing needs
 *   configuring, and the token never leaves the server.
 *
 *   PUBLIC STORE. Set FLY_STATS_URL to the blob's public URL and this proxies that instead. Kept
 *   because a public store is a legitimate setup and the URL form is one fewer moving part.
 *
 * IT IS A PROXY EITHER WAY rather than a redirect, so the page fetches same-origin and never has to
 * care where the blob lives, and a missing blob degrades to the committed snapshot instead of a CORS
 * error nobody can read.
 */
const BLOB = process.env.FLY_STATS_URL || '';
const PATHNAME = process.env.PONS_BLOB_PATH || 'stats.json';

module.exports = async (req, res) => {
  res.setHeader('cache-control', 'no-store');

  // ── a public store, addressed by URL ────────────────────────────────────────────────────────
  if (BLOB) {
    try {
      const r = await fetch(`${BLOB}${BLOB.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) { res.status(502).json({ error: `blob returned ${r.status}` }); return; }
      res.setHeader('content-type', 'application/json');
      res.status(200).send(await r.text());
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) });
    }
    return;
  }

  // ── a private store, addressed by pathname ──────────────────────────────────────────────────
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    res.status(503).json({
      error: 'no blob configured — set BLOB_READ_WRITE_TOKEN (private store) or FLY_STATS_URL (public)',
    });
    return;
  }
  try {
    const { get } = require('@vercel/blob');
    // useCache false on purpose: the whole point is the file that was written a minute ago, and a
    // CDN copy of the previous pass is worse than no answer because it looks live.
    const found = await get(PATHNAME, { access: 'private', useCache: false });
    if (!found) { res.status(404).json({ error: `${PATHNAME} is not in the store yet — has the keeper run?` }); return; }
    const body = Buffer.from(await new Response(found.stream).arrayBuffer());
    res.setHeader('content-type', 'application/json');
    res.status(200).send(body);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
};
