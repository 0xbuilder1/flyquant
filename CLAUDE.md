# Working in this repo

Read `DESIGN.md` first. It is the derivation and the boundary; this file is the short list of rules
that are not obvious from the code, and every one of them was paid for by something that went wrong.

## The one rule above all others

**NO CONSTANT IN `brain/params.js`, `brain/senses.js` OR `brain/arena.js` MAY BE TUNED TO IMPROVE
TRADING.** The moment a time constant is chosen because it made the fly more profitable, this stops
being a fly and becomes a trading bot wearing one, and every sentence on the site becomes a lie.

`params.js` values are Shiu et al.'s verbatim; changing one requires a citation for the new value in
the commit that changes it. `senses.js` and `arena.js` are built out of naturally-bounded fractions
precisely so there is nowhere to put a gain.

**The exception, and it is the only one:** `trade.exposure.maxFraction` in the config. The fly
returns conviction in [0,1]; what that conviction is worth in money is the operator's risk budget,
not a property of the animal. That is why it lives in config and not in `brain/`.

## Things that cost a day to learn

**Enter the arena at the MEDULLA, never the lamina.** Stimulating L1/L2/L3/L5 does nothing at the
escape pathway, because `Mi1 <- L1` is 141,873 synapses at sign **negative** — L1 is glutamatergic
and photoreceptors are histaminergic and inhibit it, so injecting current into L1 is showing the fly
*darkness*. Tm1/Tm2/Tm4/Tm9/Tm20 are retinotopic and are LC4's own excitatory inputs, and from there
the looming selectivity is the connectome's own: an expanding patch fires LPLC2 5.7× harder than a
**bigger** static one. `brain/probe-arena.js` is that experiment; run it after any graph change.

**Do not add every columnar type to the arena input.** It raises absolute firing and destroys the
selectivity — static-large and looming converge. The five-type Tm set is chosen because it is
*selective*, which is the entire point.

**Escape reads LPLC2, not DNp01.** The giant fiber never leaves noise on synthetic retinotopic input.
It is still published, so anyone can watch it not matter.

**Vision says WHICH, chemistry says GOOD OR BAD.** An arena that drives everything through the optic
lobe leaves MN9 — a proboscis motor neuron — with nothing to fire from. A fly does not extend its
proboscis because it saw something across the room.

**The neuron universe is the ANNOTATED bodies, not every body in the weights file.** Most bodies are
unproofread fragments and glia; taking all of them gives 1.44M "neurons", nine times the animal.

**Histamine is inhibitory in Drosophila.** Leaving it out of the sign table does not throw. It
silently blinds the fly.

## Money rules

**THREE SEATBELTS, AND THEY ARE INDEPENDENT.** `--broadcast` on the command, `trade.armed` in the
config, and a maximum notional enforced inside the signing process itself so a bug in the sizing
cannot spend more than the operator armed, whatever the keeper believes.

**The sizing is a pure module and it stays that way.** `trader/position.js` has no network, no key
and no clock, which is why `trader/test-position.js` can prove it with no account. A funded account
is needed to place an order; it is not needed to prove the order would be the right size.

**The feed records refusals too.** A feed that only shows the orders that went through is a
highlight reel.

**Never invent an address on the money path.** The Lighter deposit contract on 4663 is unverified
even in the reference material, so the sink spends nothing and says so. A wrong deposit address is a
total loss, not a retry.

**No key in a config file, ever.** `LIGHTER_API_KEY` (Lighter-native, not EVM) is read by
`trader/signer.py` and by nothing else. `PRIVATE_KEY` is the PONS fee wallet and is read by `core/`.

**`core/` is copied verbatim from the framework and is never edited.** If you find yourself wanting
to change it, the design is wrong — add something to the sink's `declare()` instead.

## The site

One writer, one file. The keeper publishes `stats.json`, `activity.bin` and the static point cloud;
the page reads those and nothing else. The site cannot show a number the keeper did not publish, and
a page that can compute its own figures will eventually compute a flattering one.

When you change a number the page prints, change what produces it in the same commit. The page makes
four claims a human has to keep true: that this is a wiring diagram and not a mind; that the fly has
not learned anything; that escape reads LPLC2 and DNp01 sits at noise; and that nothing is trading.

## Before you finish

```bash
npm test                     # the brain suite and the money suite
node brain/probe-arena.js    # only if you touched the graph or the arena
node fly.js                  # one live dry pass, end to end
npm run preflight            # the PONS side
```

A pass costs roughly 25× its fly time in CPU, so `--ms 250` is the fast loop and `--ms 600` is the
one to judge behaviour on.

## Conventions

- Node 18+, CommonJS, `viem` as the only runtime dependency. Python only in `build-graph.py` and the
  signer, and for opposite reasons: Arrow in one, a ctypes `.dll` in the other.
- Comments explain **why**, especially where a fly fact or a chain quirk forced a choice.
- Windows is a first-class dev target.
