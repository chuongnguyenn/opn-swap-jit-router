// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ConstantProductPool} from "./ConstantProductPool.sol";
import {IERC20Full, ReentrancyGuard, SafeApprove} from "./Security.sol";

/// @notice Multi-LP vault that supplies just-in-time liquidity for a single token pair. Many LPs
///         deposit (token0, token1) and receive shares; the share price grows as JIT fees accrue,
///         so depositors earn a pro-rata cut of every fee the vault captures. Only the trusted
///         router may drive the inject -> swap -> withdraw cycle.
///
/// @dev    Capital is at rest in the vault between transactions: inject and withdraw both happen
///         inside one router call, so balanceOf(vault) is always the true total when a deposit or
///         withdrawal is accounted. This makes share math identical to a standard LP token.
///
///         Two abuse caps bound every injection so a single trade (e.g. an attacker manipulating
///         the pool price) can never commit the whole vault or distort the pool arbitrarily:
///           - maxInjectReserveBps: injection <= this fraction of the pool's input reserve
///           - maxInjectCapitalBps: injection <= this fraction of the vault's input-token balance
contract JITLiquidityVault is ReentrancyGuard {
    using SafeApprove for IERC20Full;

    address public router;
    address public owner;
    IERC20Full public immutable token0;
    IERC20Full public immutable token1;

    uint256 public totalShares;
    mapping(address => uint256) public shares;

    // Abuse caps (basis points). Defaults: inject at most 25% of pool reserve and 50% of vault
    // capital on any single trade. Owner-tunable within hard ceilings.
    uint256 public maxInjectReserveBps = 2_500;
    uint256 public maxInjectCapitalBps = 5_000;
    uint256 public constant BPS = 10_000;
    uint256 private constant MIN_LIQUIDITY = 1_000;

    event Deposit(address indexed lp, uint256 amount0, uint256 amount1, uint256 sharesMinted);
    event Withdraw(address indexed lp, uint256 amount0, uint256 amount1, uint256 sharesBurned);
    event CapsUpdated(uint256 maxInjectReserveBps, uint256 maxInjectCapitalBps);

    modifier onlyRouter() {
        require(msg.sender == router, "not router");
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address _router, IERC20Full _token0, IERC20Full _token1) {
        require(address(_token0) != address(_token1), "identical tokens");
        router = _router;
        owner = msg.sender;
        token0 = _token0;
        token1 = _token1;
    }

    function setCaps(uint256 _reserveBps, uint256 _capitalBps) external onlyOwner {
        require(_reserveBps <= 5_000 && _capitalBps <= 10_000, "cap too high");
        maxInjectReserveBps = _reserveBps;
        maxInjectCapitalBps = _capitalBps;
        emit CapsUpdated(_reserveBps, _capitalBps);
    }

    // ─────────────────────────── LP-facing: deposit / withdraw ───────────────────────────

    /// @notice Deposit liquidity and receive shares. Must be supplied at the vault's current
    ///         token0/token1 balance ratio (after the first deposit) so no LP can skew share price.
    function deposit(uint256 amount0, uint256 amount1)
        external
        nonReentrant
        returns (uint256 sharesMinted)
    {
        require(amount0 > 0 && amount1 > 0, "zero amount");
        uint256 bal0 = token0.balanceOf(address(this));
        uint256 bal1 = token1.balanceOf(address(this));

        if (totalShares == 0) {
            sharesMinted = _sqrt(amount0 * amount1);
            require(sharesMinted > MIN_LIQUIDITY, "insufficient initial deposit");
            sharesMinted -= MIN_LIQUIDITY;
            totalShares = MIN_LIQUIDITY;
            shares[address(0)] = MIN_LIQUIDITY; // lock to avoid share-price inflation attack
        } else {
            // Shares for whichever side binds at the current ratio.
            uint256 s0 = (amount0 * totalShares) / bal0;
            uint256 s1 = (amount1 * totalShares) / bal1;
            sharesMinted = s0 < s1 ? s0 : s1;
            require(sharesMinted > 0, "insufficient shares");
        }

        require(token0.transferFrom(msg.sender, address(this), amount0), "t0 transfer failed");
        require(token1.transferFrom(msg.sender, address(this), amount1), "t1 transfer failed");

        totalShares += sharesMinted;
        shares[msg.sender] += sharesMinted;
        emit Deposit(msg.sender, amount0, amount1, sharesMinted);
    }

    /// @notice Burn shares and withdraw the proportional slice of both token balances, including
    ///         accrued JIT fees.
    function withdraw(uint256 sharesToBurn)
        external
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        require(sharesToBurn > 0 && shares[msg.sender] >= sharesToBurn, "bad shares");
        uint256 bal0 = token0.balanceOf(address(this));
        uint256 bal1 = token1.balanceOf(address(this));

        amount0 = (sharesToBurn * bal0) / totalShares;
        amount1 = (sharesToBurn * bal1) / totalShares;
        require(amount0 > 0 && amount1 > 0, "zero output");

        shares[msg.sender] -= sharesToBurn;
        totalShares -= sharesToBurn;

        require(token0.transfer(msg.sender, amount0), "t0 transfer failed");
        require(token1.transfer(msg.sender, amount1), "t1 transfer failed");
        emit Withdraw(msg.sender, amount0, amount1, sharesToBurn);
    }

    /// @notice Current value of an LP's shares, in (token0, token1).
    function balanceOfLP(address lp) external view returns (uint256 amount0, uint256 amount1) {
        if (totalShares == 0) return (0, 0);
        amount0 = (shares[lp] * token0.balanceOf(address(this))) / totalShares;
        amount1 = (shares[lp] * token1.balanceOf(address(this))) / totalShares;
    }

    // ─────────────────────────── Router-driven JIT cycle ───────────────────────────

    /// @notice Largest injection (in the input token) the caps allow for this pool/trade. The router
    ///         clamps its optimizer/hint result to this before injecting. View so the off-chain
    ///         optimizer can mirror the same ceiling.
    function maxInjectable(ConstantProductPool pool, bool zeroForOne)
        public
        view
        returns (uint256)
    {
        require(_pairMatches(pool), "pool pair mismatch");
        (uint256 r0, uint256 r1) = pool.getReserves();
        uint256 reserveIn = zeroForOne ? r0 : r1;
        uint256 capByReserve = (reserveIn * maxInjectReserveBps) / BPS;

        IERC20Full inTok = zeroForOne ? token0 : token1;
        uint256 capByCapital = (inTok.balanceOf(address(this)) * maxInjectCapitalBps) / BPS;

        return capByReserve < capByCapital ? capByReserve : capByCapital;
    }

    /// @notice Inject `amountIn` of the input token (plus the matching other side) as proportional
    ///         liquidity. The router has already clamped amountIn to maxInjectable.
    function inject(ConstantProductPool pool, bool zeroForOne, uint256 amountIn)
        external
        onlyRouter
        returns (uint256 sharesMinted)
    {
        require(_pairMatches(pool), "pool pair mismatch");
        require(amountIn > 0 && amountIn <= maxInjectable(pool, zeroForOne), "inject over cap");

        (uint256 r0, uint256 r1) = pool.getReserves();
        uint256 reserveIn = zeroForOne ? r0 : r1;
        uint256 reserveOut = zeroForOne ? r1 : r0;
        uint256 amountOut = (amountIn * reserveOut) / reserveIn;
        require(amountOut > 0, "inject too small");

        (uint256 a0, uint256 a1) = zeroForOne ? (amountIn, amountOut) : (amountOut, amountIn);
        token0.safeApprove(address(pool), a0);
        token1.safeApprove(address(pool), a1);
        sharesMinted = pool.addLiquidity(a0, a1);
    }

    /// @notice Burn the vault's JIT pool shares back into the vault.
    function withdrawFromPool(ConstantProductPool pool, uint256 poolShares)
        external
        onlyRouter
        returns (uint256 amount0, uint256 amount1)
    {
        (amount0, amount1) = pool.removeLiquidity(poolShares);
    }

    function _pairMatches(ConstantProductPool pool) internal view returns (bool) {
        return address(pool.token0()) == address(token0)
            && address(pool.token1()) == address(token1);
    }

    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
}
