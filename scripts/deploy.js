const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const WAD = 10n ** 18n;

// Deploys the full stack and seeds demo liquidity. Writes deployed addresses to
// frontend/deployment.json so the demo UI can pick them up.
async function main() {
  const [raw] = await ethers.getSigners();
  // Wrap the signer in a NonceManager so nonces are tracked locally and incremented per tx,
  // instead of re-querying the (load-balanced, eventually-consistent) public RPC each send —
  // which returned stale nonces and caused "invalid nonce" mid-deploy.
  const deployer = new ethers.NonceManager(raw);
  console.log("Deployer:", raw.address);
  console.log("Network:", network.name);

  const Token = await ethers.getContractFactory("MockERC20", deployer);

  // Deterministic token0<token1 ordering for the demo pair so the UI labels stay stable.
  let usdc = await Token.deploy("USD Coin", "USDC");
  let opn = await Token.deploy("OPN Token", "OPN");
  await usdc.waitForDeployment();
  await opn.waitForDeployment();

  const usdcAddr = await usdc.getAddress();
  const opnAddr = await opn.getAddress();

  const Pool = await ethers.getContractFactory("ConstantProductPool", deployer);
  // Two pools for the same pair at different depths to show routing picking the better one.
  const deepPool = await Pool.deploy(usdcAddr, opnAddr);
  const shallowPool = await Pool.deploy(usdcAddr, opnAddr);
  await deepPool.waitForDeployment();
  await shallowPool.waitForDeployment();

  const Router = await ethers.getContractFactory("SwapRouter", deployer);
  const router = await Router.deploy();
  await router.waitForDeployment();

  // Vault is bound to the pair (token0, token1) and must use the same ordering as the pools.
  const Vault = await ethers.getContractFactory("JITLiquidityVault", deployer);
  const vault = await Vault.deploy(await router.getAddress(), usdcAddr, opnAddr);
  await vault.waitForDeployment();
  await (await router.registerVault(await vault.getAddress())).wait();

  // Seed liquidity. Deep pool: 1,000,000 each. Shallow pool: 50,000 each.
  async function seed(pool, a0, a1) {
    const poolAddr = await pool.getAddress();
    await (await usdc.mint(raw.address, a0)).wait();
    await (await opn.mint(raw.address, a1)).wait();
    await (await usdc.approve(poolAddr, a0)).wait();
    await (await opn.approve(poolAddr, a1)).wait();
    await (await pool.addLiquidity(a0, a1)).wait();
  }
  await seed(deepPool, 1_000_000n * WAD, 1_000_000n * WAD);
  await seed(shallowPool, 50_000n * WAD, 50_000n * WAD);

  await (await router.registerPool(await deepPool.getAddress())).wait();
  await (await router.registerPool(await shallowPool.getAddress())).wait();

  // Seed the JIT vault as its first LP: deposit (token0, token1) and receive shares. The vault
  // is multi-LP now, so this deployer deposit is just the first of potentially many providers.
  const fundAmt = 2_000_000n * WAD;
  await (await usdc.mint(raw.address, fundAmt)).wait();
  await (await opn.mint(raw.address, fundAmt)).wait();
  await (await usdc.approve(await vault.getAddress(), fundAmt)).wait();
  await (await opn.approve(await vault.getAddress(), fundAmt)).wait();
  await (await vault.deposit(fundAmt, fundAmt)).wait();

  // Give the deployer a trading balance to play with in the UI.
  await (await usdc.mint(raw.address, 100_000n * WAD)).wait();

  const deployment = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: raw.address,
    contracts: {
      usdc: usdcAddr,
      opn: opnAddr,
      deepPool: await deepPool.getAddress(),
      shallowPool: await shallowPool.getAddress(),
      router: await router.getAddress(),
      vault: await vault.getAddress(),
    },
  };

  const outDir = path.join(__dirname, "..", "frontend");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "deployment.json"),
    JSON.stringify(deployment, null, 2)
  );

  console.log("\nDeployment complete. Addresses written to frontend/deployment.json:");
  console.log(JSON.stringify(deployment.contracts, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
