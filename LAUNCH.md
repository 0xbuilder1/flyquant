# The first fly to try to make $1,000,000

A fruit fly has been given a funded trading account and control of the money.

Not a metaphor. Not a chatbot told to act like a fly. The actual reconstructed wiring diagram of a
*Drosophila melanogaster* brain — 165,836 neurons, 6,242,118 connections, 89,860,280 synapses, every
one of them measured from a real animal under an electron microscope — is wired to a perpetual
futures account on Lighter and is placing orders with real money right now.

The account index is printed on the site. You can read its positions straight off the exchange
without trusting a single word of this.

It is trying to turn that account into a million dollars. It will probably fail. That is not the
point, and if you think it is, you are going to miss what is actually happening here.

---

## What it is being fed

This is the part people underestimate. The fly is not looking at a price chart.

Every few minutes it receives a complete picture of all 57 markets on the exchange, simultaneously.
For each one:

- **the mark price**, and how far it has moved since the last time it looked
- **the index price** it settles against — and therefore the basis, how far the market has pulled
  away from the thing it is supposed to track
- **open interest**, in dollars, market by market
- **the funding rate**, and which way it is being paid
- **the full order book**, depth on both sides, to whatever distance from mid we care to measure
- **24-hour volume** and trade count
- **the day's high and low**, and therefore the realised range
- **the maximum leverage** each individual market will grant
- **its own account**: equity, margin, every open position, unrealised P&L, liquidation prices

That is not a toy feed. It is the same surface a desk trades off. And crucially, the fly gets *all
57 at once* — not one symbol at a time, but the whole universe in the visual field simultaneously,
which is exactly how a tethered fly sees a panorama.

## How a fly reads a market

Here is the interesting problem. You have a real animal's brain, with real sensory organs, and a
firehose of market data. How do you connect them without simply making things up?

The rule the whole project hangs on: **a channel may only carry a signal whose published innate
valence matches its own.** Flies are not blank slates. Decades of behavioural work has established
what specific olfactory glomeruli *mean* to an animal that has never encountered them before. So
each market quantity is routed to the organ that already responds to that shape of thing.

| what the exchange publishes | which organ receives it | why that one |
|---|---|---|
| ground gained since the last look | **ORN_DM1, ORN_VM2** — the cider-vinegar glomeruli | innately appetitive; a fly walks toward them from birth |
| mark pulled away from its index | **ORN_DA2** — the geosmin line | the one smell a fly is *born* fleeing, and it overrides attractive odours |
| open interest | **ORN_DA1** — the pheromone glomerulus | reports that *other flies are here*, and nothing about whether they are right |
| order book imbalance | **Johnston's organ** — the antennal ear | anemotaxis: a fly walks into the wind, and a leaning book is a prevailing wind |
| funding rate | **thermoreceptors** (TRN_VP2, VP3a) | not danger — discomfort that accrues the whole time you sit there |
| the day's realised range | **hygroreceptors** (HRN_VP4, VP1d) | moisture: neither good nor bad, but something the animal can feel |

628 sensory neurons across six channels. Put a cost signal into the food channel and you would get
a fly attracted to expense — which would be *our* fly, not a fly.

And vision is separate, because vision answers a different question. The 57 markets are seated
around the animal at fixed azimuths — MaleCNS makes this literal, since every columnar optic-lobe
neuron carries a retinotopic coordinate, giving 1,771 addressable columns across 72 bands. Each
market is a patch of light whose brightness is its volume rank. And a **falling** market *expands*
across the pass, because to a visual system a collapse and a looming predator are the same event:
an object getting bigger, fast.

**Vision says which market. Chemistry says whether it is any good.** The fly turns, and whatever it
ends up facing is what it trades.

## The bug that explains the whole design

The six senses shipped, went live, and read almost exactly zero.

The cause was mundane and it is worth stating because it is the kind of thing that quietly ruins
this sort of project. Each channel was being scaled against a ceiling — open interest against the
largest market in the universe, funding against the exchange's own clamp. Measured across all 57
markets, that gave a **median reading of 0.9%** for open interest and **0.06%** for funding.
Fifty-six of the fifty-seven markets smelled of nothing at all. The fly was not ignoring the data.
It could not detect it.

A real fly does not have this problem, and the reason is published. The antennal lobe performs
**divisive normalisation**: a network of local neurons scales each glomerulus by the total input
across all of them, so a projection neuron reports how strong its channel is *relative to the whole
population* rather than in absolute units (Olsen & Wilson, 2008). It is why a fly can smell a faint
odour in clean air and still discriminate against a strong background.

So every channel now reports where its market stands among all 57. The animal's own solution,
applied to the animal's own problem. And a pleasant side effect: a rank has no scale factor in it,
which means there is nowhere left to put a number that could be tuned to improve returns.

## Two other things that cost a day each

**Histamine is inhibitory in flies.** Leave it out of the sign table and nothing throws an error.
The code runs. It just silently blinds the animal.

**You have to enter at the medulla, not the lamina.** Injecting current into L1 — the obvious first
visual layer — produces nothing at the escape pathway, because `Mi1 ← L1` is 141,873 synapses at
sign *negative*. L1 is glutamatergic, photoreceptors are histaminergic and inhibit it, so driving L1
is showing the fly *darkness*. The model was right the whole time and the stimulus was wrong.

