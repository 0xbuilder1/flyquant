#!/usr/bin/env python3
"""
Set the account's leverage on the exchange, once, for every market the fly can face.

WHY THIS IS A SEPARATE OPERATOR SCRIPT AND NOT SOMETHING THE KEEPER DOES

Leverage is account state, not a property of an order. It is signed once per market and then persists,
so a loop that set it every pass would be sending 57 pointless transactions an hour. It is also the
single change that most alters what a sizing bug can cost, which makes it an operator decision that
should be visible in a shell history rather than a side effect of starting the keeper.

WHAT IT SETS, AND WHY NOT ALWAYS THE NUMBER YOU ASKED FOR

Cross margin, so one balance backs every slot -- the whole premise of `slots` in the config is that
ten positions share one account. Leverage is `trade.exposure.leverage`, CLAMPED PER MARKET to what
that market permits. minInitialMarginFraction is published in hundredths of a percent, so 1000 is 10%
initial margin and therefore 10x, and nine of the 57 markets sit below the usual ask: PONS, CASHCAT,
AI and ANSEM allow 3x, and ANTHROPIC, LIT, VVV, OPENAI and SHEIN allow 5x. Asking for more than a
market allows is rejected, so each one gets the most it will give up to the operator's number.

trader/position.js reads the same field and sizes each slot by the same clamped leverage, so what the
fly asks for and what the account can carry are derived from one source. They agree by construction,
not because two numbers were kept in step by hand.

    LIGHTER_API_KEY=...  python keeper/set-leverage.py            # show what it would do
    LIGHTER_API_KEY=...  python keeper/set-leverage.py --arm      # actually send it

No key is read from anywhere but the environment, and none is printed.
"""
import argparse
import asyncio
import json
import os
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
# Lighter's own L2, NOT the settlement L1. Signing against 4663 verifies in the wrong domain and
# comes back as `21120 invalid signature`, which is indistinguishable from a bad key.
CHAIN_ID = 466324


def load_config():
    p = HERE / "config.json"
    if not p.exists():
        sys.exit("keeper/config.json is missing -- copy config.example.json and set accountIndex")
    return json.loads(p.read_text(encoding="utf-8"))


def markets(host):
    with urllib.request.urlopen(f"{host}/api/v1/orderBookDetails", timeout=30) as r:
        body = json.load(r)
    out = []
    for m in body.get("order_book_details", []):
        imf = int(m.get("min_initial_margin_fraction") or 0)
        out.append({
            "symbol": m.get("symbol"),
            "market_id": int(m.get("market_id")),
            # hundredths of a percent -> a leverage ceiling
            "max_leverage": (10000.0 / imf) if imf > 0 else None,
        })
    return sorted(out, key=lambda m: m["market_id"])


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arm", action="store_true", help="send the transactions (default is a dry run)")
    ap.add_argument("--only", help="one symbol, for trying it on a single market first")
    args = ap.parse_args()

    cfg = load_config()
    host = cfg["lighter"]["host"]
    account = int(cfg["lighter"]["accountIndex"])
    api_key_index = int(cfg["lighter"]["apiKeyIndex"])
    wanted = float(cfg["trade"]["exposure"].get("leverage") or 1)

    if wanted <= 1:
        sys.exit("trade.exposure.leverage is 1 -- nothing to set. Raise it in config first.")

    ms = markets(host)
    if args.only:
        ms = [m for m in ms if m["symbol"] == args.only]
        if not ms:
            sys.exit(f"no market called {args.only}")

    plan = []
    for m in ms:
        ceiling = m["max_leverage"] if m["max_leverage"] else wanted
        lev = max(1, min(wanted, ceiling))
        # the exchange takes an initial-margin fraction, and it must be an integer
        plan.append({**m, "leverage": int(lev), "imf": int(10000 / int(lev))})

    clamped = [p for p in plan if p["leverage"] < wanted]
    print(f"account {account} | {len(plan)} markets | asking for {wanted:g}x cross margin")
    if clamped:
        print(f"  {len(clamped)} markets cap below that and get their own maximum:")
        for p in clamped:
            print(f"    {p['symbol']:<10} {p['leverage']}x")
    if not args.arm:
        print("\nDRY RUN - nothing sent. Re-run with --arm to set it.")
        return

    key = os.environ.get("LIGHTER_API_KEY")
    if not key:
        sys.exit("LIGHTER_API_KEY is not set in the environment")

    try:
        import lighter
    except ImportError:
        sys.exit("the lighter SDK is not installed (pip install lighter-sdk==1.1.2)")

    signer = lighter.SignerClient(
        url=host,
        account_index=account,
        api_private_keys={api_key_index: key},
        chain_id=CHAIN_ID,
    )
    err = signer.check_client()
    if err:
        sys.exit(f"check_client failed: {err}")

    done, failed = 0, []
    for p in plan:
        try:
            res = await signer.update_leverage(
                market_index=p["market_id"],
                margin_mode=signer.CROSS_MARGIN_MODE,
                leverage=p["leverage"],
                api_key_index=api_key_index,
            )
            # the SDK returns the error LAST and never raises it
            if isinstance(res, tuple) and res[-1]:
                raise RuntimeError(str(res[-1]))
            done += 1
            print(f"  ok  {p['symbol']:<10} {p['leverage']}x")
        except Exception as e:  # noqa: BLE001 — one bad market must not abandon the rest
            failed.append((p["symbol"], str(e)))
            print(f"  FAIL {p['symbol']:<10} {e}")

    print(f"\n{done}/{len(plan)} markets set")
    if failed:
        # A market left at its old leverage is not a silent problem: position.js would size a slot
        # for margin the account does not have there and the order would be rejected at send time.
        print("STILL AT THEIR OLD LEVERAGE - re-run, or the fly's orders in these will be refused:")
        for sym, e in failed:
            print(f"  {sym}: {e}")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
