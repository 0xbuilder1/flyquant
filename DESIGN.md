# The fly — mechanism

A fruit fly's central nervous system, wired exactly as it was reconstructed from a real animal,
with a wallet on Robinhood Chain. Market data goes in as smells. Spikes come out of descending
neurons. Some of those spikes buy memecoins.

This document is the derivation and the boundary. Read it before touching `brain/` or `trader/`.
The short version of the boundary: **the wiring is not ours and we may not edit it, the money is
fee-funded and may never touch operator float, and every claim the site makes about the brain has
to be checkable by someone who downloads the same dataset.**

## What this is, and what it is not

It **is** the complete connectome of an adult male *Drosophila melanogaster* central nervous system
— MaleCNS v1.0, released 2026-09-03 by Janelia's FlyEM team, the Cambridge Drosophila Connectomics
Group and Google's Connectomics group. 166k neurons, ~125M synapses, CC BY. Every neuron the fly
fires is a real cell from a real animal with a real body ID you can look up in neuPrint.

It is **not** a living brain, it is **not** conscious, and it does **not** know what money is. It is
a wiring diagram plus a differential equation. Skeptics saying so are correct and the site must say
so too, in its own voice, above the fold. A memecoin that overstates what its keeper does is the
failure mode of the entire category, and this one has an unusually tempting thing to overstate.

**It also does not learn.** See "Deliberately open" — that is the one live question in the design,
not a thing to quietly resolve while writing code.

## The brain

`brain/build-graph.py` is run once. It reads three MaleCNS files and writes one binary the keeper
memory-maps:

```
connectome-weights.feather   1.1 GB   body_pre, body_post, synapse count
body-neurotransmitters.feather 42 MB  per-neuron predicted transmitter
body-annotations.feather      13 MB   type, class, superclass, soma side
```

**Edges below 5 synapses are dropped.** This is the standard cut in the connectome literature, not
a convenience: single-synapse partners are where reconstruction error concentrates, and keeping them
triples the edge count to buy noise. The count that survives goes in `graph.json` and the site
publishes it. Whatever it turns out to be, the site prints THAT number and not a rounder one.

The dynamics are leaky integrate-and-fire, following Shiu et al. (2024), which is the published
model for exactly this dataset's predecessor:

- weight of an edge = its **raw synapse count**, never a tuned parameter;
- sign = the **predicted neurotransmitter** of the presynaptic cell — acetylcholine excitatory,
  GABA and glutamate inhibitory, the aminergics treated as excitatory;
- α-synapse dynamics, one membrane time constant, one refractory period, one threshold, all of them
  the published values and all of them in `brain/params.js` where they can be read at a glance.

**NO PARAMETER IN `params.js` MAY BE TUNED TO IMPROVE TRADING.** The moment a time constant is
chosen because it made the fly more profitable, this stops being a fly and becomes a trading bot
wearing one, and every sentence on the site becomes a lie. If the fly trades badly with the
published constants, it trades badly — that is the result. Changing a constant requires a citation
for the new value, in the commit.

**The simulation is deterministic and seeded.** Same market input, same seed, same spikes, to the
bit. This is what makes a trade checkable rather than merely asserted: the keeper records the input
vector and the seed alongside every fill, and anyone who downloads MaleCNS can replay it and get the
same neurons. It is the same standard as the mark — *checkable by anyone against the same data* —
and it is the reason no random jitter may be added anywhere in the loop.

## The senses

The market reaches the brain as **odour**, injected as current into olfactory sensory neurons by
glomerulus. MaleCNS types 2,639 of them, and the innate valence of specific glomeruli is published
science rather than something we invented.

| channel | neurons | what the fly is smelling | what we inject |
|---|---|---|---|
| `ORN_DM1`, `ORN_VM2` | ~74, ~50 | food odour, innately attractive | buy-side flow |
| `ORN_DA2` | ~50 | **geosmin** — the hardwired "this is toxic" channel | rug signals |
| `ORN_DA1` | ~204 | cVA pheromone — other flies are here | swap count, crowd |
| `LC4` + `LPLC2` | 126 + 185 | an object looming at the eye | price falling, scaled by speed |

**A CHANNEL MAY ONLY CARRY A SIGNAL WHOSE PUBLISHED INNATE VALENCE MATCHES ITS SIGN.** Geosmin
drives avoidance in a fly that has never smelled it before; that is why it can carry a rug signal.
Wiring a rug signal into the food channel would produce a fly that buys rugs, and it would be *our*
fly doing it, not a fly. Every row in that table needs a citation in `brain/senses.js` and the
honesty guard asserts the site's table matches the code's.