Enter at Tm1/Tm2/Tm4/Tm9/Tm20 instead and the looming selectivity comes out of the connectome for
free: an expanding patch drives the escape detectors **5.7× harder** than a bigger static one.
Nobody built that in. It is what the wiring does.

---

## The desk

The trading infrastructure is ordinary engineering, and it is built like it.

**Zero maker fee. Zero taker fee.** Lighter charges nothing either side, which changes the entire
shape of the problem: the whole cost of trading is the spread, and only whoever crosses it pays. So
every order walks the live book before it goes — filling level by level, measuring the real distance
from mid to the average price it would get. Under 6 basis points it crosses and takes the certainty.
Above, it rests post-only: fills at the named price or not at all.

**Ten slots of margin, each levered 10×.** The account is divided into ten equal shares of *margin*,
capped per market by what that market actually allows — nine of the 57 refuse 10× and get 3× or 5×
instead. Margin is what divides evenly, not notional; budgeting a fixed notional per slot quietly
demands three slots' worth of margin for a 3× market and gets the tenth order rejected while the
account still looks fine.

**Nothing is a dollar figure.** Every limit is a fraction of equity. An account that doubles simply
takes positions twice the size, with nothing to edit and no scaling mechanism anywhere. That is
deliberate: compounding should be the *absence* of a mechanism, not the presence of one.

**A depth cap that is measured, not assumed.** A 25% position on $100,000 is $25,000 — about 4% of
BTC's book, and 5,749% of CASHCAT's. So size is capped at a quarter of the *thinner* side of the
live book, read fresh every pass, because escape dumps the whole position in one order and a size
you can enter but cannot exit is a trap.

**Three independent seatbelts**, and a feed that records refusals — every pass written down,
including the ones that placed nothing and the ones the exchange rejected, with the exchange's own
error code. A feed that only shows the orders that went through is a highlight reel.

## Does the arithmetic survive a million dollars?

There is no backtest here and there never will be one. A profit figure would need an execution
model, a slippage model and a forward return, and each of those is a number somebody chose.

But one thing *can* be answered honestly, and it is the one that matters for the goal: does the
machinery still work when the account is large? **Nothing in the brain ever sees the balance.** The
animal cannot know how much money it has. So the same market produces the same decision at any size,
and the only thing that changes is what that decision is worth.

One run of real decisions against live markets, replayed at four account sizes:

```
    equity        positions      notional      × equity     margin used
         $76.00        10/10        $466.52        6.14×            75%
         $1,000        10/10         $6,138        6.14×            75%
       $100,000        10/10       $613,846        6.14×            75%
     $1,000,000        10/10     $6,138,462        6.14×            75%
```

Ten slots filled, identical leverage, identical margin utilisation, four orders of magnitude apart.
The eleventh market is refused with a stated reason rather than silently overcommitting — a bug the
simulation caught, where twelve decisions had opened twelve positions in ten slots and buried 91% of
the balance in margin.

**The machinery is built to run a seven-figure book. It is currently running $76.**

Both of those are true, and the distance between them is the entire story. The constraint is the
size of the account, not the design of the thing trading it.

---

## Why this is a bigger story than a trading bot

Every automated trading system ever shipped was designed, by a person, to make money. Its objectives
were chosen. Its features were chosen. When it works you have learned something about the person who
built it.

This one was not designed to make money and cannot be made to. The time constants are published
values used verbatim, and the repo's first rule is that changing one because it improved returns is
forbidden. The senses are ranks, so there is no gain to adjust. The neurotransmitter signs are the
dataset's. The escape pathway's selectivity is the connectome's own.

What is actually being run, then, is a question nobody has been able to ask before, because the
complete wiring of a brain has only existed for a matter of months:

**Give a real animal's nervous system a real economic environment and real consequences — what does
it do?**

A fly foraging for rotting fruit is solving a problem with the same shape as allocating capital:
noisy evidence, a bounded body, an opportunity cost to standing still, and a cost to being wrong
that you pay in the only currency you have. Nobody knows whether 165,836 neurons that evolved for
one of those can do anything at all about the other. Now it is running, with money on it, in public,
with every fill linked to its transaction.

The million is the scoreboard. The experiment is the point.

---

## What this is not

**A wiring diagram, not a mind.** Every connection is measured from a real animal. Nothing about
that makes it conscious, and nothing here claims it is.

**It has not learned anything.** No training, no fitting, no memory between passes beyond its
heading and the last order book it read. The same input gives the same output, every time.

**It has no edge, and none is claimed.** A fly is not a good trader. It is a real animal making real
decisions with real money, which is a stranger and more interesting thing than a good trader.

**Nothing is tuned to make money.** That constraint is the product. Remove it and this becomes a
trading bot in a costume, and every sentence above becomes a lie.

Open source. Every position public, every fill verifiable on chain.

*Connectome: MaleCNS v1.0 — Janelia FlyEM, Cambridge Drosophila Connectomics Group (MRC LMB), and
Google Connectomics, released September 2026. CC BY 4.0. Neuron model: Shiu et al. (2024).*
