// OPN Swap — JIT Liquidity Router demo UI.
// Read-only quotes go through the OPN testnet RPC; transactions (approve/swap) are
// signed by the user's MetaMask wallet. The UI auto-switches MetaMask to OPN testnet.
//
// JIT path uses the off-chain-compute / on-chain-verify design: the optimal injection
// `hintA` is computed in the browser (frontend/jitOptimizer.js) and passed to
// swapWithHint, which only verifies it on-chain (~241k gas vs ~1.49M for the search path).

const RPC_URL = "https://testnet-rpc.iopn.tech";
const CHAIN_ID = 984;
const CHAIN_ID_HEX = "0x3d8"; // 984
const EXPLORER = "https://testnet.iopn.tech";

const OPN_NETWORK_PARAMS = {
  chainId: CHAIN_ID_HEX,
  chainName: "OPN Testnet",
  nativeCurrency: { name: "OPN", symbol: "OPN", decimals: 18 },
  rpcUrls: [RPC_URL],
  blockExplorerUrls: [EXPLORER],
};

// Off-chain optimizer (frontend/jitOptimizer.js attaches it to window).
const offchain = window.JITOptimizerOffchain;

// Minimal ABIs — only the functions the UI calls.
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function mint(address to, uint256 amount)",
  "function decimals() view returns (uint8)",
];

const ROUTER_ABI = [
  "function bestQuote(address tokenIn, address tokenOut, uint256 amountIn) view returns (address best, uint256 bestOut, bool zeroForOne)",
  "function swapWithHint(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, uint256 hintA) returns (uint256)",
  "function vaultForPair(bytes32) view returns (address)",
  "event Routed(address indexed pool, uint256 amountIn, uint256 amountOut, bool jitUsed)",
];

const POOL_ABI = [
  "function getReserves() view returns (uint256, uint256)",
  "function getAmountOut(uint256 amountIn, bool zeroForOne) view returns (uint256)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];

const VAULT_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function maxInjectable(address pool, bool zeroForOne) view returns (uint256)",
];

const state = {
  readProvider: null, // RPC, read-only
  wallet: null, // BrowserProvider over MetaMask
  signer: null,
  account: null,
  deployment: null,
  tokensRead: {}, // contracts bound to readProvider
  routerRead: null,
  vaultRead: null,
  lastQuote: null,
  chainId: null,
  netLive: null, // null = connecting, true = ok, false = error
};

const $ = (id) => document.getElementById(id);

function log(msg) {
  const el = $("log");
  const ts = new Date().toLocaleTimeString();
  el.textContent = `[${ts}] ${msg}\n` + el.textContent;
}

const WAD = 10n ** 18n;
function fmt(wei, digits = 4) {
  const neg = wei < 0n;
  let v = neg ? -wei : wei;
  const whole = v / WAD;
  const frac = v % WAD;
  const fracStr = frac.toString().padStart(18, "0").slice(0, digits);
  return (neg ? "-" : "") + whole.toLocaleString("en-US") + (digits > 0 ? "." + fracStr : "");
}

// Load deployment + set up the read-only provider. Runs on page load so quotes work
// even before the user connects a wallet.
async function initRead() {
  try {
    state.readProvider = new ethers.JsonRpcProvider(RPC_URL);
    const net = await state.readProvider.getNetwork();

    const res = await fetch("deployment.json?" + Date.now());
    if (!res.ok) throw new Error("deployment.json not found — run the deploy script first");
    state.deployment = await res.json();

    const c = state.deployment.contracts;
    state.tokensRead.usdc = new ethers.Contract(c.usdc, ERC20_ABI, state.readProvider);
    state.tokensRead.opn = new ethers.Contract(c.opn, ERC20_ABI, state.readProvider);
    state.routerRead = new ethers.Contract(c.router, ROUTER_ABI, state.readProvider);
    state.vaultRead = new ethers.Contract(c.vault, VAULT_ABI, state.readProvider);

    state.chainId = net.chainId.toString();
    state.netLive = true;
    renderStatus();
    $("netdot")?.classList.add("live");
    $("quoteBtn").disabled = false;
    log(tf("app.logRpcOk", { n: net.chainId }));
    log(tf("app.logRouter", { a: c.router }));
    if (!offchain) log(t("app.logNoOpt"));
  } catch (e) {
    state.netLive = false;
    renderStatus();
    log(tf("app.logRpcErr", { e: e.message }));
  }
}

