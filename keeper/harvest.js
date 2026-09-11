#!/usr/bin/env node
/**
 * Creator fees -> the fly's trading account. The only code in this repo that moves money on chain.
 *
 *   node keeper/harvest.js                    DRY: say exactly what it would do
 *   PRIVATE_KEY=0x.. node keeper/harvest.js --broadcast --arm-harvest
 *   PRIVATE_KEY=0x.. node keeper/harvest.js --broadcast --arm-harvest --arm-fund
 *
 * IT LIVES IN keeper/ AND NOT IN trader/ FOR A REASON. The core reads the sink directory's source
 * and refuses a sink that constructs its own chain client -- a client a sink built itself is the one
 * network path a fake chain cannot intercept, and therefore the one with no test behind it. This is
 * an operator script that signs, not sink runtime, so it belongs beside the keeper. The guard caught
 * it in the wrong folder the first time it was run.
 *
 * SAFETY, and every one of these is independent on purpose:
 *   * nothing sends without --broadcast
 *   * LEG A (harvest) additionally needs --arm-harvest
 *   * LEG B (swap + deposit) additionally needs --arm-fund
 *   Arming the harvest must never arm the deposit. They touch different assets and different
 *   contracts, and the first one is recoverable while the second one leaves the chain.
 *
 * PRIVATE_KEY MUST BE THE TOKEN'S creatorFeeRecipient. sweepFees is gated to that address and
 * escrow.claim() pays whoever it is; any other key simply reverts.
 *
 * ── LEG A · HARVEST (native ETH) ────────────────────────────────────────────────────────────
 *   1. curve.sweepFees(0)   moves fees from the curve into the escrow's credit for the recipient.
 *      Reverts AlreadyGraduated() once the token has graduated, which is NORMAL and swallowed.
 *   2. escrow.claim()       pays the credit out as native ETH.
 *   A reverting sweep must never abort the claim: they are separate transactions and separate
 *   try/catch, because the failure mode that matters is fees sitting claimable and unclaimed.
 *
 * ── LEG B · FUND LIGHTER (USDG margin) ──────────────────────────────────────────────────────
 *   Fees arrive as native ETH and Lighter margin is USDG, so: wrap ETH->WETH, swap WETH->USDG on
 *   the 1bp v3 pool with a QuoterV2-derived floor, approve, and deposit into the ZkLighter proxy.
 *
 * EVERY ADDRESS BELOW WAS READ FROM THE CHAIN BY THIS REPO, NOT COPIED FROM A DOCUMENT.
 * USDG answers symbol()=USDG decimals()=6; WETH answers symbol()=WETH decimals()=18; the pool
 * answers token0=WETH token1=USDG fee=100; and the deposit proxy is a proxy, so its 1,367 bytes
 * contain no selector at all — the EIP-1967 implementation slot points at
 * 0x82de5b1161c93afdfe21ba0d5343f01cd7401d90, whose 23,168 bytes DO contain deposit's 0x8a857083.
 * Checking the proxy alone would have said the function did not exist.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {
  createWalletClient, createPublicClient, http, defineChain, formatEther, formatUnits, parseEther,
} = require('viem');
const { privateKeyToAccount } = require('viem/accounts');

const has = (n) => process.argv.includes(`--${n}`);
const BROADCAST = has('broadcast');

// ── verified on 4663 ────────────────────────────────────────────────────────────────────────
const ADDR = {
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',          // symbol()=USDG decimals()=6
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',          // symbol()=WETH decimals()=18
  swapRouter02: '0xCaf681a66D020601342297493863E78C959E5cb2',
  quoterV2: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',
  zkLighter: '0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d',     // proxy -> 0x82de5b11…1d90
};
const POOL_FEE = 100;          // the 1bp tier; USDG is a dollar stable so this is the deep one
const ASSET_USDG = 3;          // Lighter asset index
const ROUTE_PERP = 0;
const MIN_DEPOSIT_USDG = 1.0;  // Lighter refuses less; smaller harvests accumulate instead

const curveAbi = [
  { name: 'sweepFees', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }], outputs: [] },
  { name: 'graduated', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
];
const escrowAbi = [
  { name: 'claim', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
];
const erc20Abi = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
];
const wethAbi = [{ name: 'deposit', type: 'function', stateMutability: 'payable', inputs: [], outputs: [] }, ...erc20Abi];
const routerAbi = [{
  name: 'exactInputSingle', type: 'function', stateMutability: 'payable',
  inputs: [{ type: 'tuple', name: 'params', components: [
    { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
    { name: 'fee', type: 'uint24' }, { name: 'recipient', type: 'address' },
    { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMinimum', type: 'uint256' },
    { name: 'sqrtPriceLimitX96', type: 'uint160' }] }],
  outputs: [{ name: 'amountOut', type: 'uint256' }],
}];
const quoterAbi = [{
  name: 'quoteExactInputSingle', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ type: 'tuple', name: 'params', components: [
    { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' }, { name: 'fee', type: 'uint24' },
    { name: 'sqrtPriceLimitX96', type: 'uint160' }] }],
  outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'sqrtPriceX96After', type: 'uint160' },
            { name: 'initializedTicksCrossed', type: 'uint32' }, { name: 'gasEstimate', type: 'uint256' }],
}];
const zkLighterAbi = [{
  name: 'deposit', type: 'function', stateMutability: 'payable', outputs: [],
  inputs: [{ name: '_to', type: 'address' }, { name: '_assetIndex', type: 'uint16' },
           { name: '_routeType', type: 'uint8' }, { name: '_amount', type: 'uint256' }],
}];

function loadConfig() {
  const live = path.join(__dirname, 'config.json');
  return JSON.parse(fs.readFileSync(fs.existsSync(live) ? live : path.join(__dirname, 'config.example.json'), 'utf8'));
}

const log = (...a) => console.log(...a);
const short = (e) => (e.shortMessage || e.message || String(e)).split('\n')[0];

(async () => {
  const cfg = loadConfig();
  const chain = defineChain({
    id: cfg.chain.id, name: cfg.chain.name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [cfg.chain.rpc] } },
  });
  const pc = createPublicClient({ chain, transport: http(cfg.chain.rpc) });

  const key = (process.env.PRIVATE_KEY || '').trim();
  if (!key) { log('no PRIVATE_KEY — read-only. Set it to harvest.'); }
  const account = key ? privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`) : null;
  const wc = account ? createWalletClient({ account, chain, transport: http(cfg.chain.rpc) }) : null;
  const me = account ? account.address : (cfg.feeWallet && cfg.feeWallet.address);
  if (!me || /^0x0+$/.test(me)) { log('no fee wallet — set feeWallet.address or PRIVATE_KEY'); process.exit(1); }

  log(`fee wallet ${me}`);
  log(`${BROADCAST ? 'BROADCAST' : 'DRY RUN'} · harvest ${has('arm-harvest') ? 'ARMED' : 'disarmed'} · fund ${has('arm-fund') ? 'ARMED' : 'disarmed'}\n`);

  const send = async (label, req) => {
    if (!BROADCAST) { log(`  [dry] would ${label}`); return null; }
    const hash = await wc.writeContract(req);
    log(`  sent ${label} · ${hash}`);
    const r = await pc.waitForTransactionReceipt({ hash });
    log(`  ${r.status === 'success' ? 'confirmed' : 'REVERTED'} in block ${r.blockNumber}`);
    return r;
  };

  // ── LEG A ─────────────────────────────────────────────────────────────────────────────────
  const curve = cfg.token && cfg.token.curve;
  const escrow = cfg.pons && cfg.pons.escrow;
  log('LEG A · harvest');

  if (!curve || /^0x0+$/.test(curve)) {
    log('  no curve address yet — nothing has launched');
  } else if (!has('arm-harvest')) {
    log('  disarmed (pass --arm-harvest)');
  } else {
    // 1. sweep. A graduated curve reverts and that is expected, never fatal.
    try {
      await send('curve.sweepFees(0)', { address: curve, abi: curveAbi, functionName: 'sweepFees', args: [0n] });
    } catch (e) {
      log(`  sweepFees did not go through (continuing to the claim): ${short(e)}`);
    }
    // 2. claim, but only if there is credit — claim() on zero reverts NoBalance()
    try {
      const credit = await pc.readContract({ address: escrow, abi: escrowAbi, functionName: 'balanceOf', args: [me] });
      log(`  escrow credit: ${formatEther(credit)} ETH`);
      if (credit > 0n) await send('escrow.claim()', { address: escrow, abi: escrowAbi, functionName: 'claim', args: [] });
      else log('  nothing to claim');
    } catch (e) {
      log(`  claim failed: ${short(e)}`);
    }
  }

  // ── LEG B ─────────────────────────────────────────────────────────────────────────────────
  log('\nLEG B · fund the Lighter account');
  const owner = (cfg.fly && cfg.fly.deposit && cfg.fly.deposit.accountOwner) || me;
  const gasReserve = parseEther(String((cfg.distribute && cfg.distribute.gasReserveEth) || 0.02));
  const slippageBps = BigInt((cfg.fly && cfg.fly.deposit && cfg.fly.deposit.slippageBps) || 100);

  const bal = await pc.getBalance({ address: me });
  log(`  native balance ${formatEther(bal)} ETH, gas reserve ${formatEther(gasReserve)} ETH`);

  if (!has('arm-fund')) {
    log('  disarmed (pass --arm-fund)');
  } else if (bal <= gasReserve) {
    log('  nothing above the gas reserve to swap');
  } else {
    const wrapAmt = bal - gasReserve;
    log(`  would wrap ${formatEther(wrapAmt)} ETH`);
    try {
      await send(`weth.deposit() with ${formatEther(wrapAmt)} ETH`,
        { address: ADDR.weth, abi: wethAbi, functionName: 'deposit', args: [], value: wrapAmt });

      const wethBal = BROADCAST
        ? await pc.readContract({ address: ADDR.weth, abi: erc20Abi, functionName: 'balanceOf', args: [me] })
        : wrapAmt;

      // a floor from the quoter, in the same breath as the swap
      const { result } = await pc.simulateContract({
        address: ADDR.quoterV2, abi: quoterAbi, functionName: 'quoteExactInputSingle',
        args: [{ tokenIn: ADDR.weth, tokenOut: ADDR.usdg, amountIn: wethBal, fee: POOL_FEE, sqrtPriceLimitX96: 0n }],
        account: me,
      });
      const quoted = result[0];
      const minOut = quoted - (quoted * slippageBps) / 10000n;
      log(`  quote ${formatUnits(quoted, 6)} USDG, floor ${formatUnits(minOut, 6)} (${slippageBps}bps)`);

      await send('approve WETH to the router',
        { address: ADDR.weth, abi: erc20Abi, functionName: 'approve', args: [ADDR.swapRouter02, wethBal] });
      await send('exactInputSingle WETH->USDG',
        { address: ADDR.swapRouter02, abi: routerAbi, functionName: 'exactInputSingle',
          args: [{ tokenIn: ADDR.weth, tokenOut: ADDR.usdg, fee: POOL_FEE, recipient: me,
                   amountIn: wethBal, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] });

      const usdg = BROADCAST
        ? await pc.readContract({ address: ADDR.usdg, abi: erc20Abi, functionName: 'balanceOf', args: [me] })
        : quoted;
      const minDep = BigInt(Math.round(MIN_DEPOSIT_USDG * 1e6));
      log(`  USDG balance ${formatUnits(usdg, 6)}`);
      if (usdg < minDep) {
        log(`  under Lighter's ${MIN_DEPOSIT_USDG} USDG minimum — holding to accumulate rather than losing it`);
      } else {
        await send('approve USDG to the deposit proxy',
          { address: ADDR.usdg, abi: erc20Abi, functionName: 'approve', args: [ADDR.zkLighter, usdg] });
        await send(`deposit(_to=${owner}, asset=${ASSET_USDG}, route=${ROUTE_PERP}, ${formatUnits(usdg, 6)} USDG)`,
          { address: ADDR.zkLighter, abi: zkLighterAbi, functionName: 'deposit',
            args: [owner, ASSET_USDG, ROUTE_PERP, usdg] });
      }
    } catch (e) {
      log(`  leg B stopped: ${short(e)}`);
      process.exitCode = 1;
    }
  }

  log(`\n${BROADCAST ? 'done' : 'dry run — nothing was sent'}`);
})().catch((e) => { console.error('failed:', short(e)); process.exitCode = 1; });
