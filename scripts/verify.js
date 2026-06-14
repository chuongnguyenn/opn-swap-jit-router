const { run } = require("hardhat");
const fs = require("fs");
const path = require("path");

// Verifies every deployed contract on the OPN testnet Blockscout explorer. Constructor args
// must match EXACTLY what deploy.js passed at deployment time, so this mirrors those calls.
// Already-verified contracts are reported and skipped, not treated as failures.
// The OPN Blockscout sits behind load-balanced nodes; a freshly-deployed contract's bytecode
// may not be visible on the node the verify plugin hits, surfacing as "is not a smart contract"
// even though eth_getCode confirms code on chain. That's a transient sync issue, so retry it.
async function verify(name, address, constructorArguments, contract, tries = 8, delayMs = 8000) {
  process.stdout.write(`Verifying ${name} (${address})... `);
  for (let i = 0; i < tries; i++) {
    try {
      await run("verify:verify", { address, constructorArguments, contract });
      console.log("OK");
      return;
    } catch (e) {
      const msg = (e.message || "").toLowerCase();
      if (msg.includes("already verified") || msg.includes("already been verified")) {
        console.log("already verified ✓");
        return;
      }
      const retryable = msg.includes("not a smart contract") || msg.includes("does not have bytecode");
      if (retryable && i < tries - 1) {
        process.stdout.write(`retry ${i + 1}/${tries - 1}... `);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      console.log("FAILED");
      console.error("  " + (e.message || e));
      return;
    }
  }
}

async function main() {
  const deployment = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "frontend", "deployment.json"), "utf8")
  );
  const c = deployment.contracts;

  // Order mirrors deploy.js. Fully-qualified `contract` paths disambiguate the two MockERC20
  // instances and the SwapRouter (which shares a file with JITLiquidityVault import).
  await verify("USDC", c.usdc, ["USD Coin", "USDC"], "contracts/MockERC20.sol:MockERC20");
  await verify("OPN", c.opn, ["OPN Token", "OPN"], "contracts/MockERC20.sol:MockERC20");
  await verify("Deep Pool", c.deepPool, [c.usdc, c.opn], "contracts/ConstantProductPool.sol:ConstantProductPool");
  await verify("Shallow Pool", c.shallowPool, [c.usdc, c.opn], "contracts/ConstantProductPool.sol:ConstantProductPool");
  await verify("SwapRouter", c.router, [], "contracts/SwapRouter.sol:SwapRouter");
  await verify("JIT Vault", c.vault, [c.router, c.usdc, c.opn], "contracts/JITLiquidityVault.sol:JITLiquidityVault");

  console.log("\nExplorer:");
  for (const [k, v] of Object.entries(c)) {
    console.log(`  ${k.padEnd(12)}: https://testnet.iopn.tech/address/${v}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
