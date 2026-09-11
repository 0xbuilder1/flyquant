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

## Sizing — the fly sets a target, the trader reconciles

*Added 2026-09-11, when the trader stopped being a plan.*

The readout returns a direction and a conviction in [0,1]. That conviction times equity times the
operator's risk budget is the notional the account SHOULD hold in the market the fly turned toward.
What it actually holds is read from Lighter. **The difference is the order, and nothing else decides
a size.**

Three properties fall out of that subtraction and not one of them needed a special case:

- **It adds to positions as capital arrives.** The target is a fraction of equity, so a deposit — or
  a harvest landing, or an open position gaining — raises it, and the next pass buys the difference.
  Growth compounds into size without a line of code about deposits.
- **It trims when capital leaves**, by the same subtraction with the sign reversed.
- **It flips in one order through zero**, because a signed target minus a signed position is a
  signed delta.

**CONVICTION IS A NORMALISED DIFFERENCE, AND THE FIRST VERSION WAS AN ARTEFACT.** It divided the
MN9−MDN gap by `MAX_HZ`, the refractory ceiling of 454 Hz. No neuron in this network goes near that;
MN9 runs at 12–22. So every position came out at 2–5% of equity — a number that looked like a
judgement and was actually a denominator. `(winner − loser) / (winner + loser)` spans the range with
no constant: one channel firing alone is total conviction, two firing equally is none.

**WHAT TOTAL CONVICTION IS WORTH IS THE OPERATOR'S, NOT THE FLY'S.** `trade.exposure.maxFraction` is
the single number in this product that is a policy rather than a measurement, and it lives in config
for exactly that reason. At 1.0 there is no leverage at any setting below it. This is the boundary
the whole design rests on: **a brain parameter may never be tuned for returns, and a position limit
is nothing but.**

**THE MINIMUM TRADE IS THE EXCHANGE'S, NOT OURS.** Lighter publishes `min_quote_amount` and
`min_base_amount` per market. A delta below either is refused, never rounded up, and size rounds
DOWN to the market's precision — rounding up would overshoot the target on every pass and ratchet
exposure upward. A consequence worth stating rather than hiding: **trade frequency is bound by
capital.** At a 0.25 budget an account needs roughly $40 to open at all and a few hundred before
incremental adds clear a $10 minimum regularly. There is no setting that makes a small account trade
often, and inventing one would mean overriding the exchange's own limits.

## What the fly decides, and what the operator only bounds

*Added 2026-09-11.* The fly chose a direction, a market and a conviction; how much money any of that
was worth was a constant in a config file. That was the operator making the trade and the fly
pointing at it.

MaleCNS types the neuromodulators, and two of them are a genuine opposing behavioural axis:
**octopamine** (101 neurons) is the invertebrate noradrenaline -- arousal, flight initiation,
aggression, raised responsiveness; **serotonin** (48) is the other way -- quiescence, satiety,
persistence over urgency. Both fire during a pass: measured live at 39.7Hz against 9.9Hz.

So the balance between them is read directly, and it needs no constant:

    appetite = OA / (OA + 5HT)      how much of the allowance to take
    patience = 1 - appetite         how far behind the touch to rest

**Appetite replaces the operator's number as the SIZE.** `maxFraction` became a ceiling the fly moves
inside: a convinced but unaroused fly takes a small position, a convinced and flooded one takes the
whole allowance, and zero arousal takes nothing at all. **Patience sets the price**: a calm fly rests
further behind the touch for a better fill it may never get; an aroused one sits at the touch and
takes what is there. The unit is the spread itself, so again nothing was chosen.

**DOPAMINE IS READ AND DELIBERATELY NOT ACTED ON.** 392 neurons, firing at ~19Hz. In this animal it
is the mushroom body's teaching signal -- it is what learning would be made of. This fly does not
learn, so there is nothing for it to teach, and wiring it to a position size would be borrowing the
word "reward" for something that is not one. It is published so its silence is visible.

## Losses should be directional, not executional

*Added 2026-09-11.* Lighter charges **zero maker fee and zero taker fee**, so the entire cost of
trading here is the spread — and the spread is only paid by whoever crosses it.

**AN OPENING ORDER RESTS POST-ONLY AT THE TOUCH.** A buy joins the bid; a sell joins the ask; never
inside, because inside the touch is a worse price and buys nothing but queue position. Post-only is
rejected by the exchange if it would cross, which is the guarantee that matters: **the order fills at
the price we named or it does not fill.** Slippage becomes zero by construction rather than small by
assumption.

Measured spreads on 2026-09-11: BTC 0.5bp, SPY 0.3bp, ETH 1.7bp — and PONS 13.6bp, USAR 20.2bp. So
crossing costs almost nothing on the liquid markets and a great deal on exactly the thin ones the
fly is most drawn to.

**WHAT IS PAID INSTEAD IS ADVERSE SELECTION**, and it is not free. A resting bid fills precisely when
the market is coming down onto it, so the fills you get are selected against you. That is a real
cost — but it is a *directional* one, which is the trade being made here deliberately: if the fly
loses money it should be because it was wrong about direction, not because of how the order reached
the book.

**AN ESCAPE CROSSES ANYWAY.** The fly is fleeing, and an order that might not fill is not an exit.
It pays half the spread once and gets certainty, which is the whole point of the behaviour.

**UNFILLED ORDERS EXPIRE; NOTHING CANCELS THEM.** Each post-only order carries an expiry a little
shorter than the gap between passes. Nothing tracks open orders, because the reconciler is
state-based: the next pass reads the account, sees what actually filled, and computes the difference
from there. Partial fills, no fills and full fills all take the same path, and the entire class of
bugs where the keeper's idea of its open orders drifts from the exchange's simply does not exist.

**THE DEADBAND NOW APPLIES ONLY TO ORDERS THAT CROSS.** It existed to stop the fly paying the spread
repeatedly on noise. A resting order pays no spread, so there is nothing to protect it from, and
blocking it would be the keeper overriding the fly for no benefit — the fly gets its full resolution
back. Oscillation on resting orders is not churn: buying at the bid and selling at the ask is a
market maker's entire business.

**What this costs the fly is certainty of execution.** Its control over *intent* is now total; its
control over *fills* is not. Fill rate becomes the number to watch, and a market too thin to fill a
resting order is a market the fly will simply not end up in.

**THREE SEATBELTS, INDEPENDENT.** `--broadcast` on the command, `trade.armed` in the config, and a
maximum notional enforced inside the signing process itself — so a bug in the sizing cannot spend
more than the operator armed, whatever the keeper believes. The signer is a separate Python process
because Lighter signs with a compiled library loaded through ctypes and there is no pure-JS path; it
holds the key, exposes one verb, and is the only thing in the repo that can lose money.

**THE DEPOSIT LEG IS BLOCKED AND THAT IS THE FINISHED STATE, NOT AN UNFINISHED ONE.** Fees reach the
fee wallet as native ETH; getting them to Lighter means wrapping, swapping to USDG on the 1bp v3
pool, and depositing as margin. The deposit contract address on 4663 has not been read from an
official source. A wrong deposit address is a total loss rather than a retry, so `spentRaw()` returns
`0n` — honestly, because nothing has left — and the sink accumulates and reports until
`fly.deposit.address` and `fly.deposit.verifiedBy` are both set.

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
