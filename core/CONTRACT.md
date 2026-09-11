# The sink contract — `api 1`

`core/sink.js` version-stamps this. Changing anything below is a **major bump**: every sink in
`sinks/` declares `api` and the core refuses one it does not speak, on the first line of the process,
before a client is built or a key is read.

The core is the half that is identical whether the money goes to five known charity contracts on a
second chain or to five thousand wallets discovered from Transfer logs on this one. Everything else
is the sink.

The two real sinks disagree on **recipient count, recipient provenance, chain count, USD, receipts,
send concurrency, bump policy, CLI vocabulary and plan shape** — so none of those appears in a core
signature. They agree on **config loading, launch detection, the harvest, the claim ledger, the
fee-funded ceiling, mutual exclusion, preflight rendering, stats publication and the loop** — so all
of those are core, or the third sink re-derives them badly.

---

## The members

A sink is a plain CommonJS module. Six are required; the rest are optional and default to nothing.

### Required

| member | shape | what it is |
|---|---|---|
| `declare(cfg)` | `=> object` | static, read **before** `configure`. Must not touch the network or the disk. |
| `configure(ctx)` | `=> void` | dependency injection, exactly once, at composition. |
| `audit(sourceBalanceRaw)` | `=> {ok, deltaRaw, …}` | the sink's own equality, whatever shape it has. The core consumes `{ok, deltaRaw}` and nothing else. |
| `spentRaw()` | `=> bigint` | everything that has already left. |
| `reservedRaw()` | `=> bigint` | wei promised but not yet sent. |
| `stats(prev)` | `=> object` | the sink's half of a file **the core writes**. |

### Optional

| member | shape | what it is |
|---|---|---|
| `declaredFloatRaw()` | `=> bigint` | the one permission a keeper has to send non-fee value. Defaults to `0n`. |
| `preflight(t)` | `=> void` | ROWS, not a report. `t = {add, whyNotAddr, addr, dry, accounts}`. |
| `reconcile(t)` | `=> void` | a CORE-DRIVEN PHASE, called at the top of every broadcast pass, before `plan`. |
| `plan(t)` | `=> planObject \| null` | `t = {addr, s, pendingCredit, dry, accounts}`. `null` means *nothing to do this pass*, and the core treats it as normal, not as failure. |
| `printPlan(plan, s)` | `=> void` | the sink prints its own plan; the core has no opinion about the shape. |
| `fire(t)` | `=> void` | the sink's whole pass after the harvest. `t = {addr, accounts, wc, dry, s, plan}`. |
| `cli(t)` | `=> boolean` | `true` when handled. `t = {argv, arg, has, dry, wc, account, accounts, addr, s}`. |

### `declare()`

```js
declare(cfg) => {
  api: 1,
  id: 'charity',                 // log prefix, state sub-namespace
  configKey: 'donate',           // the ONLY key of cfg the core hands back; never interpreted
  outLabel: 'donated',           // the ledger's out-bucket noun: donated|paid|spent|burned|accumulated
  clients: [ {key, chainId, label, rpc, explorer} ],   // chains BEYOND cfg.chain
  keys:    [ {env, role, requiredWhen(t), mustEqual(), hint} ],
  readOnlyCommands: ['--donate-status'],   // exempt from keeper.lock
  commands:         ['--donate', …],
  signerOptionalFor:['--payout'],          // commands that do not need PRIVATE_KEY
  outAsset: 'native',            // 'native' | {address, symbol, decimals}
}
```

`clients` is why the core no longer builds a charity destination client for every token, and `keys`
is why it no longer names `PAYOUT_PRIVATE_KEY` or `donate.destination.address` in its own error
messages. `readOnlyCommands` is why the lock exemption is not spelled with two charity flags.

* SINK A (charity): one extra client, one extra key, two read-only commands, six commands.
* SINK B (holders): `clients: []`, `keys: []`, `readOnlyCommands: []`, `commands: []`,
  `configKey: 'rule'`.

### `configure(ctx)`

`ctx` is frozen at the top level; its members are not.

```js
ctx = {
  api: 1,
  cfg,                       // THE WHOLE CONFIG, by reference — not a copy
  sinkCfg: () => cfg[configKey] || {},          // a FUNCTION, never a snapshot
  clients: { source, ...declared },             // built once, never rebuilt
  paths: { root(), outDir(), statsFile(), stateFile(name), sinkDir() },
  io: { readJson, readLedgerJson, writeJson, ensureDir },
  fmt: { log, fq, fOut, qSym, outSym, lc, short, stamp, now },
  chain: { id, name, explorer },
  harvest: { claimedRaw, gasRaw, pendingClaims, file, recordClaim, recordGas, measureDelta },
  ceiling: { donatable, feesAvailable },        // READ-ONLY to the sink; the core OWNS these
  stats: { write },                             // the single writer; write-only
  halt: null,                                   // the sink owns its own halt semantics
  lib: { scanLogs, ledger, inflight, nonces, tokenFacts },   // opt-in libraries, not lifecycle
}
```