Looming is the one that is not a metaphor at all. LC4 and LPLC2 are visual projection neurons that
respond to expansion, they converge on the giant fiber, and the fly escapes. A price collapsing is
an expanding object. The mapping from "rate of price decrease" to "angular size over time" is in
`senses.js`, it is a formula and not a lookup table, and it is the only place a price touches a
neuron.

## The readout

MaleCNS types **480 distinct descending neurons** — the entire output channel from brain to body.
The keeper reads a handful, and the handful is fixed before any of it is armed:

- **DNp01**, the giant fiber, ×2 — the escape reflex. Fires → **sell the whole position, now.**
- **DNp09** ×2 — freezing/stopping. Fires → hold, take no action this pass.
- **DNa02** ×2 — steering. Its left/right imbalance selects *which* listed coin the pass is about.
- a food-approach descending population — sustained firing → **buy**, size from rate.

Intent is a function of spike *rate over a window*, never of a single spike, because a single spike
in a 166k-neuron network is noise and a rate is a decision. The window is in `params.js`.

## The money

The fly trades **harvested creator fees and nothing else**. $FLY launches on PONS with the fee
recipient set at launch; `core/harvest.js` claims from the escrow exactly as it does for every other
token in the family; the proceeds become the fly's book.

**THE CEILING IS NET OUTFLOW, NOT GROSS SPEND.** `core/ceiling.js` says a batch may never move more
than the escrow actually paid us, and that is still the rule — but a trader recycles. So
`spentRaw()` returns **ETH out on buys minus ETH back from sells**, and the ceiling tests that net
against fees claimed. The fly can therefore trade the same ether repeatedly and can lose, at most,
every wei of fees it was ever given — and not one wei more. That bound is the product's only real
promise about risk and it is arithmetic, not a policy.

**TWO POTS, NEVER ONE.** `float` is the operator's gas money and is not fee revenue; `book` is the
fee-funded trading capital. The fly may never spend float, exactly as the desk may never pay a
winner out of a punter's stake. `audit()` closes the equality off-chain every pass and halts on a
mismatch. Never rewrite the ledger to match the balance.

**A BAG IS NOT MONEY.** The fly's token holdings are marked for the site and for nothing else. Size
is computed from ether actually spent and ether actually returned — never from the marked value of
the bag, because a pumped bag would otherwise let the fly size up on gains it cannot realise, and
memecoin marks are exactly the marks that cannot be realised. This is the tumble display-only
amendment applied to a second product: *wrong for a minute on a banner is survivable, wrong on a
size is somebody's money.*

## The venue

**Lighter, on Robinhood Chain, across its whole universe.** `https://api.rh.lighter.xyz`, 57 perp
markets: PONS and LIT, the crypto majors, US equities and the index ETFs, metals and oil, and the
private-company perps including ANTHROPIC and OPENAI.

*Amended 2026-09-11, replacing Uniswap V4 memecoin swaps, and the reasons are worth keeping because
two of them reverse an earlier decision.*

**Fees.** The PONS perp reports `taker_fee: 0.0000` and `maker_fee: 0.0000`. The V4 path this
replaces cost ~1% curve fee plus a 2% creator tax — about 3% a side and 6% a round trip. A fly that
re-decides every pass off a firing rate would have been destroyed by its own churn, and that was not
priced into the original plan.

**The fly can be short.** This is the bigger reason. On a spot memecoin the fly could only buy or
panic, MDN and DNp09 never fired in any scenario, and there was no way to take profit that was not a
rule invented by us. A two-sided market gives backward walking somewhere to go, and closes that gap
as biology rather than as policy.

**More to smell.** `orderBookDetails` gives mark, index, open interest, daily volume and range;
`funding-rates` gives funding; `orderBookOrders` gives depth either side of mid. Against a V4 pool,
where the only honest reads are `slot0` and liquidity.

What it costs, recorded so nobody rediscovers it as a surprise:

- **No memecoins.** ANSEM and CASHCAT aside, this universe is equities, metals, majors and PONS.
  The memecoin half of the product now lives entirely in $FLY itself, which still launches on PONS.
- **The mark is an API and the positions are off-chain.** The no-price-feed invariant does not
  survive this, the way it did not survive Pyth on the perp desk. Say so on the page rather than
  keeping a sentence that stopped being true.
- **Signing needs a compiled native library.** Lighter's signer is a `.dll` loaded through `ctypes`;
  there is no pure-JS path. `trader/signer.py` owns the library and the API key and exposes exactly
  one verb — place this order. The Node keeper keeps the loop, the ledger, the ceiling and the
  honesty guard. That is the smallest surface that has to touch a key, and the framework's proven
  safety code does not get reimplemented in a second language to suit a signing detail.
