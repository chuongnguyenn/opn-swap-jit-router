const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { swapOut, optimalInjection } = require("../frontend/jitOptimizer");

const WAD = 10n ** 18n;

function fmt(wei, digits = 2) {
  const neg = wei < 0n;
  let v = neg ? -wei : wei;
  const whole = v / WAD;
  const frac = (v % WAD).toString().padStart(18, "0").slice(0, digits);
  return (neg ? "-" : "") + whole.toLocaleString("en-US") + (digits > 0 ? "." + frac : "");
}

// Basis points of price impact vs the pre-trade spot price, given input/output amounts.
// spot price (out per in) = reserveOut / reserveIn ; execution price = out / in.
// slippage = 1 - execPrice/spotPrice, in bps. Computed with integer math (scaled 1e8).
function slippageBps(amountIn, out, reserveIn, reserveOut) {
  if (amountIn === 0n || reserveIn === 0n) return 0n;
  // execPrice/spotPrice = (out/amountIn) / (reserveOut/reserveIn)
  //                     = (out * reserveIn) / (amountIn * reserveOut)
  const SCALE = 100_000_000n; // 1e8
  const ratio = (out * reserveIn * SCALE) / (amountIn * reserveOut);
  const slipScaled = SCALE - ratio; // fraction of price given up, scaled by 1e8
  // to bps: * 10_000 / 1e8  = / 10_000
  return slipScaled / 10_000n;
}

function bpsStr(bps) {
  // bps is an integer count of basis points; show with 2 decimals as a percentage.
  const pct = Number(bps) / 100;
  return pct.toFixed(2) + "%";
}

// Reads live reserves from the deployed deep pool and builds a slippage comparison table
// across a range of trade sizes: bare (no JIT) vs JIT-deepened output, and the slippage
// each incurs. Demonstrates that JIT helps most on large trades.
async function main() {
  console.log("Network :", network.name);

  const deployment = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "frontend", "deployment.json"), "utf8")
  );
  const c = deployment.contracts;

  const deepPool = await ethers.getContractAt("ConstantProductPool", c.deepPool);
  const vault = c.vault;
  const usdc = await ethers.getContractAt("MockERC20", c.usdc);
  const opn = await ethers.getContractAt("MockERC20", c.opn);

  // token0 < token1; for USDC->OPN we need to know which side is which.
  const t0 = await deepPool.token0();
  const usdcIsToken0 = t0.toLowerCase() === c.usdc.toLowerCase();

  const [r0, r1] = await deepPool.getReserves();
  const reserveIn = usdcIsToken0 ? r0 : r1; // USDC side
  const reserveOut = usdcIsToken0 ? r1 : r0; // OPN side

  const vaultMaxIn = await usdc.balanceOf(vault);
  const vaultMaxOut = await opn.balanceOf(vault);

  console.log("Deep pool reserves: USDC", fmt(reserveIn, 0), "· OPN", fmt(reserveOut, 0));
  console.log("Vault capital     : USDC", fmt(vaultMaxIn, 0), "· OPN", fmt(vaultMaxOut, 0));
  console.log("Spot price        : 1 USDC =", fmt((reserveOut * WAD) / reserveIn, 6), "OPN");
  console.log("");

  const sizes = [
    100n, 1_000n, 5_000n, 10_000n, 25_000n,
    50_000n, 100_000n, 250_000n, 500_000n,
  ].map((s) => s * WAD);

  const header =
    "  Trade (USDC) | Bare out (OPN) |  Bare slip | JIT out (OPN)  |  JIT slip | Trader gain |  JIT inject";
  console.log(header);
  console.log("  " + "-".repeat(header.length - 2));

  const rows = [];
  for (const amountIn of sizes) {
    const bareOut = swapOut(amountIn, reserveIn, reserveOut);
    const bareSlip = slippageBps(amountIn, bareOut, reserveIn, reserveOut);

    const { hintA } = optimalInjection(amountIn, reserveIn, reserveOut, vaultMaxIn, vaultMaxOut);
    const aOut = (hintA * reserveOut) / reserveIn;
    const jitReserveIn = reserveIn + hintA;
    const jitReserveOut = reserveOut + aOut;
    const jitOut = swapOut(amountIn, jitReserveIn, jitReserveOut);
    // Slippage for the trader is still measured against the original (pre-injection) spot price.
    const jitSlip = slippageBps(amountIn, jitOut, reserveIn, reserveOut);

    const gain = jitOut - bareOut;
    const gainPct = bareOut > 0n ? Number(gain * 1000000n / bareOut) / 10000 : 0;

    rows.push({ amountIn, bareOut, bareSlip, jitOut, jitSlip, gain, gainPct, hintA });

    console.log(
      "  " +
      fmt(amountIn, 0).padStart(11) + " | " +
      fmt(bareOut, 2).padStart(14) + " | " +
      bpsStr(bareSlip).padStart(9) + " | " +
      fmt(jitOut, 2).padStart(14) + " | " +
      bpsStr(jitSlip).padStart(8) + " | " +
      ("+" + gainPct.toFixed(3) + "%").padStart(11) + " | " +
      fmt(hintA, 0).padStart(11)
    );
  }

  console.log("");
  console.log("Đọc bảng:");
  console.log("  • Lệnh càng lớn, slippage bare càng cao — và JIT cắt giảm càng nhiều.");
  console.log("  • 'Trader gain' = phần trader nhận thêm nhờ JIT bơm thanh khoản đúng lúc.");
  console.log("  • 'JIT inject' = lượng USDC tối ưu vault bơm vào (tính off-chain).");

  // Write a JSON + markdown artifact for the submission.
  const outDir = path.join(__dirname, "..", "frontend");
  const md = buildMarkdown(rows, reserveIn, reserveOut);
  fs.writeFileSync(path.join(outDir, "slippage-table.md"), md);
  console.log("\nBảng đã ghi: frontend/slippage-table.md");
}

function buildMarkdown(rows, reserveIn, reserveOut) {
  let md = "# Slippage: JIT vs no-JIT\n\n";
  md += `Deep pool reserves: ${fmt(reserveIn, 0)} USDC / ${fmt(reserveOut, 0)} OPN. `;
  md += `Spot: 1 USDC = ${fmt((reserveOut * WAD) / reserveIn, 6)} OPN.\n\n`;
  md += "| Trade (USDC) | Bare out | Bare slip | JIT out | JIT slip | Trader gain |\n";
  md += "|---:|---:|---:|---:|---:|---:|\n";
  for (const r of rows) {
    md += `| ${fmt(r.amountIn, 0)} | ${fmt(r.bareOut, 2)} | ${bpsStr(r.bareSlip)} | ${fmt(r.jitOut, 2)} | ${bpsStr(r.jitSlip)} | +${r.gainPct.toFixed(3)}% |\n`;
  }
  return md;
}

main().catch((e) => {
  console.error("LỖI:", e.message || e);
  process.exitCode = 1;
});