---

## Five laws, each with the incident that produced it

1. **A sink may NEVER construct a chain client.** `verifyLeg` in the charity sink once built one
   inline with `createPublicClient`, which made it the only network path in that module a fake chain
   could not intercept — and therefore the only one with no test behind it, sitting behind the one
   leg a human types in. `assertSink()` reads the sink's own source at load time and refuses one that
   names the constructor. (`PONS_STRICT_SINK=0` turns the check off; nothing in this repo needs it.)

2. **Client lifetime is part of the test contract.** `clients.*` objects are created once at
   composition and never replaced, because the fake-chain suites fake a chain by assigning over the
   methods of those exact objects. A core that rebuilt clients per pass would silently disarm every
   money test in the repo.

3. **`sinkCfg` is a function and `paths.outDir` is a thunk.** The suites swap `cfg.donate` and
   `cfg.output` wholesale *after* `configure()`; a captured object or a captured string freezes the
   first case's config into every later one.

4. **`readLedgerJson` is the core's, and is not overridable.** It used to be optional at the seam
   (`deps.readLedgerJson || deps.readJson`), which degrades silently to the lenient reader — exactly
   the failure the strict one exists to prevent: a truncated ledger read as empty restarts `seq` at
   0, reuses batch ids over real receipts, and republishes cumulative totals as zeros.

5. **A published file may never be an input to the ceiling.** SINK B's `feesAvailable()` subtracted
   `stats.totalRedistributedRaw`, read *leniently*, from its own spending limit — so a half-written
   `stats.json` would have raised the ceiling by the entire lifetime total. `ctx` therefore exposes no
   reader for `paths.statsFile`; `stats.write` is write-only.
   *One grandfathered exception:* the charity sink's `alreadyOutRaw()` takes `max(ledger, published)`,
   so a corrupt read can only ever **lower** the published term while the ledger term still holds. It
   moves as-is.

**Asymmetry, on purpose:** the core may never read inside `cfg[configKey]`; a sink MAY read core keys
(`cfg.chain.id`, `cfg.output.statsFile`, `cfg.distribute.verified`). The core has to work with a sink
it has never heard of; a sink is allowed to know which framework it is in.

---

## The ceiling

```
core.donatable() = claimedTotal(harvest.json)
                 + sink.declaredFloatRaw()
                 − gasRaw(harvest.json)
                 − sink.spentRaw()
                 − sink.reservedRaw()
```

There is exactly **one** ceiling function, so that two code paths can never each spend the same
claimed wei. It is the core's, and a sink that exposes a `donatable` of its own is a bug — the split
into `spentRaw`/`reservedRaw` is what makes the out-bucket a framework concept rather than a union of
whichever names the sink written second happened to know.

The proof that this matters is already in the tree: the charity sink's `reservedRaw()` is the
**deleted holder sink's ledger** being subtracted inside the charity sink, because a wallet upgraded
mid-life can still carry an `accruals.json`.

---

## `stats(prev)` — the sink's half of a file the core writes

```js
prev    = readJson(statsFile, {})
payload = { …core identity…, ...sink.stats(prev), feesRedirected, updatedAt }
```

One merge, one `writeJson`, one fire-and-forget publish. `ctx.stats.write()` is callable from
anywhere in a sink's money path.

`feesRedirected` is core state the sink cannot see, so it is written **over** the sink's object
rather than merged behind it.

The sink owns its own monotonic ratchet inside `stats()`. The charity sink ratchets `donatedRaw` on a
shared high-water mark and `paidRaw` on its *own separate* floor, precisely because clamping them
together would publish `paid == donated` the instant either moved.

---

## `cli(t)` — the published part of the contract

**Every "I did not do the thing" return sets `process.exitCode = 1`.** A green prompt after a refused
payout told a wrapper script the payout had succeeded.

---

## What is deliberately NOT in the core

Each of these looks shared. Each would break the moment the second sink used it.

