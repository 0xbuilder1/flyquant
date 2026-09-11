/**
 * @pons/core/lib — a chunked, windowed log reader with one backoff per chunk.
 *
 * Offered, never demanded. findLaunch and a holder sink's scan() were two hand-rolled copies of this
 * same loop in one file, differing only in direction and in whether they went through viem.
 *
 * `raw: true` issues eth_getLogs directly, which is MANDATORY when you filter on topics yourself:
 * viem's getLogs builds its topic filter from an event ABI and IGNORES a topics array passed
 * alongside it, so a hand-built filter is silently dropped and you get every log on the address.
 */
'use strict';

const { sleep } = require('../fmt.js');

/**
 * @param {object} client   a chain client from ctx.clients
 * @param {object} o
 *   address, fromBlock, toBlock (bigint), span (bigint), backoffMs,
 *   event | topics, raw, onChunk(logs, from, to), backwards, onError(e, from, to)
 * @returns {Promise<Array>} every log, in the order the chunks were read
 */
async function scanLogs(client, o) {
  const span = BigInt(o.span || 40000n);
  const backoff = Number(o.backoffMs != null ? o.backoffMs : 1200);
  const out = [];

  const read = async (from, to) => {
    if (o.raw || o.topics) {
      return client.request({
        method: 'eth_getLogs',
        params: [Object.assign({
          fromBlock: '0x' + from.toString(16),
          toBlock: '0x' + to.toString(16),
        }, o.address ? { address: o.address } : {}, o.topics ? { topics: o.topics } : {})],
      });
    }
    return client.getLogs({ address: o.address, event: o.event, fromBlock: from, toBlock: to });
  };

  const windows = [];
  if (o.backwards) {
    for (let to = BigInt(o.toBlock); to > BigInt(o.fromBlock);) {
      const from = to - span + 1n > BigInt(o.fromBlock) ? to - span + 1n : BigInt(o.fromBlock);
      windows.push([from, to]);
      if (from === BigInt(o.fromBlock)) break;
      to = from - 1n;
    }
  } else {
    for (let from = BigInt(o.fromBlock); from <= BigInt(o.toBlock); from += span) {
      const to = from + span - 1n > BigInt(o.toBlock) ? BigInt(o.toBlock) : from + span - 1n;
      windows.push([from, to]);
    }
  }

  for (const [from, to] of windows) {
    let logs = [];
    try {
      logs = await read(from, to);
    } catch (e) {
      // a per-IP rate limit is the common one: back off and retry the SAME chunk once, so a
      // throttled node costs a pause rather than a hole in the history
      await sleep(backoff);
      try { logs = await read(from, to); }
      catch (e2) { if (o.onError) o.onError(e2, from, to); logs = []; }
    }
    out.push(...logs);
    if (o.onChunk && o.onChunk(logs, from, to) === false) break;
  }
  return out;
}

module.exports = { scanLogs };
