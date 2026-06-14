# OPN Swap — JIT Liquidity Router

Hạ tầng thanh khoản cho OPN Chain: một aggregating swap router định tuyến giao dịch qua nhiều pool, kèm cơ chế **Just-in-Time (JIT) liquidity** bơm vốn nhàn rỗi vào pool *đúng trong một giao dịch* để giảm slippage cho trader, rồi rút ra ngay sau đó — phần phí thu được chia cho các LP đã gửi vốn vào vault.

> Season 1 — DeFi & Open Finance · OPN Swap (Liquidity tools / Novel AMM designs / Financial primitives)

## Vấn đề

Trong AMM truyền thống (Uniswap v2/v3), LP phải khóa vốn vĩnh viễn trong một pool. Vốn đó:
- chịu **impermanent loss** liên tục dù không có giao dịch,
- chỉ phục vụ một cặp token duy nhất,
- không thể tái sử dụng cho pool khác khi nhàn rỗi.

Trader thì chịu slippage cao trên pool nông, dù ở nơi khác có vốn rảnh.

## Giải pháp

Một **vault đa LP giữ vốn tập trung** + **router điều phối**. Khi có giao dịch đến:

1. Router quét mọi pool của cặp token, chọn pool cho output tốt nhất.
2. Lượng thanh khoản JIT **tối ưu** được tính (off-chain hoặc on-chain) để bơm vào pool đó.
3. Vault bơm vốn → pool sâu hơn → trader nhận giá tốt hơn.
4. Giao dịch thực thi.
5. Vault rút vốn ra ngay trong cùng transaction, **thu phần phí** — share price của vault tăng, mọi LP hưởng theo tỉ lệ.

Vốn không bị khóa: giữa các giao dịch nó nằm trong vault, sẵn sàng deploy cho pool trên demand.

## Kiến trúc

```
                 ┌─────────────┐
   trader ──────▶│  SwapRouter │  bestQuote() chọn pool tốt nhất
                 │ nonReentrant│  swap() / swapWithHint() / swapMultiHop()
                 └──────┬──────┘
              inject │  │ withdraw (cùng 1 tx, atomic)
                     ▼  │
              ┌──────────────────┐      ┌──────────────────────┐
              │ JITLiquidityVault│◀────▶│ ConstantProductPool(s)│  x*y=k, fee 0.30%
              │  multi-LP shares │ add/ │  deep / shallow / ... │
              │  + abuse caps    │remove└──────────────────────┘
              └──────────────────┘
                     ▲
                     │ optimalInjection() / verifyInjection()
              ┌──────────────┐
              │ JITOptimizer │  ternary search trên đường PnL lõm
              └──────────────┘
```

| Contract | Vai trò |
|----------|---------|
| `ConstantProductPool.sol` | AMM x*y=k, fee 0.30%, reserve nội bộ (chống griefing), khóa MIN_LIQUIDITY chống first-depositor attack |
| `JITLiquidityVault.sol` | Vault đa LP (deposit/withdraw nhận shares), bơm/rút quanh một giao dịch — chỉ router điều khiển; có abuse caps |
| `SwapRouter.sol` | Aggregate nhiều pool, chọn route tốt nhất, điều phối JIT, single + multi-hop; nonReentrant |
| `JITOptimizer.sol` | Tính lượng JIT tối ưu (search) và verify hint (constant-time) |
| `Security.sol` | ReentrancyGuard, SafeApprove, IERC20Full |

## Cơ chế JIT Optimizer

Bơm thanh khoản lượng `A` (tính theo token vào):
- **Lợi:** vault thu share `s = A/(R_in + A)` của phí giao dịch.
- **Hại:** vault chịu divergence loss khi giá pool dịch chuyển — nó thoát ra với nhiều token vào (đã rẻ đi) hơn.

Phí thu được là bậc nhất theo `s`, còn divergence loss tăng theo `A`, nên **PnL của vault là hàm lõm theo `A` với một đỉnh nội tại**. Optimizer tìm đỉnh đó bằng **ternary search** (256 vòng, hội tụ về 1 wei), bị giới hạn bởi vốn vault hai phía. Nếu không có điểm bơm nào có lãi → không bơm.

PnL được đo bằng token ra, định giá token vào tại giá biên trước giao dịch `p = R_out/R_in`, và scale theo `R_in` để giữ số học nguyên (argmax không đổi):

```
pnlScaled(A) = W_out · R_in + W_in · R_out − 2A · R_out
```

### Off-chain compute / on-chain verify

Chạy ternary search on-chain tốn ~1.58M gas. Thay vào đó, đường **`swapWithHint`** đưa việc tìm `A` ra off-chain (miễn phí, qua [frontend/jitOptimizer.js](frontend/jitOptimizer.js) — mirror BigInt khớp bit-for-bit với Solidity), contract chỉ chạy **một lần** `verifyInjection` để đảm bảo hint an toàn (trong vốn vault, có lãi).

