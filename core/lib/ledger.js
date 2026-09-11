/**
 * @pons/core/lib — the obligation ledger: what has been promised and not yet delivered.
 *
 * Offered, never demanded, and the KEY SPACE is the sink's choice — a holder sink keys on the
 * recipient address, the charity sink keys on `${batchId}:${causeId}` because a partially paid batch
 * is its normal recovery case and the ledger has to be able to say that legs 1-2 are settled and
 * 3-5 are not.
 *
 * totalOwedRaw() is what a sink returns from reservedRaw(): money promised here must never leave
 * again as something else.
 */
'use strict';

const big = (v) => BigInt(v || '0');

function ledger(file, io) {
  const read = () => io.readLedgerJson(file, {});
  const write = (o) => io.writeJson(file, o);

  return {
    file,
    all: read,

    /** credit a round exactly once — the roundKey is what makes a replay idempotent */
    creditRound(roundKey, entries, roundsFile) {
      const rounds = io.readLedgerJson(roundsFile, { credited: [] });
      if (rounds.credited.includes(String(roundKey))) return false;
      const acc = read();
      for (const e of entries) acc[e.key] = (big(acc[e.key]) + big(e.amountRaw)).toString();
      rounds.credited = rounds.credited.concat([String(roundKey)]).slice(-500);
      write(acc);
      io.writeJson(roundsFile, rounds);
      return true;
    },

    owed(minRaw) {
      const acc = read();
      const floor = big(minRaw);
      return Object.keys(acc)
        .map((k) => ({ key: k, amountRaw: big(acc[k]) }))
        .filter((x) => x.amountRaw > 0n && x.amountRaw >= floor);
    },

    /** settle only what a receipt actually confirms; anything unconfirmed stays owed */
    settle(keys) {
      const acc = read();
      let n = 0;
      for (const k of keys) if (acc[k] && big(acc[k]) > 0n) { acc[k] = '0'; n++; }
      if (n) write(acc);
      return n;
    },

    totalOwedRaw() {
      const acc = read();
      return Object.keys(acc).reduce((a, k) => a + big(acc[k]), 0n);
    },
  };
}

module.exports = { ledger };
