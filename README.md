# OPN Swap — JIT Liquidity Router

Liquidity infrastructure for OPN Chain: an aggregating swap router that routes trades across multiple pools, paired with a **Just-in-Time (JIT) liquidity** mechanism that injects idle capital into a pool *for a single transaction* to lower slippage for the trader, then withdraws it immediately — the fee earned is shared pro-rata among the LPs who deposited into the vault.

> Season 1 — DeFi & Open Finance · OPN Swap (Liquidity tools / Novel AMM designs / Financial primitives)

## The problem

In traditional AMMs (Uniswap v2/v3), LPs must lock capital permanently in a single pool. That capital:
- suffers **impermanent loss** continuously even when no trades happen,
- serves only one token pair,
- cannot be reused for another pool while idle.

Traders, meanwhile, eat high slippage on shallow pools — even when idle capital exists elsewhere.

## The solution

A **multi-LP vault holding pooled capital** + a **coordinating router**. When a trade arrives:

1. The router scans every pool for the token pair and picks the one with the best output.
2. The **optimal** JIT liquidity amount is computed (off-chain or on-chain) to inject into that pool.
3. The vault injects capital → the pool gets deeper → the trader receives a better price.
4. The trade executes.
5. The vault withdraws within the same transaction, **keeping its share of the fee** — the vault's share price rises, and every LP benefits pro-rata.

Capital is never locked: between trades it sits in the vault, ready to be deployed to any pool on demand.

## Architecture

```
                 ┌─────────────┐
   trader ──────▶│  SwapRouter │  bestQuote() picks the best pool
                 │ nonReentrant│  swap() / swapWithHint() / swapMultiHop()
                 └──────┬──────┘
              inject │  │ withdraw (same tx, atomic)
                     ▼  │
              ┌──────────────────┐      ┌──────────────────────┐
              │ JITLiquidityVault│◀────▶│ ConstantProductPool(s)│  x*y=k, 0.30% fee
              │  multi-LP shares │ add/ │  deep / shallow / ... │
              │  + abuse caps    │remove└──────────────────────┘
              └──────────────────┘
                     ▲
                     │ optimalInjection() / verifyInjection()
              ┌──────────────┐
              │ JITOptimizer │  ternary search on the concave PnL curve
              └──────────────┘
```

| Contract | Role |
|----------|------|
| `ConstantProductPool.sol` | x*y=k AMM, 0.30% fee, internal reserves (anti-griefing), MIN_LIQUIDITY lock against first-depositor attack |
| `JITLiquidityVault.sol` | Multi-LP vault (deposit/withdraw mints shares), injects/withdraws around a single trade — router-only; enforces abuse caps |
| `SwapRouter.sol` | Aggregates pools, picks the best route, orchestrates JIT, single + multi-hop; nonReentrant |
| `JITOptimizer.sol` | Computes the optimal JIT amount (search) and verifies a hint (constant-time) |
| `Security.sol` | ReentrancyGuard, SafeApprove, IERC20Full |

## How the JIT optimizer works

Injecting an amount `A` of liquidity (denominated in the input token):
- **Upside:** the vault earns a share `s = A/(R_in + A)` of the trade's fee.
- **Downside:** the vault takes a divergence loss as the pool price moves — it exits holding more of the (now cheaper) input token.

The fee earned is linear in `s`, while the divergence loss grows with `A`, so **the vault's PnL is concave in `A` with an interior maximum**. The optimizer finds that peak via a **ternary search** (256 iterations, converging to 1 wei), bounded by the vault's capital on both sides. If no injection is profitable → no injection happens.

PnL is measured in output-token units, pricing the input token at the pre-trade marginal price `p = R_out/R_in`, and scaled by `R_in` to keep integer arithmetic (the argmax is unchanged):

```
pnlScaled(A) = W_out · R_in + W_in · R_out − 2A · R_out
```

### Off-chain compute / on-chain verify

Running the ternary search on-chain costs ~1.58M gas. Instead, the **`swapWithHint`** path moves the search for `A` off-chain (free, via [frontend/jitOptimizer.js](frontend/jitOptimizer.js) — a BigInt mirror that matches the Solidity bit-for-bit), and the contract runs `verifyInjection` **once** to ensure the hint is safe (within vault capital, profitable).

