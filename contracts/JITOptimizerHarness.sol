// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {JITOptimizer} from "./JITOptimizer.sol";

/// @notice Thin wrapper so tests can call the internal library functions.
contract JITOptimizerHarness {
    function optimalInjection(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut,
        uint256 maxIn,
        uint256 maxOut
    ) external pure returns (uint256 bestA, int256 bestPnl) {
        return JITOptimizer.optimalInjection(amountIn, reserveIn, reserveOut, maxIn, maxOut);
    }

    function pnlScaled(
        uint256 a,
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut
    ) external pure returns (int256) {
        return JITOptimizer.pnlScaled(a, amountIn, reserveIn, reserveOut);
    }
}
