/**
 * @pons/core/lib — nonce reservation.
 *
 * Offered, never demanded. Read ONCE, and persist the numbers before anything is signed: a crash
 * after transfer 2 must not let the next run re-derive nonces from a chain that has only seen two
 * and sign a DIFFERENT transaction on n0+2.
 *
 * `pending`, not `latest`: the count has to include what this keeper has already broadcast and is
 * waiting on, or the first reserved nonce collides with a transaction of our own.
 */
'use strict';

async function reserve(client, address, n) {
  const first = Number(await client.getTransactionCount({ address, blockTag: 'pending' }));
  const out = [];
  for (let i = 0; i < n; i++) out.push(first + i);
  return { first, nonces: out };
}

module.exports = { reserve };
