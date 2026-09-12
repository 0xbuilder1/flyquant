# flyquant

**A complete fruit fly connectome, trading a funded account with real money.**

165,836 reconstructed neurons of an adult *Drosophila melanogaster* — MaleCNS v1.0, Janelia FlyEM /
Cambridge Drosophila Connectomics Group / Google, CC BY 4.0 — simulated as a leaky integrate-and-fire
network on published constants, sitting in a flight arena with live perpetual futures markets
arranged around it. It turns toward one. Its motor neurons decide what to do about it. That becomes a
target position, and the trader reconciles a real [Lighter](https://lighter.xyz) account to it.

It is live. It holds **$10,000**, trades up to twelve positions at 5× leverage, and every fill is on
chain. The account index is published on the site so anyone can read its book on the exchange's own
explorer without trusting a word here.

It is trying to make **$1,000,000**. It will probably fail. That is not the interesting part.

---

## What makes this different from a trading bot

**Nothing in it is tuned to make money, and it cannot be.**

The membrane and synaptic constants are Shiu et al. (2024), used verbatim. The first rule in
`CLAUDE.md` is that changing one because it improved returns is forbidden — the moment a time
constant is fitted to a P&L curve this stops being a fly and becomes a bot in a costume. The
neurotransmitter signs are the dataset's. The escape pathway's selectivity is the connectome's own.
Every sensory channel is a **rank among the markets**, which is precisely why there is no gain
anywhere to adjust.

So what is running is a question that could not be asked until complete brain wiring existed: give a
real animal's nervous system a real economic environment and real consequences, and see what it does.

---

## How it decides

### The arena

A tethered fly in a flight simulator is one of the oldest paradigms in neuroscience, and MaleCNS
makes it literal: every columnar optic-lobe neuron carries a retinotopic hex coordinate, giving
**1,771 addressable columns across 72 azimuth bands**. Markets are seated around the fly by
`marketId` — arbitrary but fixed and published, because seating by anything meaningful would make the
fly's choice partly ours.

Each market is a patch of light whose brightness is its volume rank. A **falling** market *expands*
across the pass, because to a visual system a collapse and a looming predator are the same event: an
object getting bigger.

Two things had to be right here and both cost a day:

**Stimulation enters at the medulla, never the lamina.** Injecting current into L1 produces nothing
at the escape pathway, because `Mi1 ← L1` is 141,873 synapses at sign *negative* — L1 is
glutamatergic, photoreceptors are histaminergic and inhibit it, so driving L1 shows the fly
*darkness*. Enter at Tm1/Tm2/Tm4/Tm9/Tm20 and the looming selectivity falls out of the wiring for
free: an expanding patch drives LPLC2 **5.7× harder** than a bigger static one. `brain/probe-arena.js`
is that experiment.

**The turn is the whole descending population.** Steering was originally read off DNa02 — two
neurons, a handful of spikes, an imbalance that turned out to be noise, and a fly that picked the same
market 41 times out of 41. It is now the left–right asymmetry across all **1,314 descending neurons**
(656 left, 648 right), normalised by what actually fired.

### Six senses

Vision says *which* market. It says nothing about whether that market is any good, and a fly does not
extend its proboscis because it saw something across the room. So everything else the animal has is
wired to something the exchange publishes — and a channel may only carry a signal whose **published
innate valence matches its own**:

| channel | organ | carries | why that organ |
|---|---|---|---|
| food | ORN_DM1, ORN_VM2 | ground gained since the last pass | the cider-vinegar glomeruli; innately appetitive |
| geosmin | ORN_DA2 | mark against index | the one smell a fly is born fleeing; overrides attractive odours |
| cVA | ORN_DA1 | open interest | reports that *other flies are here*, nothing about whether they are right |
| wind | Johnston's organ | order book imbalance | anemotaxis — a fly walks into wind |
| heat | TRN_VP2, VP3a | funding | not danger; discomfort that accrues while you sit |
| humidity | HRN_VP4, VP1d | the day's realised range | moisture: neither good nor bad, but felt |

628 sensory neurons. Put a cost signal in the food channel and you get a fly attracted to expense —
which would be *our* fly, not a fly.

**Every channel is normalised across the whole market population**, not against a ceiling. That was a
bug first: dividing open interest by the largest in the universe gave a median reading of 0.9%, and
funding against the exchange's clamp gave 0.06%, so 56 of 57 markets smelled of nothing at all. The
fix is the one the animal already uses — the antennal lobe performs **divisive normalisation**,
scaling each glomerulus by the whole population's input (Olsen & Wilson, 2008).

### The readout

Five descending pathways, each a real motor command:

- **LPLC2** — looming detection → escape
- **MN9** — a proboscis motor neuron; the fly extends toward food → long
- **MDN** — moonwalker; the fly backs up → short
- **DNp09** — freeze
- **DNa02** — steer

Conviction is the normalised difference between feed and retreat. How much of the allowance that is
worth comes from the animal's own neuromodulator balance — **octopamine against serotonin**, arousal
against calm. DNp01, the giant fibre, is published every pass and **never acted on**, because it sits
at noise on this input. It is there so anyone can watch it not matter.

**A measured caveat:** `brain/probe-bias.js` drives one channel at a time and finds that Johnston's
organ alone puts MDN at 55.8Hz and the fly shorts 94%, while all five other channels drive MN9. With
everything firing at once, five beat one — so the fly is long about 88% of the time. That is a
property of the sense-to-drive mapping, it is measured rather than assumed, and it is **not** to be
rebalanced to manufacture shorts. The leverage is set around it instead.

---

## The desk

**Zero maker fee, zero taker fee.** The entire cost of trading is the spread, and only whoever
crosses it pays. So every order walks the live book before it goes — filling level by level,
measuring the real distance from mid to the average price it would get. Under `takerMaxBps` it
crosses and takes the certainty; above, it rests post-only.

**Twelve slots of margin, each levered 5×.** The account is divided into equal shares of *margin* —
not notional, because nine of the markets refuse 10× and budgeting a fixed notional per slot quietly
demands three slots' margin for one position. Each slot is ~0.42× equity of notional; twelve of them
reach the 5× aggregate cap.

**Nothing is a dollar figure.** Every limit is a fraction of equity, so an account that doubles takes
positions twice the size with nothing to edit. Compounding is the *absence* of a mechanism.

**A depth cap that is measured, not assumed.** Size is capped at a quarter of the *thinner* side of
the live book, read fresh every pass, because escape dumps the whole position in one order and a size
you can enter but cannot leave is a trap. A market that cannot absorb at least half a slot is not
seated at all — a slot is a twelfth of the account, and one holding $194 wastes 96% of its capacity.

**A full book rotates rather than refusing.** When every slot is taken and the fly turns to a market
it wants, it closes the position it has gone longest without facing. Where the animal has been
looking is a real property of it, not a coin flip with a label on.

**Four independent seatbelts:** `--broadcast` on the command, `trade.armed` in the config, a maximum
notional enforced *inside the signing process* as a multiple of equity it reads off the exchange
itself, and a depth cap measured live. And a feed that records refusals — a feed showing only the
orders that went through is a highlight reel.

```bash
node fly.js --flatten --broadcast    # close everything, now
```

---

## Does the arithmetic survive size?

There is no backtest here and there will not be one: a profit figure needs an execution model, a
slippage model and a forward return, and each is a number somebody chose.

What *can* be answered is whether the machinery holds when the account is large. **Nothing in
`brain/` ever sees the balance**, so the same market gives the same decision at any size and only the
worth of that decision changes. `trader/simulate.js` makes one run of real decisions against live
markets and replays it:

```
    equity        positions      notional      × equity     margin used
         $76.00        10/10        $466.52        6.14×            75%
         $1,000        10/10         $6,138        6.14×            75%
       $100,000        10/10       $613,846        6.14×            75%
     $1,000,000        10/10     $6,138,462        6.14×            75%
```

Identical leverage and margin utilisation four orders of magnitude apart. The simulation caught a
real bug on its first run: twelve decisions had opened twelve positions in ten slots and buried 91%
of the balance in margin.

**The cost that does not scale.** Every limit is a fraction of equity so the percentages look
scale-free, but the cost per unit of notional is not: measured on live books, a $50,000 order pays
**6.9bp** where a $5,000 order pays **2.9bp**, because it walks deeper before it fills. The pass
interval therefore has to *rise* as the account grows — the opposite of the instinct, which is why
it is written into the config beside the number.

---

## Money in: the token

Creator fees from a PONS token on Robinhood Chain fund the account. Two legs, each armed separately:

**Leg A** — `curve.sweepFees(0)` moves fees into escrow credit, then `escrow.claim()` pays native ETH
to the fee wallet. Separate transactions and separate error handling, because after graduation
`sweepFees` reverts `AlreadyGraduated()` and that must never abort the claim.

**Leg B** — fees arrive as ETH and Lighter margin is USDG, so: wrap ETH→WETH, swap on the 1bp v3 pool
against a QuoterV2-derived floor, approve, `deposit(_to, assetIndex=3, routeType=0)`.

**Every address on the money path was read from the chain by this repo, not copied from a document.**
The deposit contract is a **proxy**: its 1,367 bytes contain no selector at all, so checking it alone
says `deposit()` does not exist. The EIP-1967 implementation slot points at
`0x82de5b1161c93afdfe21ba0d5343f01cd7401d90`, whose 23,168 bytes do contain `0x8a857083`. USDG
answers `symbol()=USDG decimals()=6`; the pool answers `token0=WETH token1=USDG fee=100`. A wrong
deposit address is a total loss rather than a retry.

The harvester is started **before** the launch and left alone. It watches the chain for a launch by
the configured wallet, confirms the fees actually point at the fee wallet — a launch *by* an address
is not a launch that *pays* it — wires the token and curve into config itself, and harvests from then
on. It recovers WETH stranded by an interrupted pass, because a leg that dies after the wrap leaves
money a native-balance check never looks at again.

```bash
node keeper/keygen.js                                            # a fresh fee wallet; prints once, writes nothing
node keeper/launch.js serve                                      # local form; YOUR wallet signs
node keeper/harvest.js --loop --broadcast --arm-harvest --arm-fund
```

---

## Run it

```bash
npm install                      # viem, and @vercel/blob for publishing
python brain/build-graph.py      # once — needs the three MaleCNS files in brain/data/
npm test                         # the brain suite and the money suite
node fly.js                      # one pass, dry
node loop.js --broadcast         # keep passing, and trade
node site/serve.js               # the site on :4173
npm run preflight                # every check that must be green before broadcasting
```

`brain/data/` is a 1.1 GB download and `brain/graph/` is 42 MB of derived binaries; both are
gitignored and the graph rebuilds in about 90 seconds. From
`https://storage.googleapis.com/flyem-male-cns/v1.0/connectome-data/flat-connectome/`:

| file | size |
|---|---|
| `connectome-weights-male-cns-v1.0-minconf-0.5.feather` | 1.1 GB |
| `body-annotations-male-cns-v1.0-minconf-0.5.feather` | 13 MB |
| `body-neurotransmitters-male-cns-v1.0.feather` | 42 MB |

**A pass costs roughly 30× its fly time in CPU.** 350ms of neuron time is about 10 seconds of compute,
which is why the fly thinks in bursts rather than continuously.

### Keys

Three credentials, and they are different things:

| variable | what it is | read by |
|---|---|---|
| `LIGHTER_API_KEY` | a **Lighter-native** key (not EVM), registered at index ≥ 4 | `trader/signer.py`, nothing else |
| `PRIVATE_KEY` | an EVM key on chain 4663 — the **fee wallet** = `creatorFeeRecipient` | `keeper/harvest.js` |
| `BLOB_READ_WRITE_TOKEN` | publishes stats to the site | `core/publish.js` |

None of them ever goes in a config file. The key that owns the Lighter account — which can withdraw
the whole balance — is **not** among them and never reaches the keeper; the harvest signs as the fee
wallet and deposits *to* the account owner.

---

## Layout

```
brain/      the animal. graph build, LIF simulation, the arena, senses, readout, probes
trader/     the money. market data, account, sizing, the feed, the signer, the simulator
keeper/     launch, harvest, leverage, keygen, config, state
core/       copied verbatim from the framework and NEVER edited
site/       one page, reading stats.json and nothing else
```

`DESIGN.md` is the derivation and the boundary. Read it before touching `brain/` or `trader/`.

---

## What the site may claim

The page reads `stats.json` and nothing else. No key and no endpoint reaches a browser, and it cannot
show a number the keeper did not publish — a page that can compute its own figures will eventually
compute a flattering one. Every position and fill links to the exchange's own explorer.

It says, in its own voice: that this is a wiring diagram and not a mind; that the fly has not learned
anything, because a connectome is one frozen snapshot of synaptic weights; that escape reads LPLC2
while DNp01 sits at noise, with the spike count published so you can watch it not matter; and that
nothing is tuned to make money. If any of those stops being true, the page changes in the same commit.

## Attribution

MaleCNS v1.0 — Janelia FlyEM Project Team, the Cambridge Drosophila Connectomics Group (MRC LMB), and
the Connectomics group at Google. Released 2026-09-03 under CC BY 4.0. Dynamics follow Shiu et al.
(2024). Sensory normalisation follows Olsen & Wilson (2008).

## Licence

MIT for the code — see `LICENSE`. The connectome is CC BY 4.0 and the attribution is a condition of
it, not a courtesy; `NOTICE.md` says what is covered by what.
