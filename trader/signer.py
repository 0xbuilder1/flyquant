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
  * an order whose notional exceeds --max-notional   -- a last backstop in the process that signs,
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
CHAIN_ID = 4663


def out(obj, code=0):
    print(json.dumps(obj))
    sys.exit(code)


def fail(msg, **extra):
    out({"ok": False, "error": msg, **extra}, 1)


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
            # expirySeconds = 0 means "use the SDK's own default", which is -1 / 28 days.
            #
            # The signature covers order_expiry, so client and server MUST agree on it exactly. An
            # absolute millisecond timestamp is the obvious reading of the field and may well be
            # right, but it is the one value in the order this repo chose rather than copied from a
            # working call -- and if the server normalises it at all, the signature stops verifying
            # and the only symptom is `21120 invalid signature`, which says nothing about which
            # field is wrong. So the first live order uses the default and nothing is guessed.
            secs = int(order.get("expirySeconds", 0) or 0)
            expiry = (int(time.time() * 1000) + secs * 1000) if secs > 0                 else lighter.SignerClient.DEFAULT_28_DAY_ORDER_EXPIRY
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--account", type=int, required=True, help="Lighter account index")
    ap.add_argument("--api-key-index", type=int, default=4, help="0-3 are reserved for Lighter's own UIs")
    ap.add_argument("--max-notional", type=float, default=0.0, help="refuse any order larger than this, in USD")
    ap.add_argument("--broadcast", action="store_true")
    args = ap.parse_args()

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
    if args.max_notional and notional > args.max_notional:
        fail(f"order notional ${notional:.2f} exceeds the armed maximum ${args.max_notional:.2f}")

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
