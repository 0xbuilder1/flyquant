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

RATE LIMITED, AND IT HAS TO BE. Lighter allows 40 signed requests per 60 seconds PER L1 ADDRESS,
and 57 markets sent as fast as the loop can manage blows through that at about market 40 -- which is
exactly what happened the first time this ran, with everything from XAU onward coming back 23000
"Too Many Requests". So sends are spaced, 429s are retried with a widening wait, and -- the part that
actually matters after a partial run -- MARKETS ALREADY AT THE RIGHT LEVERAGE ARE SKIPPED. Re-running
is cheap and finishes the job rather than starting it again.

    LIGHTER_API_KEY=...  python keeper/set-leverage.py            # show what it would do
    LIGHTER_API_KEY=...  python keeper/set-leverage.py --arm      # actually send it
    LIGHTER_API_KEY=...  python keeper/set-leverage.py --arm      # again: only what is still missing

No key is read from anywhere but the environment, and none is printed.
"""
import argparse
import asyncio
import json
import os
import sys
import time
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


def already_set(host, account):
    """
    market_id -> the leverage the account is ALREADY carrying there.

    The account reports initial_margin_fraction as a percentage ("10.00" is 10%, so 10x) while the
    API takes hundredths of a percent (1000). Two units for one quantity, so this converts once, here.
    A market the account has never touched simply does not appear, which reads as "not set".
    """
    try:
        url = f"{host}/api/v1/account?by=index&value={account}"
        with urllib.request.urlopen(url, timeout=20) as r:
            body = json.load(r)
        acc = (body.get("accounts") or [body])[0]
        out = {}
        for pos in acc.get("positions") or []:
            if not int(pos.get("margin_set_flag") or 0):
                continue
            imf = float(pos.get("initial_margin_fraction") or 0)
            if imf > 0:
                out[int(pos["market_id"])] = 100.0 / imf
        return out
    except Exception as e:  # noqa: BLE001
        print(f"  (could not read what is already set: {e} -- will try every market)")
        return {}


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arm", action="store_true", help="send the transactions (default is a dry run)")
    ap.add_argument("--only", help="one symbol, for trying it on a single market first")
    args = ap.parse_args()

    cfg = load_config()
    host = cfg["lighter"]["host"]
    account = int(cfg["lighter"]["accountIndex"])
    api_key_index = int(cfg["lighter"]["apiKeyIndex"])
    # THE EXCHANGE SETTING, not the sizing one. They are different numbers on purpose:
    # cross margin liquidates on maintenance margin, which follows NOTIONAL, so this value
    # never moves a liquidation price -- it only decides how much initial margin a position
    # locks. Pushing it high while sizing lower is free headroom. See the note in config.
    lv = cfg["lighter"].get("exchangeLeverage")
    wanted = float(lv if lv is not None else (cfg["trade"]["exposure"].get("leverage") or 1))
    sizing = float(cfg["trade"]["exposure"].get("leverage") or 1)

    if wanted <= 1:
        sys.exit("lighter.exchangeLeverage is 1 -- nothing to set. Raise it in config first.")

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
    print(f"  positions are still SIZED at {sizing:g}x -- this setting only frees initial margin,")
    print(f"  it does not move any liquidation price")
    if clamped:
        print(f"  {len(clamped)} markets cap below that and get their own maximum:")
        for p in clamped:
            print(f"    {p['symbol']:<10} {p['leverage']}x")
    # ── SKIP WHAT IS ALREADY RIGHT ─────────────────────────────────────────────────────────────
    # Checked before the dry run returns, so "how much is left after that partial run" is a question
    # you can ask without sending anything.
    have = already_set(host, account)
    todo = [p for p in plan if abs(have.get(p["market_id"], 0) - p["leverage"]) > 0.01]
    skipped = len(plan) - len(todo)
    if skipped:
        print(f"\n  {skipped} markets are already at the right leverage and are skipped")

    if not args.arm:
        print(f"\nDRY RUN - nothing sent. {len(todo)} markets still to set; re-run with --arm.")
        return

    if not todo:
        print("  nothing left to do")
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

    # 40 signed requests per 60 seconds per L1 address. 1.7s apart is about 35/minute, which leaves
    # room for the retries below without tripping the limit again.
    GAP = 1.7
    eta = len(todo) * GAP
    print(f"  {len(todo)} to send, {GAP}s apart to stay inside the rate limit -- about {eta / 60:.1f} min\n")

    done, failed = 0, []
    for k, p in enumerate(todo):
        if k:
            time.sleep(GAP)
        wait = 20.0
        for attempt in range(4):
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
                print(f"  ok  {p['symbol']:<10} {p['leverage']}x   ({done}/{len(todo)})")
                break
            except Exception as e:  # noqa: BLE001 — one bad market must not abandon the rest
                msg = str(e)
                rate_limited = "23000" in msg or "Too Many Requests" in msg or "429" in msg
                if rate_limited and attempt < 3:
                    print(f"  ..  {p['symbol']:<10} rate limited, waiting {wait:.0f}s")
                    time.sleep(wait)
                    wait *= 2
                    continue
                # keep the reason to one line; the SDK prints an entire HTTP response otherwise
                failed.append((p["symbol"], msg.splitlines()[0][:120]))
                print(f"  FAIL {p['symbol']:<10} {msg.splitlines()[0][:90]}")
                break

    print(f"\n{done}/{len(todo)} markets set")
    if failed:
        # A market left at its old leverage is not a silent problem: position.js would size a slot
        # for margin the account does not have there and the order would be rejected at send time.
        print("STILL AT THEIR OLD LEVERAGE. Re-run the same command -- it skips everything that")
        print("already went through and only retries these:")
        for sym, e in failed:
            print(f"  {sym}: {e}")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
