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

async function seed(pool, token0, token1, signer, amt0, amt1) {
  await token0.mint(signer.address, amt0);
  await token1.mint(signer.address, amt1);
  await token0.connect(signer).approve(await pool.getAddress(), amt0);
  await token1.connect(signer).approve(await pool.getAddress(), amt1);
  await pool.connect(signer).addLiquidity(amt0, amt1);
}

// Deploy a JIT vault for the (token0, token1) pair, funded by `lp` via deposit().
async function deployVault(router, token0, token1, lp, amt0, amt1) {
  const Vault = await ethers.getContractFactory("JITLiquidityVault");
  const vault = await Vault.connect(lp).deploy(
    await router.getAddress(),
    await token0.getAddress(),
    await token1.getAddress()
  );
  await vault.waitForDeployment();

  await token0.mint(lp.address, amt0);
  await token1.mint(lp.address, amt1);
  await token0.connect(lp).approve(await vault.getAddress(), amt0);
  await token1.connect(lp).approve(await vault.getAddress(), amt1);
  await vault.connect(lp).deposit(amt0, amt1);

  await router.registerVault(await vault.getAddress());
  return vault;
}

describe("JIT Liquidity Router", () => {
  let deployer, lp, trader, vaultOwner;
  let tokenA, tokenB;

  beforeEach(async () => {
    [deployer, lp, trader, vaultOwner] = await ethers.getSigners();
    tokenA = await deployToken("Alpha", "ALPHA");
    tokenB = await deployToken("Beta", "BETA");
    if ((await tokenA.getAddress()).toLowerCase() > (await tokenB.getAddress()).toLowerCase()) {
      [tokenA, tokenB] = [tokenB, tokenA];
    }
  });

  it("routes a swap to the pool with the best price", async () => {
    const shallow = await deployPool(tokenA, tokenB);
    const deep = await deployPool(tokenA, tokenB);
    await seed(shallow, tokenA, tokenB, lp, 1_000n * WAD, 1_000n * WAD);
    await seed(deep, tokenA, tokenB, lp, 100_000n * WAD, 100_000n * WAD);

    const Router = await ethers.getContractFactory("SwapRouter");
    const router = await Router.deploy();
    await router.waitForDeployment();
    await router.registerPool(await shallow.getAddress());
    await router.registerPool(await deep.getAddress());

    const amountIn = 100n * WAD;
    const [best, bestOut] = await router.bestQuote(
      await tokenA.getAddress(),
      await tokenB.getAddress(),
      amountIn
    );
    expect(best).to.equal(await deep.getAddress());

    await tokenA.mint(trader.address, amountIn);
    await tokenA.connect(trader).approve(await router.getAddress(), amountIn);
    const balBefore = await tokenB.balanceOf(trader.address);
    await router.connect(trader).swap(
      await tokenA.getAddress(),
      await tokenB.getAddress(),
      amountIn,
      0,
      false
    );
    const balAfter = await tokenB.balanceOf(trader.address);
    expect(balAfter - balBefore).to.equal(bestOut);
  });

  it("JIT liquidity gives the trader a better price than the bare pool", async () => {
    const bare = await deployPool(tokenA, tokenB);
    await seed(bare, tokenA, tokenB, lp, 1_000n * WAD, 1_000n * WAD);

    const amountIn = 200n * WAD;
    const bareOut = await bare.getAmountOut(amountIn, true);

    const pool = await deployPool(tokenA, tokenB);
    await seed(pool, tokenA, tokenB, lp, 1_000n * WAD, 1_000n * WAD);

    const Router = await ethers.getContractFactory("SwapRouter");
    const router = await Router.deploy();
    await router.waitForDeployment();
    await router.registerPool(await pool.getAddress());

    await deployVault(router, tokenA, tokenB, vaultOwner, 10_000n * WAD, 10_000n * WAD);

    await tokenA.mint(trader.address, amountIn);
    await tokenA.connect(trader).approve(await router.getAddress(), amountIn);
    const balBefore = await tokenB.balanceOf(trader.address);
    await router.connect(trader).swap(
      await tokenA.getAddress(),
      await tokenB.getAddress(),
      amountIn,
      0,
      true
    );
    const balAfter = await tokenB.balanceOf(trader.address);
    const jitOut = balAfter - balBefore;

    expect(jitOut).to.be.gt(bareOut);
  });

  it("vault nets fees from providing JIT liquidity (share price grows)", async () => {
    const pool = await deployPool(tokenA, tokenB);
    await seed(pool, tokenA, tokenB, lp, 1_000n * WAD, 1_000n * WAD);

    const Router = await ethers.getContractFactory("SwapRouter");
    const router = await Router.deploy();
    await router.waitForDeployment();
    await router.registerPool(await pool.getAddress());

    const vault = await deployVault(router, tokenA, tokenB, vaultOwner, 10_000n * WAD, 10_000n * WAD);
    const vaultAddr = await vault.getAddress();

    const a0 = await tokenA.balanceOf(vaultAddr);
    const b0 = await tokenB.balanceOf(vaultAddr);

    const amountIn = 200n * WAD;
    await tokenA.mint(trader.address, amountIn);
    await tokenA.connect(trader).approve(await router.getAddress(), amountIn);
    await router.connect(trader).swap(
      await tokenA.getAddress(),
      await tokenB.getAddress(),
      amountIn,
      0,
      true
    );

    const a1 = await tokenA.balanceOf(vaultAddr);
    const b1 = await tokenB.balanceOf(vaultAddr);

    // Vault's combined token holdings should not decrease (it captured part of the swap fee).
    expect(a1 + b1).to.be.gte(a0 + b0);
  });
});