| Swap path | Gas | Trader output |
|-----------|-----|---------------|
| `swap(...,useJIT=true)` — on-chain search | ~1,580,000 | identical |
| `swapWithHint(...)` — verify hint | **~215,000** | identical |
| **Savings** | **−85%** | — |

A bad/oversized hint never reverts: it gets clamped to the cap and still swaps safely, or JIT is skipped — the trader is never blocked.

## Security

- **ReentrancyGuard** on every swap path (the inject→swap→withdraw cycle touches 3 contracts in one tx).
- **SafeApprove** (resets allowance to 0 before setting, doesn't trust the returned bool) instead of a raw `.call("approve")`.
- **registerPool / registerVault are owner-only** — the vault injects real capital into registered pools, so a fake pool must be blocked to prevent draining the vault.
- **Abuse caps**: each injection is ≤ 25% of the pool reserve and ≤ 50% of vault capital. A single trade (even one by an attacker manipulating the price) cannot commit the whole vault or distort the pool arbitrarily.
- **Multi-hop**: only the final output is checked against `minAmountOut` — sufficient, because the whole route is one atomic tx; manipulating an intermediate hop necessarily drags the final output below the threshold and reverts the entire route.

## Deployed — OPN Chain Testnet (chainId 984)

| Contract | Address |
|----------|---------|
| Router | `0x06cA2346911cD6088DB29C37A9AD7322d04794B7` |
| JIT Vault | `0x1a153565F5d65a37fC9e4DD8b56e681a78354F09` |
| Deep Pool | `0x768a07f6D76ea980cebb2F582E9f20EE1cDc7BE2` |
| Shallow Pool | `0x8441886FdD69ff5CfE73983D67b720dDBcd05D33` |
| USDC (mock) | `0xDEeED1807d6e681eE2e28925d3F7E65F0F47c56F` |
| OPN (mock) | `0x03Fee09c9358431AEA5198c6e7789d83a1509DdD` |

All six contracts are verified on-chain. Explorer: https://testnet.iopn.tech · RPC: https://testnet-rpc.iopn.tech

## Running it

```bash
npm install
npm run compile
npm test                 # 11/11 passing

# Redeploy (requires .env with DEPLOYER_PRIVATE_KEY)
npx hardhat run scripts/deploy.js --network opnTestnet

# Exercise every feature on testnet (routing, swap, JIT, multi-hop)
npx hardhat run scripts/interact.js --network opnTestnet

# Slippage table by trade size (read-only)
npx hardhat run scripts/slippage-table.js --network opnTestnet

# Frontend demo: serve the frontend/ directory and open in a browser with MetaMask
npx serve frontend
```

The frontend quotes via the testnet RPC (read-only), computes the JIT hint off-chain, and signs transactions through MetaMask (auto-adding/switching to the OPN testnet network).

## Tests (11/11)

| Test | Proves |
|------|--------|
| `routes to best pool` | Router picks the pool with the highest output |
| `JIT better price` | JIT gives the trader a higher output than the bare pool |
| `vault nets fees (share price grows)` | Vault share price rises after an inject/withdraw cycle |
| `hinted matches search, less gas` | `swapWithHint` yields the same output at ~85% less gas |
| `clamps oversized hint safely` | An over-capital hint is clamped to the cap, swaps safely, no drain |
| `hint == on-chain bestA` | The off-chain mirror matches the on-chain optimizer exactly |
| `PnL concave` | The optimizer picks the true peak, beating both tiny and huge injections |
| `capital limits` | Never injects beyond vault capital |
| `multi-hop A→B→C` | Routes through an intermediate token, matches the quote |
| `multi-hop slippage` | Reverts when the final output is below the threshold |

## Roadmap (not yet built)

- Keeper/relayer running `swapWithHint` automatically + MEV protection for the inject-swap-withdraw cycle.
- Split routing: divide a large trade across multiple pools in parallel instead of picking one.
- On-chain price oracle (TWAP) as a sanity check instead of relying solely on current reserves.
- Professional audit before mainnet.
- Governance for curating pools/vaults instead of a single owner.
