# A fruit fly has been given a trading desk

Not a metaphor. Not a language model told to act like a fly. The actual reconstructed wiring
diagram of a *Drosophila melanogaster* brain — 165,836 neurons, 6,242,118 connections, 89,860,280
synapses, every one of them measured from a real animal by electron microscopy — has been wired to
a funded perpetual futures account and given control of the money.

It is trading right now. You can read its positions without trusting a word of this.

---

## The animal

The brain is **MaleCNS v1.0**, released in September by Janelia FlyEM, the Cambridge Drosophila
Connectomics Group and Google Connectomics. It is the first complete central nervous system of an
adult fly: not a region, not a sample, the whole thing, proofread and cell-typed.

Every neuron in it is a leaky integrate-and-fire unit using the membrane and synaptic constants from
Shiu et al. (2024), taken verbatim. Not one of those constants has been touched. The rule the repo
enforces above all others is that no parameter in `brain/` may ever be changed because it improved
returns — the moment a time constant is tuned for profit, this stops being a fly and becomes a
trading bot wearing one.

The neurotransmitter signs come from the dataset's own annotations. Acetylcholine excites,
GABA inhibits, glutamate inhibits, and **histamine inhibits** — the last one matters more than it
sounds. Leave histamine out and nothing throws an error. It just silently blinds the animal.

## The arena

A tethered fly in a flight simulator is one of the oldest paradigms in neuroscience: the animal is
held at the centre of a panorama, objects sit at fixed azimuths, and it turns. MaleCNS makes that
literal, because every columnar optic-lobe neuron carries a retinotopic hex coordinate — 1,771
addressable columns across 72 azimuth bands.

So the 57 markets on the exchange are seated around the fly at fixed azimuths, all of them in the
visual field at once. Each one is a patch of light whose brightness is its volume rank, and a
**falling** market *expands* across the pass, because a collapse and a looming predator are the same
thing to a visual system: an object getting bigger.

Two things had to be got right here, and both took a day to find.

**Stimulation enters at the medulla, never the lamina.** Inject current into L1 and the escape
pathway does nothing at all, because `Mi1 <- L1` is 141,873 synapses at sign *negative* — L1 is
glutamatergic, photoreceptors are histaminergic and inhibit it, so driving L1 shows the fly
*darkness*. The model was right and the stimulus was wrong.

**The turn is the whole descending population.** Steering was originally read off DNa02: two
neurons, a handful of spikes, and an imbalance that turned out to be noise. A probe put a single
bright stripe around the arena and the fly turned toward it three times out of six. So the turn is
now the left-right asymmetry across all **1,314 descending neurons** — 656 left, 648 right —
normalised by what actually fired. The fly went from picking the same market 41 times out of 41 to
ranging across the universe.

## Six senses

Vision says *which* market. It says nothing about whether that market is any good, and a fly does
not extend its proboscis because it saw something across the room. So everything else the animal has
is wired to something the exchange publishes:

| channel | modality | neurons | carries |
|---|---|---|---|
| food | ORN_DM1, ORN_VM2 — the cider-vinegar glomeruli | 115 | ground gained since the last pass |
| geosmin | ORN_DA2 — the hardwired "toxic" line | 48 | how far the mark has pulled off its index |
| cVA | ORN_DA1 — the pheromone glomerulus | 204 | open interest |
| wind | Johnston's organ, JO-EV and JO-ED2 | 202 | how lopsided the order book is |
| heat | TRN_VP2, TRN_VP3a | 13 | funding |
| humidity | HRN_VP4, HRN_VP1d | 46 | how wide the day has been |

The pairings are not decoration. A channel may only carry a signal whose *published innate valence
matches its sign*. Geosmin makes a fly that has never smelled it walk away, and it overrides
attractive odours — so it carries the one number that says a price has come unmoored from what it
settles to. DA1 reports that *other flies are here* and nothing about whether they are right, which
is exactly what open interest is. Anemotaxis — walking into wind — is one of the most reliable
behaviours in the animal, and the order book leans the same way. Put a cost signal into the food
channel and you get a fly attracted to expense, which would be *our* fly, not a fly.

And every one of those channels is normalised **across the whole market population**, not against a
ceiling. That was a bug first: dividing open interest by the largest in the universe gave a median
reading of 0.9%, and funding against the exchange's clamp gave 0.06%, so fifty-six of the fifty-seven
markets smelled of nothing at all. The fix is the one the animal already uses — the antennal lobe
performs divisive normalisation, scaling each glomerulus by the whole population's input (Olsen &
Wilson, 2008), which is why a fly can smell a faint odour in clean air and still discriminate against
a strong background.

## The decision

Five descending pathways are read at the end of every pass, and each one is a real motor command:

- **LPLC2** — looming detection. Escape.
- **MN9** — a proboscis motor neuron. The fly extends toward food. Long.
- **MDN** — moonwalker. The fly backs up. Short.
- **DNp09** — freeze.
- **DNa02** — steer.

