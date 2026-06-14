// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ConstantProductPool} from "./ConstantProductPool.sol";
import {JITLiquidityVault} from "./JITLiquidityVault.sol";
import {JITOptimizer} from "./JITOptimizer.sol";
import {IERC20Full, ReentrancyGuard, SafeApprove} from "./Security.sol";

/// @notice Aggregating swap router. For a given pair it routes a swap to the registered pool with
///         the best output, and optionally deepens that pool with just-in-time liquidity drawn
///         from the pair's JIT vault so the trader gets lower slippage. The vault unwinds inside
///         the same transaction, keeping the fee it earned for its LPs.
///
/// @dev    Two JIT entry points:
///           - swap(...,useJIT):  optimal injection is searched ON-CHAIN (~256 evals). Convenient
///                                but gas-heavy; kept for parity/testing.
///           - swapWithHint(...): the optimal injection is computed OFF-CHAIN and passed in; the
///                                contract only verifies it (1 eval). This is the gas-cheap path.
///         Either way the injection is clamped to the vault's abuse caps (see JITLiquidityVault),
///         so a single trade can never commit the whole vault or distort the pool arbitrarily.
contract SwapRouter is ReentrancyGuard {
    using SafeApprove for IERC20Full;

    address public owner;

    // pairKey => list of pools quoting that pair
    mapping(bytes32 => ConstantProductPool[]) public poolsForPair;
    // pairKey => JIT vault serving that pair (one vault per pair)
    mapping(bytes32 => JITLiquidityVault) public vaultForPair;

    event PoolRegistered(address indexed pool, address token0, address token1);
    event VaultRegistered(address indexed vault, address token0, address token1);
    event Routed(address indexed pool, uint256 amountIn, uint256 amountOut, bool jitUsed);

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    function _pairKey(address a, address b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// @dev Permissioned: the vault injects real capital into whatever pool is registered for a
    ///      pair, so an attacker who could register a fake pool (one whose addLiquidity/swap steals
    ///      the injected funds) would drain the vault. Only the owner curates the pool set.
    function registerPool(ConstantProductPool pool) external onlyOwner {
        address t0 = address(pool.token0());
        address t1 = address(pool.token1());
        poolsForPair[_pairKey(t0, t1)].push(pool);
        emit PoolRegistered(address(pool), t0, t1);
    }

    /// @notice Register the JIT vault that serves a pair. The vault's token0/token1 define the pair.
    function registerVault(JITLiquidityVault vault) external onlyOwner {
        address t0 = address(vault.token0());
        address t1 = address(vault.token1());
        vaultForPair[_pairKey(t0, t1)] = vault;
        emit VaultRegistered(address(vault), t0, t1);
    }

    /// @notice Find the pool giving the best output for a given input on a pair.
    function bestQuote(address tokenIn, address tokenOut, uint256 amountIn)
        public
        view
        returns (ConstantProductPool best, uint256 bestOut, bool zeroForOne)
    {
        ConstantProductPool[] storage pools = poolsForPair[_pairKey(tokenIn, tokenOut)];
        require(pools.length > 0, "no pools for pair");

        for (uint256 i = 0; i < pools.length; i++) {
            ConstantProductPool p = pools[i];
            bool z4o = address(p.token0()) == tokenIn;
            uint256 out = p.getAmountOut(amountIn, z4o);
            if (out > bestOut) {
                bestOut = out;
                best = p;
                zeroForOne = z4o;
            }
        }
        require(address(best) != address(0), "no route");
    }

    // ─────────────────────────────── Single-hop swaps ───────────────────────────────

    /// @notice Swap through the best pool. If `useJIT`, the vault deepens the pool for this single
    ///         trade (optimal injection searched on-chain), improving the trader's price, then
    ///         unwinds. Gas-heavy path; prefer swapWithHint in production.
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        bool useJIT
    ) external nonReentrant returns (uint256 amountOut) {
        (ConstantProductPool pool, , bool zeroForOne) = bestQuote(tokenIn, tokenOut, amountIn);

        JITLiquidityVault vault;
        uint256 jitShares;
        if (useJIT) {
            (vault, jitShares) = _injectSearched(pool, amountIn, zeroForOne);
        }

        amountOut = _executeSwap(pool, tokenIn, amountIn, zeroForOne, minAmountOut);

        if (jitShares > 0) {
            vault.withdrawFromPool(pool, jitShares);
        }
        emit Routed(address(pool), amountIn, amountOut, jitShares > 0);
    }

    /// @notice Gas-cheap swap: the optimal JIT injection `hintA` is computed off-chain and only
    ///         verified on-chain. Pass 0 to skip JIT. A hint that fails verification (over caps,
    ///         unprofitable) is ignored and the swap proceeds without JIT — the trader is never
    ///         blocked by a bad hint.
    function swapWithHint(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 hintA
    ) external nonReentrant returns (uint256 amountOut) {
        (ConstantProductPool pool, , bool zeroForOne) = bestQuote(tokenIn, tokenOut, amountIn);

        JITLiquidityVault vault;
        uint256 jitShares;
        if (hintA > 0) {
            (vault, jitShares) = _injectHinted(pool, amountIn, zeroForOne, hintA);
        }

        amountOut = _executeSwap(pool, tokenIn, amountIn, zeroForOne, minAmountOut);

        if (jitShares > 0) {
            vault.withdrawFromPool(pool, jitShares);
        }
        emit Routed(address(pool), amountIn, amountOut, jitShares > 0);
    }

    /// @dev Pull the trader's input, approve the pool, execute the swap to the trader.
    function _executeSwap(
        ConstantProductPool pool,
        address tokenIn,
        uint256 amountIn,
        bool zeroForOne,
        uint256 minAmountOut
    ) internal returns (uint256 amountOut) {
        require(
            IERC20Full(tokenIn).transferFrom(msg.sender, address(this), amountIn),
            "pull in failed"
        );
        IERC20Full(tokenIn).safeApprove(address(pool), amountIn);
        amountOut = pool.swap(amountIn, zeroForOne, minAmountOut, msg.sender);
    }

    // ─────────────────────────────── JIT injection helpers ───────────────────────────────

    /// @dev On-chain search path: find the optimizer's profit-max injection, clamp to the vault's
    ///      abuse caps, inject. Returns the vault and pool-shares minted (0 if no vault / no inject).
    function _injectSearched(ConstantProductPool pool, uint256 amountIn, bool zeroForOne)
        internal
        returns (JITLiquidityVault vault, uint256 jitShares)
    {
        vault = vaultForPair[_pairKey(address(pool.token0()), address(pool.token1()))];
        if (address(vault) == address(0)) return (vault, 0);

        (uint256 r0, uint256 r1) = pool.getReserves();
        uint256 reserveIn = zeroForOne ? r0 : r1;
        uint256 reserveOut = zeroForOne ? r1 : r0;

        (uint256 bestA, ) = JITOptimizer.optimalInjection(
            amountIn,
            reserveIn,
            reserveOut,
            (zeroForOne ? pool.token0() : pool.token1()).balanceOf(address(vault)),
            (zeroForOne ? pool.token1() : pool.token0()).balanceOf(address(vault))
        );
        uint256 capped = _clampToCap(vault, pool, zeroForOne, bestA);
        if (capped == 0) return (vault, 0);
        jitShares = vault.inject(pool, zeroForOne, capped);
    }

    /// @dev Hinted path: clamp the off-chain hint to the caps, verify it's profitable, inject.
    function _injectHinted(
        ConstantProductPool pool,
        uint256 amountIn,
        bool zeroForOne,
        uint256 hintA
    ) internal returns (JITLiquidityVault vault, uint256 jitShares) {
        vault = vaultForPair[_pairKey(address(pool.token0()), address(pool.token1()))];
        if (address(vault) == address(0)) return (vault, 0);

        uint256 capped = _clampToCap(vault, pool, zeroForOne, hintA);
        if (capped == 0) return (vault, 0);
        if (!_verifyHint(vault, pool, zeroForOne, amountIn, capped)) return (vault, 0);
        jitShares = vault.inject(pool, zeroForOne, capped);
    }

    /// @dev Re-check an off-chain hint on-chain: one pnlScaled eval confirming the (already capped)
    ///      injection is within vault capital and strictly profitable. Split out of _injectHinted to
    ///      keep that function's stack shallow.
    function _verifyHint(
        JITLiquidityVault vault,
        ConstantProductPool pool,
        bool zeroForOne,
        uint256 amountIn,
        uint256 capped
    ) internal view returns (bool ok) {
        (uint256 r0, uint256 r1) = pool.getReserves();
        (ok, ) = JITOptimizer.verifyInjection(
            capped,
            amountIn,
            zeroForOne ? r0 : r1,
            zeroForOne ? r1 : r0,
            (zeroForOne ? pool.token0() : pool.token1()).balanceOf(address(vault)),
            (zeroForOne ? pool.token1() : pool.token0()).balanceOf(address(vault))
        );
    }

    /// @dev Clamp a desired injection to the vault's abuse cap for this pool/side. Because vault PnL
    ///      is concave with an interior max, clamping a too-large amount down to the cap stays on the
    ///      increasing part of the curve, so the capped injection is still profitable.
    function _clampToCap(
        JITLiquidityVault vault,
        ConstantProductPool pool,
        bool zeroForOne,
        uint256 desired
    ) internal view returns (uint256) {
        if (desired == 0) return 0;
        uint256 cap = vault.maxInjectable(pool, zeroForOne);
        return desired < cap ? desired : cap;
    }

    // ─────────────────────────────── Multi-hop ───────────────────────────────

    /// @notice Quote a multi-hop route: for each consecutive pair in `path`, take the best pool's
    ///         output and feed it into the next hop. Returns the final output amount.
    function quoteMultiHop(address[] calldata path, uint256 amountIn)
        public
        view
        returns (uint256 amountOut)
    {
        require(path.length >= 2, "path too short");
        amountOut = amountIn;
        for (uint256 i = 0; i + 1 < path.length; i++) {
            (, uint256 hopOut, ) = bestQuote(path[i], path[i + 1], amountOut);
            amountOut = hopOut;
        }
    }

    /// @notice Swap along a token path through the best pool at each hop, with optional JIT per hop.
    ///         Intermediate tokens are held transiently by the router between hops.
    /// @dev    Only the FINAL output is checked against minAmountOut. This is sufficient: the whole
    ///         route is one atomic transaction, so no adversary can insert a trade between hops.
    ///         Any manipulation of an intermediate hop necessarily lowers the final output, which
    ///         then fails the end-to-end minAmountOut check and reverts the entire route. Per-hop
    ///         floors would add cost without adding protection.
    function swapMultiHop(
        address[] calldata path,
        uint256 amountIn,
        uint256 minAmountOut,
        bool useJIT
    ) external nonReentrant returns (uint256 amountOut) {
        require(path.length >= 2, "path too short");

        require(
            IERC20Full(path[0]).transferFrom(msg.sender, address(this), amountIn),
            "pull in failed"
        );

        amountOut = amountIn;
        for (uint256 i = 0; i + 1 < path.length; i++) {
            amountOut = _hop(path[i], path[i + 1], amountOut, i + 2 == path.length, useJIT);
        }

        require(amountOut >= minAmountOut, "slippage");
    }

    /// @dev Execute a single hop: pick the best pool, optionally inject JIT, swap to the recipient
    ///      (router for intermediate hops, trader for the last), then unwind JIT.
    function _hop(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        bool lastHop,
        bool useJIT
    ) internal returns (uint256 hopOut) {
        (ConstantProductPool pool, , bool zeroForOne) = bestQuote(tokenIn, tokenOut, amountIn);

        JITLiquidityVault vault;
        uint256 jitShares;
        if (useJIT) {
            (vault, jitShares) = _injectSearched(pool, amountIn, zeroForOne);
        }

        address recipient = lastHop ? msg.sender : address(this);
        IERC20Full(tokenIn).safeApprove(address(pool), amountIn);
        hopOut = pool.swap(amountIn, zeroForOne, 0, recipient);

        if (jitShares > 0) {
            vault.withdrawFromPool(pool, jitShares);
        }
        emit Routed(address(pool), amountIn, hopOut, jitShares > 0);
    }
}
