#!/usr/bin/env python3
"""
Why does Lighter say 'invalid signature'? Answer it without sending a key anywhere.

    set LIGHTER_API_KEY=...
    python keeper/check-key.py

`21120 invalid signature` means the transaction was signed with a key whose PUBLIC half is not what
the exchange has registered in the slot the signature claims. There are only a few ways to get there
and this separates them:

  1. the key in the environment belongs to a DIFFERENT slot than config.lighter.apiKeyIndex
  2. register-api-key.py was run more than once, so only the LAST private key it printed works —
     each run generates a fresh pair and overwrites the slot
  3. the key was copied short, or with a stray prefix

Everything here runs locally. The private key is read from the environment, used to derive its own
public half, and compared against what the public API reports. Nothing is transmitted, logged, or
written to disk, and only the first bytes of either key are ever printed.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request

HOST = "https://api.rh.lighter.xyz"
# THE SIGNING CHAIN ID IS NOT THE SETTLEMENT CHAIN ID, and getting that wrong is indistinguishable
# from a bad key: every signature verifies against the wrong domain and comes back
# `21120 invalid signature`, whatever the key is and whatever is in the order.
#
#   4663    Robinhood Chain, the L1 the ZkLighter deposit contract lives on. Used by keeper/harvest.js.
#   466324  Lighter's own L2 behind api.rh.lighter.xyz. Everything SIGNED for the exchange uses this.
CHAIN_ID = 466324
SETTLEMENT_CHAIN_ID = 4663      # where deposits land; never used for signing


def registered(account: int):
    """what the exchange believes, slot by slot"""
    url = f"{HOST}/api/v1/apikeys?account_index={account}"
    req = urllib.request.Request(url, headers={"user-agent": "flyquant/1.0"})
    d = json.load(urllib.request.urlopen(req, timeout=20))
    out = {}
    for k in d.get("api_keys") or []:
        pk = str(k.get("public_key") or "")
        if pk and set(pk) != {"0"}:
            out[int(k.get("api_key_index"))] = pk
    return out


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    cfg = json.load(open(os.path.join(here, "config.json"), encoding="utf-8"))
    account = int(cfg["lighter"]["accountIndex"])
    slot = int(cfg["lighter"]["apiKeyIndex"])

    key = (os.environ.get("LIGHTER_API_KEY") or "").strip()
    if not key:
        sys.exit("LIGHTER_API_KEY is not set in this shell.")

    try:
        import lighter
    except ImportError:
        sys.exit("pip install lighter-sdk==1.1.2")

    print(f"account {account} · config points at slot {slot}")
    print(f"key in environment: {len(key)} chars, starts {key[:10]}...\n")

    on_chain = registered(account)
    if not on_chain:
        sys.exit("nothing is registered on this account at all.")
    for i, pk in sorted(on_chain.items()):
        print(f"  slot {i:<3} registered  {pk[:34]}...")
    print()

    if slot not in on_chain:
        print(f"PROBLEM: config uses slot {slot} and nothing is registered there.")
        print(f"         registered slots are {sorted(on_chain)}.")
        return

    # SignerClient opens an aiohttp session in its constructor, so it can only be built INSIDE a
    # running loop — the first version of this script built it at module level and died with
    # "no running event loop", which looks exactly like a key problem and is not one.
    import asyncio

    async def probe():
        signer = lighter.SignerClient(
            url=HOST, account_index=account,
            api_private_keys={slot: key}, chain_id=CHAIN_ID,
        )
        try:
            err = signer.check_client()
            print(f"check_client(): {err if err else 'no complaint'}")

            # The decisive test. An auth token is signed with the api key and verified by the
            # server against the registered public half — no order, no money, no state change.
            tok, terr = None, None
            try:
                res = signer.create_auth_token_with_expiry(api_key_index=slot)
                tok, terr = (res[0], res[-1]) if isinstance(res, tuple) else (res, None)
            except Exception as e:                           # noqa: BLE001
                terr = str(e)
            return tok, terr
        finally:
            close = getattr(signer, "close", None)
            if close:
                r = close()
                if hasattr(r, "__await__"):
                    await r

    try:
        tok, terr = asyncio.run(probe())
    except Exception as e:                                   # noqa: BLE001
        sys.exit(f"the SDK would not accept this key: {e}")

    if terr or not tok:
        print(f"\nCould not even sign an auth token locally: {terr}")
        return

    req = urllib.request.Request(
        f"{HOST}/api/v1/apikeys?account_index={account}&api_key_index={slot}",
        headers={"user-agent": "flyquant/1.0", "authorization": tok},
    )
    try:
        urllib.request.urlopen(req, timeout=20).read()
        server_ok, why = True, ""
    except Exception as e:                                   # noqa: BLE001
        server_ok, why = False, str(e)[:120]

    print(f"\nserver accepted a signature from this key: {'YES' if server_ok else 'NO'}")
    if not server_ok:
        print(f"  {why}")
        print("\nThe key in your environment is not the one registered in this slot.")
        print("  * if register-api-key.py was run more than once, only the LAST key it printed works")
        print("  * re-run it and copy the key it prints in that same run")
    else:
        print("\nThe key and the slot agree. If an order still says 'invalid signature',")
        print("the problem is in how the order itself is signed, not in the key.")


if __name__ == "__main__":
    main()