Conviction is the normalised difference between the feed and retreat drives. How much of the
allowance that conviction is worth is set by the animal's own neuromodulator balance —
**octopamine against serotonin**, arousal against calm. A fully convinced but unaroused fly takes a
small position. A fully convinced and flooded one takes the whole slot. Neither is a number anybody
typed.

DNp01, the giant fibre, is published every pass and **never acted on**, because it sits at noise on
this input. It is there so anyone can watch it not matter.

---

## The desk

This is the part that is ordinary engineering, and it is built like it.

**Venue.** Lighter, on Robinhood Chain — 57 perpetual markets, and **zero maker and zero taker fee**.
That changes the whole shape of the problem: the entire cost of trading is the spread, and only
whoever crosses it pays.

**Routing.** Every order estimates what crossing would actually cost by walking the live book —
filling the order level by level and measuring the distance from mid to the average price it would
get. Under 6 basis points it crosses and takes the certainty. Above, it rests post-only, which fills
at the named price or not at all. The first live order rested at the touch, was accepted, and never
filled; that is what motivated crossing by default.

**Sizing.** The account is divided into **ten slots of margin**, each levered **10×**, capped by
whatever each market actually allows — nine of the 57 refuse 10× and get 3× or 5× instead. Margin is
what gets divided, not notional, because budgeting a fixed notional per slot quietly demands three
slots' margin for a 3× market and has the tenth order rejected while the account looks fine.

Nothing in the sizing is a dollar figure. Every limit is a fraction of equity, so **an account that
doubles simply takes positions twice the size**, with nothing to edit and no scaling mechanism
anywhere. That is deliberate: compounding should be the absence of a mechanism, not the presence of
one.

**The depth cap.** A 25% position on $100,000 is $25,000 — 4% of BTC's book, and 5,749% of CASHCAT's.
So size is capped at a quarter of the *thinner* side of the live book, read fresh every pass, because
escape dumps the whole position in one order and a size you can enter but cannot leave is a trap.

**Three seatbelts, independent.** `--broadcast` on the command, `trade.armed` in the config, and a
maximum notional enforced *inside the signing process itself*, so a bug in the sizing cannot spend
more than the operator armed no matter what the keeper believes.

**The feed records refusals.** Every pass is written down, including the ones that placed nothing and
the ones the exchange rejected, with the exchange's own error code. A feed that only shows the orders
that went through is a highlight reel.

---

## Does the arithmetic hold at size?

There is no backtest here and there is not going to be one. A profit figure would need an execution
model, a slippage model and a forward return, and every one of those is a number somebody chose.

What *can* be answered honestly is whether the machinery holds when the account gets large. So the
fly makes its decisions once against live markets, and those same decisions are replayed at every
account size — which is the right experiment, because **nothing in `brain/` ever sees the balance**.
The animal cannot know how much money it has. The same market gives the same decision on $76 and on
$1,000,000, and the only thing that changes is what that decision is worth:

```
    equity        positions      notional      × equity     margin used
         $76.00           10        $440.68        5.80×            84%
         $1,000           10         $5,760        5.76×            84%
       $100,000           10       $575,986        5.76×            84%
     $1,000,000           10     $5,759,858        5.76×            84%
```

Ten slots filled, identical leverage, identical margin utilisation, four orders of magnitude apart.
The eleventh market is refused with a reason rather than silently overcommitting — a bug that
simulation caught, where twelve decisions had opened twelve positions on a ten-slot account and put
91% of the balance into margin.

**The machinery is built to run a seven-figure book. It is currently running $76.** Those are both
true statements and the gap between them is the entire point: the constraint is the size of the
account, not the design of the thing trading it. Fees are zero, the sizing is scale-free, the depth
cap is measured live rather than assumed, and every limit is a fraction.

What happens next is up to a fly.

---

## What this is not

Four claims the project has to keep true, and they are on the site next to the numbers:

**This is a wiring diagram, not a mind.** Every connection is measured from a real animal. Nothing
about that makes it conscious, and nothing here is a claim that it is.

**It has not learned anything.** No training, no fitting, no memory between passes beyond its heading
and the last order book it read. The same input gives the same output, every time.

**It has no edge, and none is claimed.** A fly is not a good trader. It is a real animal making real
decisions with real money, which is a different and stranger thing than a good trader.

**Nothing is tuned to make money.** The time constants are published values used verbatim. Every
sense is a rank among the markets, which is precisely why there is nowhere left to put a gain.

Open source. Every fill links to its transaction. The account index is printed on the site so anyone
can read the positions straight off the exchange without trusting the page.

*Connectome: MaleCNS v1.0 — Janelia FlyEM, Cambridge Drosophila Connectomics Group (MRC LMB), and
Google Connectomics. CC BY 4.0.*