- **Leverage kills flies.** PONS caps at ~3x (`min_initial_margin_fraction: 3333`) with a 20%
  maintenance fraction, and it ranged 0.529 to 0.655 in one day. Position sizing has to bound
  liquidation distance, not just notional.

## The arena

A fly has ONE brain. 57 markets is not 57 flies, and running the simulation once per market would be
both 57x the cost and a lie about what the animal is.

So the fly sits in **a tethered flight arena** — the standard *Drosophila* paradigm, fifty years
old: you place stimuli at azimuths around a fixed animal and read which way it tries to turn. Every
market gets a fixed seat, assigned once and never moved, and all 57 are present in the visual field
at the same time in a single pass. **DNa02's left-right imbalance is what picks one.**

MaleCNS makes this literal rather than metaphorical: it assigns every columnar optic-lobe neuron a
retinotopic hex coordinate (hex1 1-36, hex2 1-39, per eye), giving **1,769 addressable columns and
36 azimuth bands per eye — 72 seats for 57 markets.**

**WE ENTER AT THE MEDULLA, NOT THE LAMINA, AND THE REASON IS NOT COSMETIC.** Two probes, both in
`brain/probe-arena.js`, and the negative one matters more:

1. Stimulating the lamina (L1/L2/L3/L5) produces **nothing** at the escape pathway. The graph says
   why: `Mi1 <- L1` is 141,873 synapses at sign **negative**, because L1 is glutamatergic and the
   model's coarse glutamate-is-inhibitory rule applies. That rule is *right* here — photoreceptors
   are histaminergic and inhibit L1, so light means LESS L1 activity. Injecting current into L1 is
   showing the fly darkness. The stimulus was wrong, not the model.
2. Entering one layer later at the medulla — **Tm1/Tm2/Tm4/Tm9/Tm20**, which are retinotopic and are
   LC4's own excitatory inputs — works, and the selectivity is emergent: an expanding patch fires
   **LPLC2 34 times against 6 for a BIGGER static patch, 5.7x.** We never told it anything was
   looming. It computed that from a patch of columns.

**The escape readout therefore reads LPLC2, not DNp01.** The giant fiber does not rise above noise
(3 to 7 spikes) on synthetic retinotopic input, and pretending otherwise would mean reporting a
number that is not a signal. LPLC2 is the published looming-sensitive escape driver one synapse
upstream, and it is where the signal actually is. The all-or-none rule moves with it, but it is now
a population threshold rather than a single spike, and the site must say which.

## What the site may claim

The honesty guard (`core/claims.js` + `trader/claims.js`) fails the build when the page and the code
disagree. For this product the rows that matter are:

1. the neuron and edge counts the page prints == what `graph.json` says was built;
2. the channel table on the page == the channel table in `senses.js`, glomerulus by glomerulus;
3. the descending neurons the page names == the ones `readout.js` actually reads;
4. every parameter the page quotes == the value in `params.js`, not a rounded version of it;
5. "fee-funded" — the page may say the fly trades fees only while and only while `spentRaw()` is
   net of sells and the ceiling gates it.

And one prose row with no number in it, which the guard cannot check and a human must: the page says
it is a wiring diagram and not a mind. If that sentence ever leaves the page, the project is
something else.

## Deliberately open

**Whether the fly learns.** As built it cannot: a connectome is one frozen snapshot of synaptic
weights, so the fly is a reflex machine whose behaviour is a pure function of the market in front of
it. The alternative is real and is real fly biology — the mushroom body learns odours by depressing
KC→MBON synapses under dopamine, MaleCNS types ~4,000 Kenyon cells, the MBONs and the PAM/PPL
dopaminergic clusters, and realised P&L is a reinforcement signal of exactly the shape those
circuits take. That would make the fly learn which coins have hurt it.

It also means the weights stop being the published ones. Both versions are honest; only one of them
is honest *by default*, and the other needs the page to say plainly which synapses move and why.
**Not a decision to make in a commit message.** The hooks are in place; the rule is not enabled.

**Which coins are listed**, and by whom. A fly that can only smell four coins is a fly whose
operator chose its opportunity set, and the page should say who chose.

**What happens to trading profit,** if there is any. Nothing is decided. The precedent from the perp
desk is 50% buyback-and-burn / 50% retained, and the capacity argument that produced that split
applies here too — but there the retained half is a solvency requirement, and here it is not.