// Re-paint the status chip + wallet label in the current language. Registered as the hook the
// language toggle calls, so switching EN/VI keeps the live state instead of resetting it.
function renderStatus() {
  if (state.netLive && state.chainId) {
    $("netstatus").textContent = tf("app.connected", { n: state.chainId });
  } else if (state.netLive === false) {
    $("netstatus").textContent = t("app.rpcErr");
  } else {
    $("netstatus").textContent = t("status.disconnected");
  }
  if (state.account) {
    $("walletStatus").textContent = state.account.slice(0, 6) + "…" + state.account.slice(-4);
    $("connectBtn").textContent = t("app.walletConnected");
  } else {
    $("walletStatus").textContent = t("wallet.disconnected");
    $("connectBtn").textContent = t("btn.connect");
  }
}
window.__dynamicRender = renderStatus;

// Ensure MetaMask is pointed at OPN testnet; add the network if it's missing.
async function ensureNetwork() {
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CHAIN_ID_HEX }],
    });
  } catch (e) {
    if (e.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [OPN_NETWORK_PARAMS],
      });
    } else {
      throw e;
    }
  }
}

async function connectWallet() {
  try {
    if (!window.ethereum) {
      log(t("app.logNoMM"));
      return;
    }
    await window.ethereum.request({ method: "eth_requestAccounts" });
    await ensureNetwork();

    state.wallet = new ethers.BrowserProvider(window.ethereum);
    state.signer = await state.wallet.getSigner();
    state.account = await state.signer.getAddress();

    renderStatus();
    $("swapBtn").disabled = false;
    log(tf("app.logWallet", { a: state.account }));
    await refreshBalances();
  } catch (e) {
    log(tf("app.logWalletErr", { e: e.message || e }));
  }
}

function pair() {
  const inKey = $("tokenIn").value;
  const outKey = inKey === "usdc" ? "opn" : "usdc";
  const c = state.deployment.contracts;
  return { inKey, outKey, inAddr: c[inKey], outAddr: c[outKey] };
}

async function refreshBalances() {
  if (!state.account) return;
  const u = await state.tokensRead.usdc.balanceOf(state.account);
  const o = await state.tokensRead.opn.balanceOf(state.account);
  log(tf("app.logBal", { u: fmt(u, 2), o: fmt(o, 2) }));
}

// Compute the off-chain JIT injection hint for the chosen pool. Mirrors the on-chain
// optimizer exactly, then clamps to the vault's abuse cap so the quote is accurate.
async function computeHint(poolAddr, zeroForOne, amountIn) {
  if (!offchain) return 0n;
  const pool = new ethers.Contract(poolAddr, POOL_ABI, state.readProvider);
  const [r0, r1] = await pool.getReserves();
  const reserveIn = zeroForOne ? r0 : r1;
  const reserveOut = zeroForOne ? r1 : r0;

  // Vault capital on each side.
  const c = state.deployment.contracts;
  const t0Addr = await state.vaultRead.token0();
  const t1Addr = await state.vaultRead.token1();
  const t0 = new ethers.Contract(t0Addr, ERC20_ABI, state.readProvider);
  const t1 = new ethers.Contract(t1Addr, ERC20_ABI, state.readProvider);
  const vaultBal0 = await t0.balanceOf(c.vault);
  const vaultBal1 = await t1.balanceOf(c.vault);
  const maxIn = zeroForOne ? vaultBal0 : vaultBal1;
  const maxOut = zeroForOne ? vaultBal1 : vaultBal0;

  const { hintA } = offchain.optimalInjection(amountIn, reserveIn, reserveOut, maxIn, maxOut);

  // Clamp to the vault's on-chain abuse cap so our quote matches what the contract will inject.
  const cap = await state.vaultRead.maxInjectable(poolAddr, zeroForOne);
  return hintA < cap ? hintA : cap;
}

