#!/usr/bin/env node
/**
 * Make a fresh wallet for the fee keeper. Prints it once. Writes nothing, anywhere.
 *
 *   node keeper/keygen.js
 *
 * WHAT THIS WALLET IS. It becomes the token's `creatorFeeRecipient`, which makes it the only address
 * that can harvest: `curve.sweepFees()` is gated to the recipient and `escrow.claim()` pays whoever
 * that recipient is. Any other key simply reverts. Its address goes in two places and they must
 * match exactly — `feeWallet.address` in keeper/config.json, and the recipient baked into the launch
 * call, which is IMMUTABLE. Get it wrong at launch and the fees are permanently unclaimable.
 *
 * WHY A FRESH ONE, AND NOT A WALLET YOU ALREADY HAVE:
 *
 *   - It holds a gas float and runs unattended for months. A key that lives in a long-running
 *     process's environment should not also be a key that holds anything you care about.
 *   - It is PUBLIC by construction. The recipient is visible in the launch calldata forever, so
 *     anyone can see everything this address has ever done. Reusing a wallet links the two.
 *   - It never needs to hold value. Fees pass through it: harvested, swapped, deposited to the
 *     exchange in the same pass. What sits here is gas and change.
 *
 * THE KEY IS PRINTED ONCE AND NEVER STORED. Nothing in this repo writes a private key to disk, and
 * that is deliberate: `keeper/config.json` is gitignored for the account index alone, and a key in a
 * config file is a key in a backup, in an editor's recent files, and eventually in a paste. Put it
 * in the environment of the shell that runs the harvester and nowhere else.
 */
'use strict';

const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');

const key = generatePrivateKey();
const account = privateKeyToAccount(key);

const line = '─'.repeat(78);
console.log(`\n${line}`);
console.log('  A NEW FEE WALLET. This is the only time the key is shown.');
console.log(line);
console.log(`\n  address      ${account.address}`);
console.log(`  private key  ${key}\n`);
console.log(line);
console.log('  WHAT TO DO WITH EACH:');
console.log(line);
console.log(`
  The ADDRESS is public. Put it in keeper/config.json:

      "feeWallet": { "address": "${account.address}" }

  and use the same address as the creator fee recipient at launch. They must match,
  and the launch one cannot be changed afterwards.

  The PRIVATE KEY goes in the environment of the shell that runs the harvester, and
  nowhere else — not in a config file, not in this repo, not in a note:

      set PRIVATE_KEY=${key}
      node keeper/harvest.js --loop --broadcast --arm-harvest --arm-fund

  Then send this address a little ETH on chain 4663 for gas. The harvester keeps
  0.02 ETH back and never swaps below it, so fund it with more than that.

  Nothing was written to disk. If you lose this key the fees are unrecoverable,
  because the recipient baked into the launch cannot be changed.
`);
