/**
 * @pons/core/lib — {symbol, decimals, totalSupplyRaw}, cached per pass.
 *
 * Offered, never demanded. Preflight already reads all three and throws the supply away; a sink that
 * weights by supply reads it again every pass, and a sink whose out-asset is a token needs the
 * decimals to render a figure that is not off by twelve orders of magnitude.
 */
'use strict';

const { erc20Abi } = require('../abis.js');

function tokenFacts(client) {
  const cache = new Map();
  return {
    async of(address) {
      const k = String(address).toLowerCase();
      if (cache.has(k)) return cache.get(k);
      const [symbol, decimals, totalSupplyRaw] = await Promise.all([
        client.readContract({ address, abi: erc20Abi, functionName: 'symbol' }).catch(() => null),
        client.readContract({ address, abi: erc20Abi, functionName: 'decimals' }).catch(() => null),
        client.readContract({ address, abi: erc20Abi, functionName: 'totalSupply' }).catch(() => null),
      ]);
      const facts = { address, symbol, decimals: decimals == null ? null : Number(decimals), totalSupplyRaw };
      cache.set(k, facts);
      return facts;
    },
    /** a pass is the cache's lifetime: supply and balances move, and a stale supply is a wrong rule */
    clear() { cache.clear(); },
  };
}

module.exports = { tokenFacts };
