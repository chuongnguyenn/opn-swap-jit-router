const { expect } = require("chai");
const { ethers } = require("hardhat");

const WAD = 10n ** 18n;

async function deployToken(name, symbol) {
  const Token = await ethers.getContractFactory("MockERC20");
  const t = await Token.deploy(name, symbol);
  await t.waitForDeployment();
  return t;
}

async function deployPool(token0, token1) {
  const Pool = await ethers.getContractFactory("ConstantProductPool");
  const pool = await Pool.deploy(await token0.getAddress(), await token1.getAddress());
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

describe("JITOptimizer", () => {
  let harness;

  before(async () => {
    const H = await ethers.getContractFactory("JITOptimizerHarness");
    harness = await H.deploy();
    await harness.waitForDeployment();
  });

  it("PnL is concave: optimal injection beats both tiny and huge injections", async () => {
    const amountIn = 200n * WAD;
    const reserveIn = 1_000n * WAD;
    const reserveOut = 1_000n * WAD;
    const maxIn = 100_000n * WAD;
    const maxOut = 100_000n * WAD;

    const [bestA, bestPnl] = await harness.optimalInjection(
      amountIn, reserveIn, reserveOut, maxIn, maxOut
    );

    // Optimal injection must be a positive, profitable amount.
    expect(bestA).to.be.gt(0n);
    expect(bestPnl).to.be.gt(0n);

    // PnL at the optimum should exceed PnL at much smaller and much larger injections.
    const small = bestA / 10n;
    const large = bestA * 10n;
    const pnlSmall = await harness.pnlScaled(small, amountIn, reserveIn, reserveOut);
    const pnlLarge = await harness.pnlScaled(large, amountIn, reserveIn, reserveOut);
    expect(bestPnl).to.be.gte(pnlSmall);
    expect(bestPnl).to.be.gte(pnlLarge);
  });

  it("respects vault capital limits (capped by maxOut)", async () => {
    const amountIn = 500n * WAD;
    const reserveIn = 1_000n * WAD;
    const reserveOut = 1_000n * WAD;
    // Starve the output side: optimizer must not inject more than maxOut allows.
    const maxIn = 100_000n * WAD;
    const maxOut = 5n * WAD;

    const [bestA] = await harness.optimalInjection(
      amountIn, reserveIn, reserveOut, maxIn, maxOut
    );
    // A_out = bestA * reserveOut / reserveIn must be <= maxOut.
    const aOut = (bestA * reserveOut) / reserveIn;
    expect(aOut).to.be.lte(maxOut);
  });

  it("returns zero when no capital is available", async () => {
    const [bestA, bestPnl] = await harness.optimalInjection(
      100n * WAD, 1_000n * WAD, 1_000n * WAD, 0n, 0n
    );
    expect(bestA).to.equal(0n);
    expect(bestPnl).to.equal(0n);
  });
});

describe("Multi-hop routing", () => {
  let deployer, lp, trader;
  let tokenA, tokenB, tokenC;

  beforeEach(async () => {
    [deployer, lp, trader] = await ethers.getSigners();
    tokenA = await deployToken("Alpha", "ALPHA");
    tokenB = await deployToken("Beta", "BETA");
    tokenC = await deployToken("Gamma", "GAMMA");
  });

  it("swaps A->B->C through the best pool at each hop", async () => {
    // Pools: A/B and B/C.
    const poolAB = await deployPool(tokenA, tokenB);
    const poolBC = await deployPool(tokenB, tokenC);
    await seed(poolAB, tokenA, tokenB, lp, 100_000n * WAD, 100_000n * WAD);
    await seed(poolBC, tokenB, tokenC, lp, 100_000n * WAD, 100_000n * WAD);

    const Router = await ethers.getContractFactory("SwapRouter");
    const router = await Router.deploy();
    await router.waitForDeployment();
    await router.registerPool(await poolAB.getAddress());
    await router.registerPool(await poolBC.getAddress());

    const path = [
      await tokenA.getAddress(),
      await tokenB.getAddress(),
      await tokenC.getAddress(),
    ];
    const amountIn = 100n * WAD;

    const quoted = await router.quoteMultiHop(path, amountIn);
    expect(quoted).to.be.gt(0n);

    await tokenA.mint(trader.address, amountIn);
    await tokenA.connect(trader).approve(await router.getAddress(), amountIn);
    const balBefore = await tokenC.balanceOf(trader.address);
    await router.connect(trader).swapMultiHop(path, amountIn, 0, false);
    const balAfter = await tokenC.balanceOf(trader.address);

    const got = balAfter - balBefore;
    expect(got).to.equal(quoted);
    // Two 0.3% hops on deep pools: trader keeps most of the input value.
    expect(got).to.be.gt(99n * WAD);
  });

  it("reverts multi-hop if final output is below minAmountOut", async () => {
    const poolAB = await deployPool(tokenA, tokenB);
    const poolBC = await deployPool(tokenB, tokenC);
    await seed(poolAB, tokenA, tokenB, lp, 10_000n * WAD, 10_000n * WAD);
    await seed(poolBC, tokenB, tokenC, lp, 10_000n * WAD, 10_000n * WAD);

    const Router = await ethers.getContractFactory("SwapRouter");
    const router = await Router.deploy();
    await router.waitForDeployment();
    await router.registerPool(await poolAB.getAddress());
    await router.registerPool(await poolBC.getAddress());

    const path = [
      await tokenA.getAddress(),
      await tokenB.getAddress(),
      await tokenC.getAddress(),
    ];
    const amountIn = 100n * WAD;
    await tokenA.mint(trader.address, amountIn);
    await tokenA.connect(trader).approve(await router.getAddress(), amountIn);

    // Demand an impossible output.
    await expect(
      router.connect(trader).swapMultiHop(path, amountIn, 1_000n * WAD, false)
    ).to.be.revertedWith("slippage");
  });
});
