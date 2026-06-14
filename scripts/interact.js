const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { optimalInjection } = require("../frontend/jitOptimizer");

const WAD = 10n ** 18n;

function fmt(wei, digits = 4) {
  const neg = wei < 0n;
  let v = neg ? -wei : wei;
  const whole = v / WAD;
  const frac = (v % WAD).toString().padStart(18, "0").slice(0, digits);
  return (neg ? "-" : "") + whole.toString() + "." + frac;
}

function line() {
  console.log("─".repeat(64));
}

// Exercises every feature of the JIT Liquidity Router against whatever network
// hardhat is pointed at, using the configured deployer account. Reads existing
// addresses from frontend/deployment.json, and deploys a third token + pool so
// multi-hop can be tested too.
async function main() {
  const [raw] = await ethers.getSigners();
  // Wrap in NonceManager so nonces are tracked locally — the public RPC is load-balanced and
  // returns stale nonces between sends, causing "invalid nonce" when firing many txs in a row.
  const signer = new ethers.NonceManager(raw);
  console.log("Network :", network.name);
  console.log("Caller  :", raw.address);
  const nativeBal = await ethers.provider.getBalance(raw.address);
  console.log("Gas bal :", fmt(nativeBal), "(native)");
  line();

  const deployment = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "frontend", "deployment.json"), "utf8")
  );
  const c = deployment.contracts;

  const usdc = await ethers.getContractAt("MockERC20", c.usdc, signer);
  const opn = await ethers.getContractAt("MockERC20", c.opn, signer);
  const deepPool = await ethers.getContractAt("ConstantProductPool", c.deepPool, signer);
  const shallowPool = await ethers.getContractAt("ConstantProductPool", c.shallowPool, signer);
  const router = await ethers.getContractAt("SwapRouter", c.router, signer);
  const vault = await ethers.getContractAt("JITLiquidityVault", c.vault, signer);

  // ── 0. Pre-fund ONCE up front, then wait until the chain reflects it. Every later step draws
  //       from this balance instead of minting just-in-time, which removed a mint->swap race:
  //       on the load-balanced public RPC a node handling a swap sometimes hadn't yet seen the
  //       mint that preceded it, reverting with "insufficient balance" despite ample funds. One
  //       big pre-fund + a confirmed-visible wait removes that race for all steps below.
  const PREFUND = 300_000n * WAD;
  await ensureBalance(usdc, signer, PREFUND);
  await approveIfNeeded(usdc, signer, c.router, PREFUND);

  // ── 1. Routing: bestQuote must pick whichever pool gives the HIGHEST output — not the one
  //       that's nominally "deeper". After many same-direction test swaps the deep pool can get
  //       drained on the OPN side until the shallow pool actually quotes better; the router must
  //       follow the real output, and that's the invariant we assert.
  console.log("[1] ROUTING — chọn pool cho output cao nhất");
  const probe = 10_000n * WAD;
  const deepOut = await deepPool.getAmountOut(probe, true);
  const shallowOut = await shallowPool.getAmountOut(probe, true);
  const [bestPool, bestOut] = await router.bestQuote(c.usdc, c.opn, probe);
  const expectedBest = deepOut >= shallowOut ? c.deepPool : c.shallowPool;
  const expectedOut = deepOut >= shallowOut ? deepOut : shallowOut;
  console.log("  Trade probe     :", fmt(probe), "USDC");
  console.log("  Deep pool out   :", fmt(deepOut), "OPN");
  console.log("  Shallow pool out:", fmt(shallowOut), "OPN");
  console.log("  Router chose    :", bestPool === c.deepPool ? "DEEP" : bestPool === c.shallowPool ? "SHALLOW" : bestPool,
    bestPool === expectedBest ? "✓ (output cao nhất)" : "");
  console.log("  Best out        :", fmt(bestOut), "OPN");
  if (bestPool !== expectedBest || bestOut !== expectedOut) {
    throw new Error("routing did not pick the highest-output pool");
  }
  line();

  // ── 2. Swap WITHOUT JIT ──
  console.log("[2] SWAP không JIT");
  const tradeAmt = 20_000n * WAD;
  await ensureBalance(usdc, signer, tradeAmt * 2n);
  await approveIfNeeded(usdc, signer, c.router, tradeAmt * 2n);

  const opnBefore1 = await opn.balanceOf(raw.address);
  const rc1 = await txWithRetry("swap no-JIT", () => router.swap(c.usdc, c.opn, tradeAmt, 0n, false));
  const tx1 = { hash: rc1.hash };
  const opnAfter1 = await opn.balanceOf(raw.address);
  const gotNoJIT = opnAfter1 - opnBefore1;
  console.log("  Bán             :", fmt(tradeAmt), "USDC");
  console.log("  Nhận (no JIT)   :", fmt(gotNoJIT), "OPN");
  console.log("  Tx              :", tx1.hash);
  console.log("  Gas used        :", rc1.gasUsed.toString());
  line();

  // ── 3. Compare bare vs JIT output — READ-ONLY via staticCall. No gas, no state mutation, no
  //       balance-read race: staticCall returns the exact output each path WOULD give on current
  //       reserves. This is the right way to show the price improvement — proving the delta does
  //       not require burning gas or skewing the pool. The real JIT tx happens in [3b] below.
  console.log("[3] SO SÁNH GIÁ có/không JIT (read-only staticCall)");
  const bareOutSim = await router.swap.staticCall(c.usdc, c.opn, tradeAmt, 0n, false);
  const jitOutSim = await router.swap.staticCall(c.usdc, c.opn, tradeAmt, 0n, true);
  const improvement = jitOutSim - bareOutSim;
  const pct = bareOutSim > 0n ? Number(improvement * 1000000n / bareOutSim) / 10000 : 0;
  console.log("  Bán             :", fmt(tradeAmt), "USDC");
  console.log("  Output không JIT:", fmt(bareOutSim), "OPN");
  console.log("  Output có JIT   :", fmt(jitOutSim), "OPN");
  console.log("  Cải thiện trader:", (improvement >= 0n ? "+" : "") + fmt(improvement), "OPN  (" + (pct >= 0 ? "+" : "") + pct.toFixed(4) + "%)");
  line();

  // ── 3b. Swap WITH JIT via swapWithHint — the production path: optimal injection computed
  //        OFF-CHAIN and only verified on-chain, so gas is a fraction of the on-chain search. ──
  console.log("[3b] SWAP có JIT — swapWithHint (off-chain compute, on-chain verify)");
  const [bestPool3b, , z4o3b] = await router.bestQuote(c.usdc, c.opn, tradeAmt);
  const pool3b = await ethers.getContractAt("ConstantProductPool", bestPool3b, signer);
  const [pr0, pr1] = await pool3b.getReserves();
  const reserveIn3b = z4o3b ? pr0 : pr1;
  const reserveOut3b = z4o3b ? pr1 : pr0;
  const vMaxIn3b = z4o3b ? await usdc.balanceOf(c.vault) : await opn.balanceOf(c.vault);
  const vMaxOut3b = z4o3b ? await opn.balanceOf(c.vault) : await usdc.balanceOf(c.vault);
  const { hintA } = optimalInjection(tradeAmt, reserveIn3b, reserveOut3b, vMaxIn3b, vMaxOut3b);

  await ensureBalance(usdc, signer, tradeAmt);
  await approveIfNeeded(usdc, signer, c.router, tradeAmt);

  // Gas of the on-chain-search path, measured (not sent) for an apples-to-apples comparison.
  let searchGas = 0n;
  try {
    searchGas = await router.swap.estimateGas(c.usdc, c.opn, tradeAmt, 0n, true);
  } catch { /* estimate may fail on a lagging backend; comparison line is best-effort */ }

  // Measure vault fee capture around this real JIT tx, and the trader's actual output.
  const vUsdc0 = await usdc.balanceOf(c.vault);
  const vOpn0 = await opn.balanceOf(c.vault);
  const opnBefore3b = await opn.balanceOf(raw.address);
  const rc3b = await sendVerified(
    "swapWithHint",
    () => router.swapWithHint.staticCall(c.usdc, c.opn, tradeAmt, 0n, hintA),
    (gasLimit) => router.swapWithHint(c.usdc, c.opn, tradeAmt, 0n, hintA, { gasLimit }),
    600_000n
  );
  const tx3b = { hash: rc3b.hash };
  await waitUntil("hinted output visible", async () => (await opn.balanceOf(raw.address)) > opnBefore3b);
  const gotHint = (await opn.balanceOf(raw.address)) - opnBefore3b;
  const vUsdc1 = await usdc.balanceOf(c.vault);
  const vOpn1 = await opn.balanceOf(c.vault);
  const vaultDelta3b = (vUsdc1 + vOpn1) - (vUsdc0 + vOpn0);

  console.log("  Hint (off-chain):", fmt(hintA, 2), "USDC bơm vào");
  console.log("  Bare quote      :", fmt(bareOutSim), "OPN");
  console.log("  Nhận (có JIT)   :", fmt(gotHint), "OPN  (+" + fmt(gotHint - bareOutSim) + ")");
  if (searchGas > 0n) {
    const gasSaved = searchGas - rc3b.gasUsed;
    const gasPct = Number(gasSaved * 10000n / searchGas) / 100;
    console.log("  Gas used        :", rc3b.gasUsed.toString(), "(search ~" + searchGas.toString() + ", tiết kiệm " + gasPct + "%)");
  } else {
    console.log("  Gas used        :", rc3b.gasUsed.toString());
  }
  console.log("  Vault Σ(token)  :", (vaultDelta3b >= 0n ? "+" : "") + fmt(vaultDelta3b), "(non-negative = thu phí ✓)");
  console.log("  Tx              :", tx3b.hash);
  line();

  // ── 4. Multi-hop: deploy a 3rd token + OPN/GAMMA pool, route USDC->OPN->GAMMA ──
  console.log("[4] MULTI-HOP — USDC → OPN → GAMMA");
  const Token = await ethers.getContractFactory("MockERC20", signer);
  const gamma = await Token.deploy("Gamma", "GAMMA");
  await gamma.waitForDeployment();
  const gammaAddr = await gamma.getAddress();
  console.log("  GAMMA deployed  :", gammaAddr);

  const Pool = await ethers.getContractFactory("ConstantProductPool", signer);
  const opnGamma = await Pool.deploy(c.opn, gammaAddr);
  await opnGamma.waitForDeployment();
  const opnGammaAddr = await opnGamma.getAddress();

  // Seed the OPN/GAMMA pool.
  const seedAmt = 500_000n * WAD;
  await ensureBalance(opn, signer, seedAmt);
  await (await gamma.mint(raw.address, seedAmt)).wait();
  await (await opn.approve(opnGammaAddr, seedAmt)).wait();
  await (await gamma.approve(opnGammaAddr, seedAmt)).wait();
  await (await opnGamma.addLiquidity(seedAmt, seedAmt)).wait();
  await (await router.registerPool(opnGammaAddr)).wait();
  console.log("  OPN/GAMMA pool  :", opnGammaAddr, "(seeded + registered)");

  const hopPath = [c.usdc, c.opn, gammaAddr];
  const hopIn = 5_000n * WAD;
  const quoted = await router.quoteMultiHop(hopPath, hopIn);
  console.log("  Quote           :", fmt(hopIn), "USDC →", fmt(quoted), "GAMMA");

  await ensureBalance(usdc, signer, hopIn);
  await approveIfNeeded(usdc, signer, c.router, hopIn);
  const gammaBefore = await gamma.balanceOf(raw.address);
  const rc3 = await txWithRetry("swapMultiHop", () => router.swapMultiHop(hopPath, hopIn, 0n, false));
  const tx3 = { hash: rc3.hash };
  // Load-balanced RPC: the post-swap balance may lag on the node we hit next. Poll until the
  // GAMMA credit lands so we measure the trader's real output, not a stale pre-swap read.
  await waitUntil(
    "multihop output visible",
    async () => (await gamma.balanceOf(raw.address)) > gammaBefore
  );
  const gammaAfter = await gamma.balanceOf(raw.address);
  const gotGamma = gammaAfter - gammaBefore;
  console.log("  Nhận thực tế    :", fmt(gotGamma), "GAMMA");
  console.log("  Khớp quote      :", gotGamma === quoted ? "✓" : "✗ (" + fmt(gotGamma) + " vs " + fmt(quoted) + ")");
  console.log("  Tx              :", tx3.hash);
  console.log("  Gas used        :", rc3.gasUsed.toString());
  line();

  console.log("TẤT CẢ CHỨC NĂNG ĐÃ CHẠY THẬT TRÊN", network.name.toUpperCase());
  if (deployment.network === "opnTestnet") {
    console.log("Explorer tx:");
    console.log("  no-JIT      : https://testnet.iopn.tech/tx/" + tx1.hash);
    console.log("  JIT hinted  : https://testnet.iopn.tech/tx/" + tx3b.hash);
    console.log("  multihop    : https://testnet.iopn.tech/tx/" + tx3.hash);
  }
}

