// Off-chain mirror of contracts/JITOptimizer.sol. Computes the profit-maximizing JIT
// injection `hintA` to pass into SwapRouter.swapWithHint. Every operation uses BigInt and
// integer (floor) division in the SAME order as the Solidity library, so the hint this
// produces is bit-for-bit what verifyInjection re-checks on-chain — no rounding drift.
//
// This is the expensive half of the off-chain-compute / on-chain-verify split: the ternary
// search runs here (free, off-chain) and the contract only verifies the single result.

const FEE_BPS = 30n;
const BPS_DENOM = 10_000n;
const SEARCH_ITERS = 256n;

// Mirror of JITOptimizer.swapOut.
function swapOut(amountIn, reserveIn, reserveOut) {
  if (amountIn === 0n || reserveIn === 0n || reserveOut === 0n) return 0n;
  const inWithFee = amountIn * (BPS_DENOM - FEE_BPS);
  return (inWithFee * reserveOut) / (reserveIn * BPS_DENOM + inWithFee);
}

// Mirror of JITOptimizer.pnlScaled. Returns PnL scaled by reserveIn, in output-token units.
function pnlScaled(a, amountIn, reserveIn, reserveOut) {
  if (a === 0n) return 0n;
  const aOut = (a * reserveOut) / reserveIn;
  const rin1 = reserveIn + a;
  const rout1 = reserveOut + aOut;

  const out = swapOut(amountIn, rin1, rout1);
  const rin2 = rin1 + amountIn;
  const rout2 = rout1 - out;

  const wIn = (a * rin2) / rin1;
  const wOut = (a * rout2) / rin1;

  const gained = wOut * reserveIn + wIn * reserveOut;
  const spent = 2n * a * reserveOut;
  return gained - spent;
}

// Mirror of JITOptimizer.optimalInjection. Returns { hintA, pnl } where hintA is the
// injection (input token) to pass to swapWithHint. Returns hintA = 0n when no profitable
// injection exists within the vault's capital.
function optimalInjection(amountIn, reserveIn, reserveOut, maxIn, maxOut) {
  amountIn = BigInt(amountIn);
  reserveIn = BigInt(reserveIn);
  reserveOut = BigInt(reserveOut);
  maxIn = BigInt(maxIn);
  maxOut = BigInt(maxOut);

  if (amountIn === 0n || reserveIn === 0n || reserveOut === 0n) return { hintA: 0n, pnl: 0n };

  let hi = maxIn;
  const capFromOut = (maxOut * reserveIn) / reserveOut;
  if (capFromOut < hi) hi = capFromOut;
  if (hi === 0n) return { hintA: 0n, pnl: 0n };

  let lo = 0n;
  for (let i = 0n; i < SEARCH_ITERS && hi > lo + 1n; i++) {
    const m1 = lo + (hi - lo) / 3n;
    const m2 = hi - (hi - lo) / 3n;
    if (pnlScaled(m1, amountIn, reserveIn, reserveOut)
        < pnlScaled(m2, amountIn, reserveIn, reserveOut)) {
      lo = m1;
    } else {
      hi = m2;
    }
  }

  let hintA = 0n;
  let pnl = 0n;
  for (let a = lo; a <= hi; a++) {
    const p = pnlScaled(a, amountIn, reserveIn, reserveOut);
    if (p > pnl) {
      pnl = p;
      hintA = a;
    }
  }
  return { hintA, pnl };
}

// UMD-ish export: works as a CommonJS module (tests/scripts) and attaches to window (browser).
const api = { swapOut, pnlScaled, optimalInjection };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.JITOptimizerOffchain = api;