async function quote() {
  try {
    const p = pair();
    $("tokenOut").innerHTML = `<option>${p.outKey.toUpperCase()}</option>`;

    const amtStr = $("amountIn").value.trim();
    if (!amtStr || Number(amtStr) <= 0) {
      log(t("app.logBadAmount"));
      return;
    }
    const amountIn = ethers.parseUnits(amtStr, 18);

    const [bestPool, bestOut, zeroForOne] =
      await state.routerRead.bestQuote(p.inAddr, p.outAddr, amountIn);

    // Compute the off-chain hint and simulate the hinted swap read-only via staticCall.
    let hintA = 0n;
    let jitOut = bestOut;
    try {
      hintA = await computeHint(bestPool, zeroForOne, amountIn);
      jitOut = await state.routerRead.swapWithHint.staticCall(
        p.inAddr, p.outAddr, amountIn, 0n, hintA,
        { from: state.deployment.deployer }
      );
    } catch (e) {
      jitOut = bestOut;
      log(tf("app.logJitStatic", { e: e.reason || e.message }));
    }

    const improvement = jitOut - bestOut;
    const pct = bestOut > 0n ? (Number(improvement * 1000000n / bestOut) / 10000) : 0;

    $("amountOut").value = fmt(jitOut, 4);
    $("bareOut").textContent = fmt(bestOut, 4) + " " + p.outKey.toUpperCase();
    $("jitOut").textContent = fmt(jitOut, 4) + " " + p.outKey.toUpperCase();
    $("improvement").textContent = "+" + fmt(improvement, 4) + " " + p.outKey.toUpperCase();
    $("improvementPct").textContent = (pct >= 0 ? "+" : "") + pct.toFixed(3) + "%";

    const c = state.deployment.contracts;
    const poolName = bestPool.toLowerCase() === c.deepPool.toLowerCase() ? t("app.poolDeep")
      : bestPool.toLowerCase() === c.shallowPool.toLowerCase() ? t("app.poolShallow") : bestPool.slice(0, 10);
    $("chosenPool").textContent = poolName;
    $("jitAmt").textContent = hintA > 0n ? fmt(hintA, 2) + " " + p.inKey.toUpperCase() : "—";

    state.lastQuote = { amountIn, bareOut: bestOut, jitOut, hintA, ...p };
    log(tf("app.logQuote", {
      a: amtStr, ti: p.inKey.toUpperCase(), o: fmt(jitOut, 4),
      to: p.outKey.toUpperCase(), b: fmt(bestOut, 4),
    }));
  } catch (e) {
    log(tf("app.logQuoteErr", { e: e.reason || e.message }));
  }
}

async function doSwap() {
  try {
    if (!state.signer) {
      log(t("app.logNeedWallet"));
      return;
    }
    if (!state.lastQuote) {
      log(t("app.logNeedQuote"));
      return;
    }
    const useJIT = $("useJIT").checked;
    const { amountIn, inAddr, outAddr, inKey, outKey, bareOut } = state.lastQuote;
    const hintA = useJIT ? state.lastQuote.hintA : 0n;

    const c = state.deployment.contracts;
    const tokenIn = new ethers.Contract(inAddr, ERC20_ABI, state.signer);
    const router = new ethers.Contract(c.router, ROUTER_ABI, state.signer);

    // Demo convenience: mint test tokens to the wallet if it's short (mock tokens are open mint).
    const bal = await tokenIn.balanceOf(state.account);
    if (bal < amountIn) {
      log(tf("app.logMint", { t: inKey.toUpperCase() }));
      await (await tokenIn.mint(state.account, amountIn)).wait();
    }

    // Approve only if current allowance is insufficient.
    const allowance = await tokenIn.allowance(state.account, c.router);
    if (allowance < amountIn) {
      log(tf("app.logApprove", { a: fmt(amountIn, 2), t: inKey.toUpperCase() }));
      await (await tokenIn.approve(c.router, amountIn)).wait();
    }

    // Slippage floor: accept at least 99% of the quoted bare output.
    const minOut = (bareOut * 99n) / 100n;
    const tokenOutRead = state.tokensRead[outKey];
    const balBefore = await tokenOutRead.balanceOf(state.account);

    log(tf("app.logSwapping", { j: useJIT, h: fmt(hintA, 2) }));
    const tx = await router.swapWithHint(inAddr, outAddr, amountIn, minOut, hintA);
    log(tf("app.logTxSent", { h: tx.hash }));
    const receipt = await tx.wait();
    const balAfter = await tokenOutRead.balanceOf(state.account);

    const got = balAfter - balBefore;
    log(tf("app.logSwapOk", { a: fmt(got, 4), t: outKey.toUpperCase(), g: receipt.gasUsed }));
    log(`Explorer: ${EXPLORER}/tx/${tx.hash}`);
    await refreshBalances();
  } catch (e) {
    log(tf("app.logSwapErr", { e: e.reason || e.shortMessage || e.message }));
  }
}

$("quoteBtn").addEventListener("click", quote);
$("swapBtn").addEventListener("click", doSwap);
$("connectBtn").addEventListener("click", connectWallet);
$("tokenIn").addEventListener("change", () => {
  const p = pair();
  $("tokenOut").innerHTML = `<option>${p.outKey.toUpperCase()}</option>`;
});

if (window.ethereum) {
  window.ethereum.on?.("accountsChanged", () => location.reload());
  window.ethereum.on?.("chainChanged", () => location.reload());
}

initRead();