const MAX_UINT = (1n << 256n) - 1n;

// The load-balanced public RPC occasionally routes a send to a backend that hasn't yet seen
// recent state (a prior mint/trade/nonce bump), which surfaces as a transient revert or
// "invalid nonce". These clear within a few seconds, so retry the send+wait a few times before
// giving up. `send` must build and dispatch the tx fresh each call so the nonce is re-read.
async function txWithRetry(label, send, tries = 6, delayMs = 4000) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const tx = await send();
      return await tx.wait();
    } catch (e) {
      const msg = (e.message || "").toLowerCase();
      const transient = msg.includes("insufficient balance")
        || msg.includes("insufficient allowance")
        || msg.includes("invalid nonce")
        || msg.includes("invalid sequence")
        || msg.includes("nonce too low")
        || msg.includes("replacement");
      lastErr = e;
      if (!transient || i === tries - 1) throw e;
      console.log(`    ${label}: lỗi tạm thời (RPC chưa đồng bộ), thử lại ${i + 1}/${tries - 1}...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

// Heavy-path swaps (the 256-iteration on-chain JIT search) burn ~1.58M gas. On the load-balanced
// public RPC, ethers estimates gas against one backend's state but the tx may mine against another
// whose state differs slightly, tripping an internal require and reverting AFTER paying for gas.
// To avoid burning gas on a doomed tx: first poll a read-only staticCall of the EXACT call until a
// fresh backend confirms it succeeds, then dispatch with an explicit gasLimit so ethers never
// re-estimates against stale state. `staticCall` is the contract method's .staticCall fn; `send`
// dispatches the real tx; `gasLimit` is a fixed ceiling comfortably above the measured cost.
async function sendVerified(label, staticCall, send, gasLimit, tries = 8, delayMs = 4000) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      await staticCall(); // throws if the call would revert on this backend's state
      const tx = await send(gasLimit);
      const rc = await tx.wait();
      if (rc.status === 0) throw new Error("tx mined but reverted (status 0)");
      return rc;
    } catch (e) {
      lastErr = e;
      if (i === tries - 1) throw e;
      console.log(`    ${label}: chưa sẵn sàng (RPC chưa đồng bộ / sẽ revert), chờ rồi thử lại ${i + 1}/${tries - 1}...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

// Public testnet RPCs sit behind load balancers, so a freshly-mined state change may not be
// visible on the next call (eventual consistency). Poll until the chain reflects what we need.
async function waitUntil(label, check, tries = 30, delayMs = 1500) {
  for (let i = 0; i < tries; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`timeout waiting for: ${label}`);
}

async function ensureBalance(token, signer, need) {
  const addr = await signer.getAddress();
  const bal = await token.balanceOf(addr);
  if (bal < need) {
    await (await token.mint(addr, need - bal)).wait();
    await waitUntil("mint visible", async () => (await token.balanceOf(addr)) >= need);
  }
}

async function approveIfNeeded(token, signer, spender, amount) {
  const addr = await signer.getAddress();
  const cur = await token.allowance(addr, spender);
  if (cur >= amount) return;
  // Approve max so allowance never depletes across multiple swaps (MockERC20 skips the
  // decrement when allowance == max), and so we only pay for one approval.
  await (await token.approve(spender, MAX_UINT)).wait();
  await waitUntil("allowance visible", async () => (await token.allowance(addr, spender)) >= amount);
}

main().catch((e) => {
  console.error("LỖI:", e.message || e);
  process.exitCode = 1;
});
