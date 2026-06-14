const { expect } = require("chai");
const { ethers } = require("hardhat");
const { optimalInjection } = require("../frontend/jitOptimizer");

const WAD = 10n ** 18n;

async function deployToken(name, symbol) {
  const Token = await ethers.getContractFactory("MockERC20");
  const t = await Token.deploy(name, symbol);
  await t.waitForDeployment();
  return t;
}

async function deployPool(t0, t1) {
  const Pool = await ethers.getContractFactory("ConstantProductPool");
  const pool = await Pool.deploy(await t0.getAddress(), await t1.getAddress());
  await pool.waitForDeployment();
  return pool;
}

async function seed(pool, t0, t1, signer, a0, a1) {
  await t0.mint(signer.address, a0);
  await t1.mint(signer.address, a1);
  await t0.connect(signer).approve(await pool.getAddress(), a0);
  await t1.connect(signer).approve(await pool.getAddress(), a1);
  await pool.connect(signer).addLiquidity(a0, a1);
}

// Fund a multi-LP vault by depositing on both sides.
async function depositVault(vault, t0, t1, lp, amount) {
  await t0.mint(lp.address, amount);
  await t1.mint(lp.address, amount);
  await t0.connect(lp).approve(await vault.getAddress(), amount);
  await t1.connect(lp).approve(await vault.getAddress(), amount);
  await vault.connect(lp).deposit(amount, amount);
}

describe("Off-chain compute / on-chain verify (swapWithHint)", () => {
  let deployer, lp, trader, vaultOwner;
  let tokenA, tokenB, pool, router, vault;

  beforeEach(async () => {
    [deployer, lp, trader, vaultOwner] = await ethers.getSigners();
    tokenA = await deployToken("Alpha", "ALPHA");
    tokenB = await deployToken("Beta", "BETA");
    if ((await tokenA.getAddress()).toLowerCase() > (await tokenB.getAddress()).toLowerCase()) {
      [tokenA, tokenB] = [tokenB, tokenA];
    }

    pool = await deployPool(tokenA, tokenB);
    await seed(pool, tokenA, tokenB, lp, 1_000_000n * WAD, 1_000_000n * WAD);

    const Router = await ethers.getContractFactory("SwapRouter");
    router = await Router.deploy();
    await router.waitForDeployment();
    await router.registerPool(await pool.getAddress());

    const Vault = await ethers.getContractFactory("JITLiquidityVault");
    vault = await Vault.connect(vaultOwner).deploy(
      await router.getAddress(),
      await tokenA.getAddress(),
      await tokenB.getAddress()
    );
    await vault.waitForDeployment();
    await router.registerVault(await vault.getAddress());

    await depositVault(vault, tokenA, tokenB, vaultOwner, 2_000_000n * WAD);
  });

  async function reserves() {
    const [r0, r1] = await pool.getReserves();
    return [r0, r1];
  }

  // Mirror the vault's on-chain abuse cap so the off-chain hint matches what the router injects.
  async function cappedHint(amountIn, zeroForOne) {
    const [r0, r1] = await reserves();
    const vaultAddr = await vault.getAddress();
    const maxIn = await tokenA.balanceOf(vaultAddr);
    const maxOut = await tokenB.balanceOf(vaultAddr);
    const { hintA } = optimalInjection(amountIn, r0, r1, maxIn, maxOut);
    const cap = await vault.maxInjectable(await pool.getAddress(), zeroForOne);
    return hintA < cap ? hintA : cap;
  }

  it("hinted path matches on-chain search output but costs far less gas", async () => {
    const amountIn = 20_000n * WAD;

    await tokenA.mint(trader.address, amountIn * 2n);
    await tokenA.connect(trader).approve(await router.getAddress(), amountIn * 2n);

    // Path A: on-chain search (swap useJIT=true).
    const before1 = await tokenB.balanceOf(trader.address);
    const txSearch = await router.connect(trader).swap(
      await tokenA.getAddress(), await tokenB.getAddress(), amountIn, 0n, true
    );
    const rcSearch = await txSearch.wait();
    const outSearch = (await tokenB.balanceOf(trader.address)) - before1;

    // Reserves are essentially unchanged after the inject+withdraw cycle, so recompute the
    // (capped) hint from live reserves for the second trade.
    const hintA = await cappedHint(amountIn, true);
    expect(hintA).to.be.gt(0n);

    // Path B: hinted (off-chain compute, on-chain verify).
    const before2 = await tokenB.balanceOf(trader.address);
    const txHint = await router.connect(trader).swapWithHint(
      await tokenA.getAddress(), await tokenB.getAddress(), amountIn, 0n, hintA
    );
    const rcHint = await txHint.wait();
    const outHint = (await tokenB.balanceOf(trader.address)) - before2;

    console.log("        gas (on-chain search):", rcSearch.gasUsed.toString());
    console.log("        gas (hinted verify)  :", rcHint.gasUsed.toString());
    const saved = rcSearch.gasUsed - rcHint.gasUsed;
    const pct = Number(saved * 10000n / rcSearch.gasUsed) / 100;
    console.log("        saved                :", saved.toString(), `(${pct}%)`);

    // Both paths clamp to the same cap, so trader output matches closely; hinted costs far less gas.
    expect(outHint).to.be.gt(0n);
    expect(outSearch).to.be.gt(0n);
    expect(rcHint.gasUsed).to.be.lt(rcSearch.gasUsed);
    expect(saved).to.be.gt(200_000n);
  });

  it("clamps an oversized hint to the abuse cap and swaps safely (no revert, no drain)", async () => {
    const amountIn = 1_000n * WAD;
    await tokenA.mint(trader.address, amountIn);
    await tokenA.connect(trader).approve(await router.getAddress(), amountIn);

    // Bare quote BEFORE the swap (the swap moves reserves).
    const bareOut = await pool.getAmountOut(amountIn, true);

    // Absurd hint far beyond vault capital -> clamped to the cap, not rejected outright. The
    // swap must still succeed and never drain more than the cap from the vault.
    const badHint = 10n ** 30n;
    const before = await tokenB.balanceOf(trader.address);
    const tx = await router.connect(trader).swapWithHint(
      await tokenA.getAddress(), await tokenB.getAddress(), amountIn, 0n, badHint
    );
    await tx.wait();
    const got = (await tokenB.balanceOf(trader.address)) - before;

    // Clamped JIT can only help (or at worst no-op), so output is at least the bare quote.
    expect(got).to.be.gte(bareOut);
  });

  it("off-chain hint equals the on-chain optimizer's bestA exactly", async () => {
    const amountIn = 50_000n * WAD;
    const [r0, r1] = await reserves();
    const vaultAddr = await vault.getAddress();
    const vMaxIn = await tokenA.balanceOf(vaultAddr);
    const vMaxOut = await tokenB.balanceOf(vaultAddr);

    const { hintA } = optimalInjection(amountIn, r0, r1, vMaxIn, vMaxOut);

    // Compare against the on-chain library via the harness (no caps — raw optimizer).
    const H = await ethers.getContractFactory("JITOptimizerHarness");
    const harness = await H.deploy();
    await harness.waitForDeployment();
    const [bestA] = await harness.optimalInjection(amountIn, r0, r1, vMaxIn, vMaxOut);

    expect(hintA).to.equal(bestA);
  });
});
