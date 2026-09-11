# flyquant

A complete fruit fly connectome, with a wallet.

**166,700 reconstructed neurons** of an adult male *Drosophila melanogaster* — MaleCNS v1.0, Janelia
FlyEM / Cambridge / Google, CC BY — simulated as a leaky integrate-and-fire network using published
constants, sitting in a flight arena where **57 live perp markets** on Robinhood Chain are arranged
around it. It turns toward one. Its motor neurons decide what to do about it. That decision becomes
a target position, and the trader reconciles a real Lighter account to it.

Nothing has traded yet. Three independent seatbelts stand between the fly and a live order:
`--broadcast` on the command, `trade.armed` in the config, and a maximum notional enforced inside
the signing process itself.

## Run it

```bash
npm install                      # viem, and nothing else at runtime
python brain/build-graph.py      # once — needs the three MaleCNS files in brain/data/
npm test                         # the brain suite and the money suite
node fly.js                      # one pass, dry
node loop.js --every 180         # keep passing, so the site has something to show
node site/serve.js               # the site on :4173
```

`brain/data/` is a 1.1 GB download and `brain/graph/` is 42 MB of derived binaries. Both are
gitignored; the graph rebuilds in about 90 seconds. The site's copy of the point cloud **is**
committed, because the host serves it and cannot run Python.

Fetch the dataset from `https://storage.googleapis.com/flyem-male-cns/v1.0/connectome-data/flat-connectome/`:

| file | size |
|---|---|
| `connectome-weights-male-cns-v1.0-minconf-0.5.feather` | 1.1 GB |
| `body-annotations-male-cns-v1.0-minconf-0.5.feather` | 13 MB |
| `body-neurotransmitters-male-cns-v1.0.feather` | 42 MB |

## What it is made of

```
brain/      the animal. graph build, LIF simulation, the arena, senses, readout
trader/     the money. lighter market data, account, sizing, the feed, the signer, the PONS sink
keeper/     core + sink composition, config, state
core/       copied verbatim from the framework and NEVER edited
site/       one page, reading stats.json and nothing else
```

`DESIGN.md` is the derivation and the boundary. Read it before touching `brain/` or `trader/`.

## The state of every leg

| leg | status |
|---|---|
| MaleCNS → simulation | **live.** 165,836 neurons, 6,242,118 edges, 89.9M synapses |
| Lighter market data | **live.** 57 markets, public REST, no key |
| Lighter account + positions | **live, read-only.** Public by index; the site links to the same URL |
| the fly's decision → target position | **live.** 44 tests cover the arithmetic |
| placing an order | **built, disarmed.** Needs `--broadcast` *and* `trade.armed` *and* a key |
| $FLY launch + escrow harvest | **wired, unlaunched.** `node keeper/launch.js serve` |
| fees → USDG → Lighter margin | **built, disarmed.** `node keeper/harvest.js` |

**Every address on the money path was read from the chain by this repo, not copied from a document.**
The funding path is `escrow.claim()` → wrap ETH→WETH → swap to USDG on the 1bp v3 pool → deposit as
Lighter margin. That last contract is a **proxy**: its 1,367 bytes contain no selector at all, so
checking it alone says `deposit()` does not exist — the EIP-1967 implementation slot points at
`0x82de5b1161c93afdfe21ba0d5343f01cd7401d90`, whose 23,168 bytes do contain `0x8a857083`. USDG
answers `symbol()=USDG decimals()=6`, WETH answers WETH/18, the pool answers `token0=WETH
token1=USDG fee=100`. A wrong deposit address is a total loss rather than a retry, which is why
`fly.deposit.verifiedBy` has to say *how* it was checked before anything arms.

## Before anything can trade

1. `keeper/config.json` → `lighter.accountIndex`. It is a **public** number; the site links to
   `api.rh.lighter.xyz/api/v1/account?by=index&value=<index>` so a viewer can check the book.
2. Register a Lighter-native API key against that account at an index **≥ 4** (0–3 are reserved for
   Lighter's own interfaces). `pip install lighter-sdk==1.1.2`.
3. `set LIGHTER_API_KEY=...` — the key is read from the environment by `trader/signer.py` and by
   nothing else. It never goes in a config file.
4. Run passes dry until the planned orders are ones you would have placed yourself.
5. `trade.armed: true`, then `node fly.js --broadcast`.

**Trade frequency is bound by capital, not by a dial.** Lighter's minimum order is about $10, so an
account needs roughly `$10 / maxFraction` before it can open at all and several times that before
incremental adds clear the minimum regularly. There is no setting that makes a small account trade
often; that is arithmetic, and the config says so where the number lives.

**Losses are meant to be directional, not executional.** Lighter charges zero maker and zero taker
fee, so the whole cost of trading is the spread — and only whoever crosses it pays. Opening orders
rest post-only at the touch and fill at the price named or not at all, which makes slippage zero by
construction rather than small by assumption. What is paid instead is adverse selection, which is a
directional cost. An escape crosses anyway: an order that might not fill is not an exit.

## What the site may claim

The page reads `stats.json` and nothing else. No key and no endpoint reaches a browser, and the site
cannot show a number the keeper did not publish. Every position links to the public account
endpoint; every fill links to `api/v1/tx?by=hash&value=<hash>`.

The page says, in its own voice, that this is a wiring diagram and not a mind; that the fly has not
learned anything, because a connectome is one frozen snapshot of synaptic weights; that escape reads
LPLC2 rather than the giant fiber, and publishes DNp01's spike count so you can watch it sit at
noise; and that nothing is trading. If any of those stops being true, the page changes in the same
commit.

## Attribution

MaleCNS v1.0 — Janelia FlyEM Project Team, the Cambridge Drosophila Connectomics Group (MRC LMB),
and the Connectomics group at Google. Released 2026-09-03 under CC BY 4.0. Dynamics follow Shiu et
al. (2024), a leaky integrate-and-fire model of the adult *Drosophila* brain.

## Licence

MIT for the code — see `LICENSE`. The connectome is CC BY 4.0 and the attribution is a condition
of it, not a courtesy; see `NOTICE.md` for what is covered by what.
