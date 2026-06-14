// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Full ERC20 surface the router/vault need. Kept separate from the minimal IERC20 in
///         ConstantProductPool so callers can approve/read allowances without low-level calls.
interface IERC20Full {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

/// @notice Minimal reentrancy guard. A single mutex slot flips around any guarded external call so
///         the inject -> swap -> withdraw cycle (which touches three contracts in one tx) cannot be
///         re-entered through a malicious token or pool callback.
abstract contract ReentrancyGuard {
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status = _NOT_ENTERED;

    modifier nonReentrant() {
        require(_status != _ENTERED, "reentrant");
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }
}

/// @notice Safe approve helpers that don't trust the token to return a bool, and that reset
///         allowance to zero before setting a new value (some tokens, e.g. USDT, revert on a
///         non-zero -> non-zero approve). Replaces the low-level .call("approve(...)") pattern.
library SafeApprove {
    function safeApprove(IERC20Full token, address spender, uint256 amount) internal {
        _callOptionalReturn(token, abi.encodeWithSelector(token.approve.selector, spender, 0));
        if (amount > 0) {
            _callOptionalReturn(token, abi.encodeWithSelector(token.approve.selector, spender, amount));
        }
    }

    function _callOptionalReturn(IERC20Full token, bytes memory data) private {
        (bool ok, bytes memory ret) = address(token).call(data);
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "approve failed");
    }
}
