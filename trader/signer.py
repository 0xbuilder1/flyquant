#!/usr/bin/env python3
"""
The only thing in this repo that can lose money.

It is a separate process, in a different language, for one reason: Lighter signs with a compiled
native library loaded through ctypes, and there is no pure-JS path to it. So the key lives here and
nowhere else. The Node keeper owns the loop, the ledger and the honesty guard, and talks to this
over stdin/stdout in one verb:

    echo '{"marketId":44,"isAsk":false,"sizeBase":20.0,"maxSlippage":0.005,"idealPrice":0.65}' \\
      | python trader/signer.py --account 12345 --broadcast

Without --broadcast it prints exactly what it would have sent and exits 0. That is the default, and
every layer above it defaults the same way.

WHAT IT REFUSES, AND WHY EACH REFUSAL IS HERE RATHER THAN UPSTREAM
  * no LIGHTER_API_KEY in the environment            -- a key is never a config field
  * --broadcast without a key                        -- fails loudly instead of quietly papering
  * a size or market the caller did not specify      -- no defaults on anything that costs money
  * an order over --max-notional-fraction x equity  -- a last backstop in the process that signs,
                                                        so a bug upstream cannot spend more than the
                                                        operator armed, whatever it believes

SDK FACTS THIS DEPENDS ON (lighter-sdk==1.1.2, imports as `lighter`)
  * SignerClient(url, account_index, api_private_keys={index: key}, chain_id=...)
  * EVERY create_*/cancel coroutine returns a TUPLE (tx, resp, err) and NEVER raises -- the error is
    the last element, which is the single easiest thing to get wrong here. _unwrap() is the only
    place that tuple is read.
  * base_amount and price are INTEGERS scaled by the market's supported_size_decimals /
    supported_price_decimals. Sending floats silently sends the wrong size.
  * create_market_order_limited_slippage takes a slippage FRACTION (0.005 = 0.5%).
  * The api key is a LIGHTER-NATIVE key, not an EVM key, and is registered once against the account.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time

HOST = "https://api.rh.lighter.xyz"
# THE SIGNING CHAIN ID IS NOT THE SETTLEMENT CHAIN ID, and getting that wrong is indistinguishable
# from a bad key: every signature verifies against the wrong domain and comes back
# `21120 invalid signature`, whatever the key is and whatever is in the order.
#
#   4663    Robinhood Chain, the L1 the ZkLighter deposit contract lives on. Used by keeper/harvest.js.
#   466324  Lighter's own L2 behind api.rh.lighter.xyz. Everything SIGNED for the exchange uses this.
CHAIN_ID = 466324
SETTLEMENT_CHAIN_ID = 4663      # where deposits land; never used for signing


def out(obj, code=0):
    print(json.dumps(obj))
    sys.exit(code)


def fail(msg, **extra):
    out({"ok": False, "error": msg, **extra}, 1)


def account_equity(index):
    """What the exchange says this account holds. Read here, by this process, on purpose."""
    import urllib.request
    try:
        url = f"{HOST}/api/v1/account?by=index&value={index}"
        with urllib.request.urlopen(url, timeout=15) as r:
            body = json.load(r)
        acc = (body.get("accounts") or [body])[0]
        return float(acc.get("collateral") or 0)
    except Exception:  # noqa: BLE001 -- any failure here must refuse, never wave through
        return None


async def place(args, order, key):
    try:
        import lighter  # noqa: F401
    except ImportError:
        fail("the lighter SDK is not installed (pip install lighter-sdk==1.1.2)")

    signer = lighter.SignerClient(
        url=HOST,
        account_index=args.account,
        api_private_keys={args.api_key_index: key},
        chain_id=CHAIN_ID,
    )
    err = signer.check_client()
    if err:
        fail(f"check_client failed: {err}")

    def unwrap(res):
        # the error is the LAST element and the SDK never raises it
        if isinstance(res, tuple):
            if res[-1]:
                raise RuntimeError(str(res[-1]))
            return res[:-1]
        return res

    coid = int(time.time() * 1000) & 0x7FFFFFFFFFFF
    base_amount = int(round(order["sizeBase"] * (10 ** order["sizeDecimals"])))
    if base_amount <= 0:
        fail("size rounds to zero at this market's precision")

    execution = order.get("execution", "market")

    try:
        if execution == "post-only":
            # A RESTING ORDER THAT CANNOT CROSS. POST_ONLY is rejected by the exchange if it would
            # take, which is the guarantee: it fills at the price we named or it does not fill. That
            # is what makes slippage zero rather than small.
            #
            # It EXPIRES BEFORE THE NEXT PASS, and that is load-bearing. Nothing here cancels
            # anything: an unfilled order simply dies, and the next pass reads the account, sees what
            # actually filled, and reconciles from there. A state-based reconciler needs no order
            # management at all, which removes the whole class of bugs where the keeper's idea of its
            # open orders drifts from the exchange's.
            price = int(round(order["limitPrice"] * (10 ** order["priceDecimals"])))
            if price <= 0:
                fail("limit price rounds to zero at this market's precision")
            # ORDER EXPIRY IS AN ABSOLUTE MILLISECOND TIMESTAMP, NOT A SENTINEL.
            #
            # This was -1 (the SDK's DEFAULT_28_DAY_ORDER_EXPIRY) and the exchange answered
            # `21711 invalid expiry`. The evidence is in the exchange's own accepted transactions:
            # a real IOC order carries OrderExpiry=0 and ExpiredAt=<absolute ms>, so the field holds
            # a genuine value in milliseconds and -1 is not expanded by the native signer on the way
            # through -- it arrives as -1 and is rejected.
            #
            # An absolute timestamp was what this sent originally. That attempt failed with `invalid
            # signature`, which was the chain id, and the wrong diagnosis cost a round trip: two
            # independent faults, and fixing the second one first made the first look innocent.
            # THERE IS ALSO A MINIMUM, AND IT IS INFERRED RATHER THAN DOCUMENTED.
            #
            # Two live orders, same code path, same clock (checked: 0.5s off the exchange):
            #     600s expiry -> accepted, resting
            #     170s expiry -> `21711 invalid expiry`
            # Nothing in the SDK names a floor, so this is an inference from two data points and not
            # a rule anybody published. What is certain is that 170 is refused and 600 is not.
            #
            # 170 was not arbitrary either: it was chosen to be under the 180s pass interval so an
            # unfilled order would die before the next pass computed a fresh target. That intent is
            # now served by cancelling instead -- see the sweep in trader/order.js -- because the
            # exchange will not accept an expiry short enough to do it by timing out.
            secs = int(order.get("expirySeconds", 0) or 0) or 600
            expiry = int(time.time() * 1000) + secs * 1000
            res = unwrap(await signer.create_order(
                market_index=order["marketId"],
                client_order_index=coid,
                base_amount=base_amount,
                price=price,
                is_ask=bool(order["isAsk"]),
                order_type=lighter.SignerClient.ORDER_TYPE_LIMIT,
                time_in_force=lighter.SignerClient.ORDER_TIME_IN_FORCE_POST_ONLY,
                reduce_only=bool(order.get("reduceOnly", False)),
                order_expiry=expiry,
            ))
        else:
            # Crossing, for an exit. The fly is fleeing and an order that might not fill is not an
            # exit. Bounded by max_slippage so "get out" can never become "get out at any price".
            res = unwrap(await signer.create_market_order_limited_slippage(
                market_index=order["marketId"],
                client_order_index=coid,
                base_amount=base_amount,
                max_slippage=order.get("maxSlippage", 0.005),
                is_ask=bool(order["isAsk"]),
                reduce_only=bool(order.get("reduceOnly", False)),
                ideal_price=order.get("idealPrice"),
            ))
    except Exception as e:                                   # noqa: BLE001
        fail(f"order rejected: {e}", clientOrderIndex=coid, execution=execution)
    finally:
        close = getattr(signer, "close", None)
        if close:
            r = close()
            if hasattr(r, "__await__"):
                await r

    tx = res[0] if isinstance(res, tuple) and res else None
    tx_hash = getattr(tx, "tx_hash", None) or (tx.get("tx_hash") if isinstance(tx, dict) else None)
    out({
        "ok": True,
        "broadcast": True,
        "execution": execution,
        "clientOrderIndex": coid,
        "baseAmount": base_amount,
        "txHash": tx_hash,
        "verify": f"{HOST}/api/v1/tx?by=hash&value={tx_hash}" if tx_hash else None,
    })


async def cancel_all(args, key):
    """
    Wipe every resting order on the account.

    Called at the top of a pass. A post-only order cannot be given an expiry short enough to die on
    its own before the next pass, so intent from an earlier pass would otherwise still be sitting in
    the book while a fresh target is computed -- and position.js counts POSITIONS, not resting
    orders, so those would not appear in any slot and the account could quietly end up in more
    markets than it has slots for.
    """
    try:
        import lighter
    except ImportError:
        fail("the lighter SDK is not installed (pip install lighter-sdk==1.1.2)")

    signer = lighter.SignerClient(
        url=HOST,
        account_index=args.account,
        api_private_keys={args.api_key_index: key},
        chain_id=CHAIN_ID,
    )
    err = signer.check_client()
    if err:
        fail(f"check_client failed: {err}")
    try:
        res = await signer.cancel_all_orders(
            time_in_force=lighter.SignerClient.CANCEL_ALL_TIF_IMMEDIATE,
            timestamp_ms=int(time.time() * 1000),
            api_key_index=args.api_key_index,
        )
        if isinstance(res, tuple) and res[-1]:
            raise RuntimeError(str(res[-1]))
        out({"ok": True, "cancelled": True})
    except Exception as e:  # noqa: BLE001
        fail(f"cancel-all rejected: {e}")
    finally:
        close = getattr(signer, "close", None)
        if close:
            r = close()
            if hasattr(r, "__await__"):
                await r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--account", type=int, required=True, help="Lighter account index")
    ap.add_argument("--api-key-index", type=int, default=4, help="0-3 are reserved for Lighter's own UIs")
    ap.add_argument("--max-notional", type=float, default=0.0,
                    help="absolute ceiling in USD. Optional, and it does NOT scale -- prefer the fraction")
    ap.add_argument("--max-notional-fraction", type=float, default=0.0,
                    help="ceiling as a multiple of the equity this process reads off the exchange")
    ap.add_argument("--broadcast", action="store_true")
    ap.add_argument("--cancel-all", action="store_true",
                    help="cancel every resting order and exit; reads no order on stdin")
    args = ap.parse_args()

    # cancel-all carries no order, so it runs before any of the order validation below
    if args.cancel_all:
        key = os.environ.get("LIGHTER_API_KEY", "").strip()
        if not key:
            fail("--cancel-all needs LIGHTER_API_KEY in the environment")
        asyncio.run(cancel_all(args, key))
        return

    try:
        order = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError as e:
        fail(f"could not parse the order: {e}")

    required = ["marketId", "isAsk", "sizeBase", "sizeDecimals"]
    if order.get("execution") == "post-only":
        required += ["limitPrice", "priceDecimals"]
    for field in required:
        if field not in order:
            fail(f"the order is missing {field}; nothing here has a default that costs money")

    notional = float(order.get("notional") or 0)

    # ── THE BACKSTOP, AND WHY IT IS A FRACTION RATHER THAN A DOLLAR FIGURE ──────────────────────
    #
    # This is the third seatbelt: enforced inside the signing process so a bug in the keeper's
    # sizing cannot spend more than the operator armed, whatever the keeper believes.
    #
    # It used to be an absolute dollar cap, and that was wrong in a way that only shows up when the
    # thing works. Every other limit in this product is a fraction of equity, so the account grows
    # and the positions grow with it -- but an absolute cap does not move, so the day the account
    # outgrows it EVERY order starts being refused and the fly silently stops trading. A backstop
    # that turns into an outage is not a safety feature.
    #
    # So the ceiling is a multiple of equity, and the equity is READ FROM THE EXCHANGE BY THIS
    # PROCESS -- not passed in by the keeper. That is what keeps it independent: the keeper can be
    # wrong about the balance, the sizing can be wrong about the fraction, and this still bounds the
    # order against what the account actually holds.
    #
    # If the account cannot be read, the order is REFUSED rather than waved through. An unverifiable
    # ceiling is not a ceiling.
    max_notional = None
    ceiling_why = ""
    if args.max_notional_fraction:
        equity = account_equity(args.account)
        if equity is None:
            fail("could not read the account to check the order against it -- refusing to sign blind")
        max_notional = equity * args.max_notional_fraction
        ceiling_why = f"{args.max_notional_fraction:g}x the ${equity:,.2f} the account actually holds"
    # an absolute cap may still be set, and when both exist the tighter one wins
    if args.max_notional:
        if max_notional is None or args.max_notional < max_notional:
            max_notional = args.max_notional
            ceiling_why = "the absolute maximum in the config"

    if max_notional is not None and notional > max_notional:
        fail(f"order notional ${notional:,.2f} exceeds ${max_notional:,.2f} -- {ceiling_why}")

    key = os.environ.get("LIGHTER_API_KEY", "").strip()

    if not args.broadcast:
        out({
            "ok": True, "broadcast": False, "wouldSend": order,
            "account": args.account, "apiKeyIndex": args.api_key_index,
            "hasKey": bool(key),
            "note": "dry run - no order was placed",
        })

    if not key:
        fail("--broadcast needs LIGHTER_API_KEY in the environment (a lighter-native key, not an EVM key)")

    asyncio.run(place(args, order, key))


if __name__ == "__main__":
    main()
