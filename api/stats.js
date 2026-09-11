/**
 * The site's window onto the keeper.
 *
 * The keeper runs on a machine somewhere and writes stats.json every pass. The page needs that file
 * from a public URL that changes every few minutes, so committing and redeploying is not an option:
 * the keeper uploads to Vercel Blob and this hands the browser whatever is there now.
 *
 * It is a PROXY rather than a redirect so the page can fetch it same-origin and never has to care
 * where the blob lives, and so a missing blob degrades to the committed snapshot instead of a CORS
 * error nobody can read.
 */
const BLOB = process.env.FLY_STATS_URL || '';

module.exports = async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  if (!BLOB) {
    res.status(503).json({ error: 'FLY_STATS_URL is not set — the site has no keeper to read' });
    return;
  }
  try {
    const r = await fetch(`${BLOB}${BLOB.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) { res.status(502).json({ error: `blob returned ${r.status}` }); return; }
    res.setHeader('content-type', 'application/json');
    res.status(200).send(await r.text());
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
};
