// Robust verifier for the OPN testnet (Blockscout). Root cause (measured, not guessed):
// hardhat-verify's "is this a contract?" precheck asks the Blockscout API, which answers from
// its INDEXER. For a freshly-deployed contract whose creation tx the indexer hasn't picked up
// yet, Blockscout reports creation_transaction_hash=null and the precheck fails with "not a
// smart contract" — even though eth_getCode over RPC returns full bytecode (verified: 20/20
// non-empty). Two identical pools proved it: deepPool (indexed) verified, shallowPool (same
// source+args, not yet indexed) failed. So this is explorer-indexer lag, NOT source/args/RPC.
//
// The only fix is to WAIT for the indexer to catch up, then verify — hammering does nothing.
// We space rounds minutes apart, and between rounds ask the Blockscout API which contracts are
// actually verified (the source of truth) so we only retry the ones still missing.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const EXPLORER_API = "https://testnet.iopn.tech/api/v2/smart-contracts";
const MAX_ROUNDS = 20;
const ROUND_DELAY_MS = 180_000; // 3 min between rounds — give the indexer real time to catch up

const deployment = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "frontend", "deployment.json"), "utf8")
);
const c = deployment.contracts;

// Each contract with the EXACT constructor args deploy.js used, plus a fully-qualified
// contract path to disambiguate (two MockERC20s; SwapRouter shares a file with imports).
const targets = [
  { key: "usdc", address: c.usdc, fqn: "contracts/MockERC20.sol:MockERC20", args: ["USD Coin", "USDC"] },
  { key: "opn", address: c.opn, fqn: "contracts/MockERC20.sol:MockERC20", args: ["OPN Token", "OPN"] },
  { key: "deepPool", address: c.deepPool, fqn: "contracts/ConstantProductPool.sol:ConstantProductPool", args: [c.usdc, c.opn] },
  { key: "shallowPool", address: c.shallowPool, fqn: "contracts/ConstantProductPool.sol:ConstantProductPool", args: [c.usdc, c.opn] },
  { key: "router", address: c.router, fqn: "contracts/SwapRouter.sol:SwapRouter", args: [] },
  { key: "vault", address: c.vault, fqn: "contracts/JITLiquidityVault.sol:JITLiquidityVault", args: [c.router, c.usdc, c.opn] },
];

async function isVerified(address) {
  try {
    const r = await fetch(`${EXPLORER_API}/${address}`);
    if (r.status !== 200) return false;
    const j = await r.json();
    // Blockscout marks verified contracts with a populated source / is_verified flag.
    return Boolean(j.is_verified || j.name);
  } catch {
    return false;
  }
}

// Spawn a fresh `npx hardhat verify` process for one contract. Resolves true on success or
// "already verified", false otherwise. The precheck only passes once Blockscout has indexed
// the creation tx, so a "miss" here means the indexer hasn't caught up yet — wait, don't hammer.
function runVerify(t) {
  return new Promise((resolve) => {
    const cliArgs = [
      "hardhat", "verify",
      "--network", "opnTestnet",
      "--contract", t.fqn,
      t.address,
      ...t.args,
    ];
    const child = spawn("npx", cliArgs, { shell: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", () => {
      const low = out.toLowerCase();
      resolve(low.includes("successfully verified") || low.includes("already been verified") || low.includes("already verified"));
    });
  });
}

async function main() {
  let remaining = [...targets];

  // Drop any that are already verified before we start.
  remaining = (await Promise.all(remaining.map(async (t) => ((await isVerified(t.address)) ? null : t)))).filter(Boolean);

  for (let round = 1; round <= MAX_ROUNDS && remaining.length > 0; round++) {
    console.log(`\n── Round ${round} — ${remaining.length} contract chưa verify: ${remaining.map((t) => t.key).join(", ")}`);
    for (const t of remaining) {
      process.stdout.write(`  ${t.key.padEnd(12)} `);
      const ok = await runVerify(t);
      console.log(ok ? "submitted/ok" : "miss (retry vòng sau)");
    }
    // Re-check truth from the explorer API.
    remaining = (await Promise.all(remaining.map(async (t) => ((await isVerified(t.address)) ? null : t)))).filter(Boolean);
    if (remaining.length > 0 && round < MAX_ROUNDS) {
      await new Promise((r) => setTimeout(r, ROUND_DELAY_MS));
    }
  }

  console.log("\n── Kết quả cuối (theo Blockscout API):");
  for (const t of targets) {
    const v = await isVerified(t.address);
    console.log(`  ${t.key.padEnd(12)} ${v ? "VERIFIED ✓" : "CHƯA verify ✗"}  https://testnet.iopn.tech/address/${t.address}#code`);
  }
  if (remaining.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
