/**
 * @pons/core — every chain client in the process is built here, and nowhere else.
 *
 * A sink may never construct one. verifyLeg in the charity sink once built its own with an inline
 * createPublicClient, which made it the only network path in that module a fake chain could not
 * intercept — and therefore the only one with no test behind it. The clients are built ONCE at
 * composition and never replaced: the fake-chain suites fake a chain by assigning over the methods
 * of these exact objects, so a core that rebuilt a client per pass would silently disarm every money
 * test in the repo.
 */
'use strict';

const { createPublicClient, createWalletClient, http, defineChain } = require('viem');
const cfg = require('./config.js').current();

const sourceChain = defineChain({
  id: cfg.chain.id, name: cfg.chain.name,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [cfg.chain.rpc] } },
});

/**
 * Any chain a sink declares, built exactly the way the source chain is.
 *
 * The placeholder rpcUrls entry is load-bearing. viem's http('') falls back to
 * chain.rpcUrls.default, and an empty default array throws at request time — so with the
 * placeholder a keeper whose declared rpc is unset still CONSTRUCTS a client the tests can patch,
 * and a real call fails as a connection error rather than as a viem type error.
 */
function makePublicClient(spec) {
  const chain = defineChain({
    id: Number(spec.chainId), name: spec.label || 'chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [spec.rpc || 'http://127.0.0.1:0'] } },
  });
  return createPublicClient({ chain, transport: http(spec.rpc || undefined) });
}

const source = makePublicClient({ chainId: cfg.chain.id, label: cfg.chain.name, rpc: cfg.chain.rpc });

function makeWalletClient(account) {
  return createWalletClient({ account, chain: sourceChain, transport: http(cfg.chain.rpc) });
}

module.exports = { sourceChain, source, makePublicClient, makeWalletClient };