1. **`plan()`'s shape, `printPlan`, and `fire`'s body.** No field beyond `at`, `latest` and `pot` is
   common between the two real sinks, and even `pot` is arrived at differently. A core plan struct
   forces one sink to lie about itself. A 5,000-wallet round cannot be represented in a plan object
   the core requires to enumerate recipients.

2. **The send loop, and with it nonce and bump policy.** Charity is strictly sequential and pays a
   bump **out of the reserve**, because a bump re-signs the same nonce and with transfers in flight a
   bump on leg 2 invalidates the balance legs 3–5 were signed against. The holder sink runs 20 in
   flight on pre-assigned nonces and never bumps. A shared loop parameterised by
   `{concurrency, bump}` fits both and deletes the recorded reason each one is what it is. The core
   owns only the two pieces that are identical and genuinely dangerous to reimplement — the nonce
   allocator and append-before-broadcast — and offers them as **libraries**, in `core/lib/`.

3. **Recipient discovery and the rule.** The address book, the snapshot, eligibility, weighting,
   truncation and *who gets cut*. This is the coin's politics. A core that owned any of it would own
   an eligibility policy.

4. **`CAUSE_IDS` and everything keyed on it.** A sink with no fixed recipient list has no analogue of
   any of it.

5. **The receipt/USD vocabulary.** `verified:'operator'` vs `'chain'`, `usdCents`, `recordLeg`,
   `verifyLeg`. A single-chain sink has no operator-typed leg at all. What the core takes from it
   instead is one **negative rule**: *there is no price feed, in the core or in any sink.* A sink may
   publish dollars only where units **are** dollars.

6. **A second chain.** Built only from `declare().clients`.

7. **"The destination must be an EOA."** Correct for a plain-transfer sweep (21000 is exact only
   there, and an estimated reserve is what leaves a remainder) and **fatal** for every sink whose
   primary leg is a contract call. It sits under a generic-sounding name and stays inside the sink.
   Its inverse — estimate per destination, pad, refuse an address whose code reads wrong *for its
   declared role*, and ask the wallet's balance FIRST so an empty wallet is not reported as a charity
   refusing value — is the better ancestor for future sinks, and is also sink-side.

8. **Floors, gas reserves and cadence.** `loop.intervalMs` is core config but **not a
   sink-independent number**: a holder sink rebuilds five Maps over every address that ever touched
   the token, from genesis, every pass, and a per-minute cadence would not survive it. The core does
   not clamp it. Choose it per sink.

9. **The halt.** The *lesson* is a framework invariant and is recorded here: **scope is stored as a
   field and compared by equality, never re-derived from a sentence.** Batch ids are only fixed-width
   to seq 9999, and `"batch 10000"` contains `"batch 1000"` — so settling batch 1000 late would clear
   the halt protecting 10000. The *code* stays in the sink until a second sink needs it in the
   identical shape. (The charity sink still classifies one halt by regex, which is the very thing
   scope was introduced to stop; it is a known wart, not a pattern to copy.)

10. **The site, and the honesty guard's assertions.** The harness is core (`core/claims.js`) and so
    are the rows derivable from the config. Every claim about a promise is one token's, and a shared
    assertion file across tokens is explicitly **not** a goal.

11. **`distribute.*`'s legacy keys.** `distribute.verified` (the unattended-loop gate) and
    `distribute.gasReserveEth` (the operator's own float floor) are core; `launchBlock` is
    core-written and sink-read. **`minPot` belongs to whichever sink declares it** — the charity sink
    still reads it out of `cfg.distribute` as one of its three floors, and moving it to
    `cfg.donate.minPotRaw` is a follow-on commit with its own test change. A new token's template
    ships with none of the rest.

---

## `core/lib/*` — offered, never demanded

| module | what it is | why it is not lifecycle |
|---|---|---|
| `scanlogs.js` | chunked windowed log reader, one backoff per chunk, optional raw `eth_getLogs` | two hand-rolled copies of one loop already existed in one file |
| `inflight.js` | append-**fsync-before-broadcast** JSONL; sweeps **every** matching file | a crashed round leaves its log under its own name while the restart is on a new one |
| `ledger.js` | `creditRound` / `owed` / `settle` / `totalOwedRaw`; **key space is the sink's** | `address` for a holder sink, `${batchId}:${causeId}` for charity |
| `nonces.js` | `reserve(client, addr, n)` off `getTransactionCount(pending)` | read once, persist before signing |
| `tokenfacts.js` | `{symbol, decimals, totalSupplyRaw}`, cached per pass | preflight already reads all three and throws the supply away |

A sink writes its own ten-line send loop over `nonces` and `inflight`. That is the point.
