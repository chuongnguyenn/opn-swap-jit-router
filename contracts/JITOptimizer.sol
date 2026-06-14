// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Computes the profit-maximizing amount of just-in-time liquidity to inject around a
///         single swap on a constant-product pool.
/// @dev    Injecting proportional liquidity of size `A` (in the input token) deepens the pool so
///         the trader gets a better price, and earns the vault a share `s = A/(R_in+A)` of the
///         swap fee. But the vault is also exposed to the price move the swap causes: it exits
///         holding more of the (now-cheaper) input token, i.e. divergence loss. Fee income is
///         first-order in `s` while divergence loss grows with `A`, so vault PnL is concave in
///         `A` with an interior maximum. We find it with a ternary search.
///
///         PnL is measured in the output token, valuing the input token at the pre-swap marginal
///         price p = R_out / R_in. To stay in integers we track PnL * R_in (a monotonic transform,
///         so the argmax is unchanged):
///
///             pnlScaled(A) = W_out * R_in + W_in * R_out - 2 * A * R_out
///
///         where, after injecting A_in = A and A_out = A * R_out / R_in:
///             Rin1  = R_in + A,  Rout1 = R_out + A_out
///             out   = swapOut(amountIn, Rin1, Rout1)
///             Rin2  = Rin1 + amountIn,  Rout2 = Rout1 - out
///             s     = A / Rin1
///             W_in  = s * Rin2,  W_out = s * Rout2
library JITOptimizer {
    uint256 internal constant FEE_BPS = 30;
    uint256 internal constant BPS_DENOM = 10_000;
    // Ternary search shrinks the bracket by a factor of 2/3 per step. To collapse a bracket as
    // wide as ~2^150 down to a single point we need ~256 steps; fewer leaves a large residual
    // range and the final linear scan blows the gas limit.
    uint256 internal constant SEARCH_ITERS = 256;

    /// @notice Output of a constant-product swap with the standard 0.30% fee.
    function swapOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        internal
        pure
        returns (uint256)
    {
        if (amountIn == 0 || reserveIn == 0 || reserveOut == 0) return 0;
        uint256 inWithFee = amountIn * (BPS_DENOM - FEE_BPS);
        return (inWithFee * reserveOut) / (reserveIn * BPS_DENOM + inWithFee);
    }

    /// @notice Vault PnL (scaled by reserveIn, in output-token units) for injecting `a` of the
    ///         input token as proportional JIT liquidity around a swap of `amountIn`.
    function pnlScaled(
        uint256 a,
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut
    ) internal pure returns (int256) {
        if (a == 0) return 0;
        uint256 aOut = (a * reserveOut) / reserveIn; // keep pool ratio
        uint256 rin1 = reserveIn + a;
        uint256 rout1 = reserveOut + aOut;

        uint256 out = swapOut(amountIn, rin1, rout1);
        uint256 rin2 = rin1 + amountIn;
        uint256 rout2 = rout1 - out;

        // s = a / rin1 ; W_in = s*rin2 ; W_out = s*rout2  (integer-safe ordering)
        uint256 wIn = (a * rin2) / rin1;
        uint256 wOut = (a * rout2) / rin1;

        int256 gained = int256(wOut * reserveIn + wIn * reserveOut);
        int256 spent = int256(2 * a * reserveOut);
        return gained - spent;
    }

    /// @notice Find the injection amount (in the input token) that maximizes vault PnL, bounded
    ///         by the vault's available capital on each side.
    /// @param amountIn    The incoming trade size (input token).
    /// @param reserveIn   Pool reserve of the input token.
    /// @param reserveOut  Pool reserve of the output token.
    /// @param maxIn       Vault balance of the input token.
    /// @param maxOut      Vault balance of the output token.
    /// @return bestA      Optimal injection of the input token (0 if no profitable injection).
    /// @return bestPnl    Projected vault PnL at bestA, scaled by reserveIn (output-token units).
    function optimalInjection(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut,
        uint256 maxIn,
        uint256 maxOut
    ) internal pure returns (uint256 bestA, int256 bestPnl) {
        if (amountIn == 0 || reserveIn == 0 || reserveOut == 0) return (0, 0);

        // A_out = A_in * reserveOut / reserveIn must fit in maxOut  =>  A_in <= maxOut*reserveIn/reserveOut
        uint256 hi = maxIn;
        uint256 capFromOut = (maxOut * reserveIn) / reserveOut;
        if (capFromOut < hi) hi = capFromOut;
        if (hi == 0) return (0, 0);

        uint256 lo = 0;
        // Ternary search on the concave PnL curve.
        for (uint256 i = 0; i < SEARCH_ITERS && hi > lo + 1; i++) {
            uint256 m1 = lo + (hi - lo) / 3;
            uint256 m2 = hi - (hi - lo) / 3;
            if (pnlScaled(m1, amountIn, reserveIn, reserveOut)
                < pnlScaled(m2, amountIn, reserveIn, reserveOut)) {
                lo = m1;
            } else {
                hi = m2;
            }
        }

        // Evaluate the few survivors and pick the best; never inject at a loss.
        for (uint256 a = lo; a <= hi; a++) {
            int256 p = pnlScaled(a, amountIn, reserveIn, reserveOut);
            if (p > bestPnl) {
                bestPnl = p;
                bestA = a;
            }
        }
    }

    /// @notice Constant-time check that an off-chain-computed injection `hintA` is safe to use:
    ///         it must fit the vault's capital on both sides and be strictly profitable. This is
    ///         the on-chain half of an off-chain-compute / on-chain-verify split — the caller does
    ///         the expensive ternary search off-chain and passes the result; we only confirm the
    ///         vault can't lose money or over-commit. Costs 1 pnlScaled eval instead of ~256.
    /// @dev    Optimality is the caller's concern; safety (no loss, within capital) is ours. A
    ///         profitable-but-suboptimal hint only costs the caller upside, never the vault.
    /// @return ok      True if hintA is within capital and PnL > 0.
    /// @return pnl     Projected PnL at hintA, scaled by reserveIn (output-token units).
    function verifyInjection(
        uint256 hintA,
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut,
        uint256 maxIn,
        uint256 maxOut
    ) internal pure returns (bool ok, int256 pnl) {
        if (hintA == 0 || amountIn == 0 || reserveIn == 0 || reserveOut == 0) return (false, 0);
        if (hintA > maxIn) return (false, 0);
        // A_out = hintA * reserveOut / reserveIn must fit maxOut.
        if ((hintA * reserveOut) / reserveIn > maxOut) return (false, 0);

        pnl = pnlScaled(hintA, amountIn, reserveIn, reserveOut);
        ok = pnl > 0;
    }
}