| Đường swap | Gas | Output trader |
|------------|-----|---------------|
| `swap(...,useJIT=true)` — search on-chain | ~1,580,000 | giống hệt |
| `swapWithHint(...)` — verify hint | **~215,000** | giống hệt |
| **Tiết kiệm** | **−85%** | — |

Hint sai/quá vốn không làm revert: nó bị clamp về cap rồi vẫn swap an toàn, hoặc bỏ qua JIT — trader không bao giờ bị block.

## An toàn

- **ReentrancyGuard** trên mọi đường swap (chu kỳ inject→swap→withdraw chạm 3 contract trong 1 tx).
- **SafeApprove** (reset allowance về 0 trước khi set, không tin bool trả về) thay cho `.call("approve")` thô.
- **registerPool / registerVault chỉ owner** — vault bơm vốn thật vào pool được register, nên pool giả phải bị chặn để không drain vault.
- **Abuse caps**: mỗi lần bơm ≤ 25% reserve pool và ≤ 50% vốn vault. Một trade (kể cả attacker thao túng giá) không thể commit toàn bộ vault hay bóp méo pool tùy ý.
- **Multi-hop**: chỉ check `minAmountOut` ở output cuối — đủ, vì cả route là một tx atomic; thao túng hop giữa tất yếu kéo output cuối xuống dưới ngưỡng và revert toàn bộ.

## Đã deploy — OPN Chain Testnet (chainId 984)

| Contract | Địa chỉ |
|----------|---------|
| Router | `0x06cA2346911cD6088DB29C37A9AD7322d04794B7` |
| JIT Vault | `0x1a153565F5d65a37fC9e4DD8b56e681a78354F09` |
| Deep Pool | `0x768a07f6D76ea980cebb2F582E9f20EE1cDc7BE2` |
| Shallow Pool | `0x8441886FdD69ff5CfE73983D67b720dDBcd05D33` |
| USDC (mock) | `0xDEeED1807d6e681eE2e28925d3F7E65F0F47c56F` |
| OPN (mock) | `0x03Fee09c9358431AEA5198c6e7789d83a1509DdD` |

Explorer: https://testnet.iopn.tech · RPC: https://testnet-rpc.iopn.tech

## Chạy thử

```bash
npm install
npm run compile
npm test                 # 11/11 pass

# Deploy lại (cần .env với DEPLOYER_PRIVATE_KEY)
npx hardhat run scripts/deploy.js --network opnTestnet

# Chạy thử toàn bộ chức năng trên testnet (routing, swap, JIT, multi-hop)
npx hardhat run scripts/interact.js --network opnTestnet

# Bảng slippage theo trade size (read-only)
npx hardhat run scripts/slippage-table.js --network opnTestnet

# Demo frontend: phục vụ thư mục frontend/ rồi mở trong trình duyệt có MetaMask
npx serve frontend
```

Frontend báo giá qua RPC testnet (read-only), tính JIT hint off-chain, và ký giao dịch qua MetaMask (tự thêm/chuyển sang mạng OPN testnet).

## Kiểm thử (11/11)

| Test | Chứng minh |
|------|------------|
| `routes to best pool` | Router chọn đúng pool cho output cao nhất |
| `JIT better price` | JIT cho trader output cao hơn pool trần |
| `vault nets fees (share price grows)` | Share price vault tăng sau chu kỳ bơm/rút |
| `hinted matches search, less gas` | `swapWithHint` cùng output nhưng rẻ ~85% gas |
| `clamps oversized hint safely` | Hint quá vốn bị clamp về cap, swap an toàn, không drain |
| `hint == on-chain bestA` | Mirror off-chain khớp optimizer on-chain |
| `PnL concave` | Optimizer chọn đúng đỉnh, hơn cả lượng bơm quá nhỏ/quá lớn |
| `capital limits` | Không bơm vượt vốn vault |
| `multi-hop A→B→C` | Định tuyến qua token trung gian, khớp quote |
| `multi-hop slippage` | Revert khi output dưới ngưỡng |

## Hướng phát triển (chưa làm)

- Keeper/relayer chạy `swapWithHint` tự động + bảo vệ MEV cho chu kỳ inject-swap-withdraw.
- Split routing: chia một giao dịch lớn qua nhiều pool song song thay vì chọn một.
- Price oracle on-chain (TWAP) làm sanity-check thay vì chỉ dựa vào reserve hiện tại.
- Audit chuyên nghiệp trước khi lên mainnet.
- Governance cho việc curate pool/vault thay vì single-owner.
