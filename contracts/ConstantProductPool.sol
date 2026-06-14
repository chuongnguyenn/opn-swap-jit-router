// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Constant-product (x*y=k) pool with a 0.30% swap fee.
/// @dev    Reserves are tracked internally rather than read from token balances so that
///         direct token transfers cannot grief the invariant. Liquidity is accounted with
///         LP shares; the JIT vault is a regular LP that mints/burns around a single swap.
contract ConstantProductPool {
    IERC20 public immutable token0;
    IERC20 public immutable token1;

    uint256 public reserve0;
    uint256 public reserve1;

    uint256 public totalShares;
    mapping(address => uint256) public shares;

    // 30 bps fee, expressed as numerator over 10_000.
    uint256 public constant FEE_BPS = 30;
    uint256 public constant BPS_DENOM = 10_000;
    uint256 private constant MIN_LIQUIDITY = 1_000;

    event Mint(address indexed provider, uint256 amount0, uint256 amount1, uint256 sharesMinted);
    event Burn(address indexed provider, uint256 amount0, uint256 amount1, uint256 sharesBurned);
    event Swap(address indexed sender, bool zeroForOne, uint256 amountIn, uint256 amountOut);

    constructor(IERC20 _token0, IERC20 _token1) {
        require(address(_token0) != address(_token1), "identical tokens");
        token0 = _token0;
        token1 = _token1;
    }

    function getReserves() external view returns (uint256, uint256) {
        return (reserve0, reserve1);
    }

    /// @dev Caller must transfer amount0/amount1 to this pool before calling, or approve and
    ///      let the pool pull. We pull here to keep the integration simple.
    function addLiquidity(uint256 amount0, uint256 amount1)
        external
        returns (uint256 sharesMinted)
    {
        require(amount0 > 0 && amount1 > 0, "zero amount");

        if (totalShares == 0) {
            sharesMinted = _sqrt(amount0 * amount1);
            require(sharesMinted > MIN_LIQUIDITY, "insufficient initial liquidity");
            sharesMinted -= MIN_LIQUIDITY;
            // Lock the first MIN_LIQUIDITY shares permanently to avoid the
            // first-depositor share-price inflation attack.
            totalShares = MIN_LIQUIDITY;
            shares[address(0)] = MIN_LIQUIDITY;
        } else {
            // Enforce the current ratio so a depositor can't skew the price.
            uint256 shares0 = (amount0 * totalShares) / reserve0;
            uint256 shares1 = (amount1 * totalShares) / reserve1;
            sharesMinted = shares0 < shares1 ? shares0 : shares1;
            require(sharesMinted > 0, "insufficient liquidity minted");
        }

        require(token0.transferFrom(msg.sender, address(this), amount0), "t0 transfer failed");
        require(token1.transferFrom(msg.sender, address(this), amount1), "t1 transfer failed");

        reserve0 += amount0;
        reserve1 += amount1;
        totalShares += sharesMinted;
        shares[msg.sender] += sharesMinted;

        emit Mint(msg.sender, amount0, amount1, sharesMinted);
    }

    function removeLiquidity(uint256 sharesToBurn)
        external
        returns (uint256 amount0, uint256 amount1)
    {
        require(sharesToBurn > 0 && shares[msg.sender] >= sharesToBurn, "bad shares");

        amount0 = (sharesToBurn * reserve0) / totalShares;
        amount1 = (sharesToBurn * reserve1) / totalShares;
        require(amount0 > 0 && amount1 > 0, "zero output");

        shares[msg.sender] -= sharesToBurn;
        totalShares -= sharesToBurn;
        reserve0 -= amount0;
        reserve1 -= amount1;

        require(token0.transfer(msg.sender, amount0), "t0 transfer failed");
        require(token1.transfer(msg.sender, amount1), "t1 transfer failed");

        emit Burn(msg.sender, amount0, amount1, sharesToBurn);
    }

    /// @notice Quote the output for a given input without mutating state.
    function getAmountOut(uint256 amountIn, bool zeroForOne)
        public
        view
        returns (uint256 amountOut)
    {
        require(amountIn > 0, "zero input");
        (uint256 reserveIn, uint256 reserveOut) =
            zeroForOne ? (reserve0, reserve1) : (reserve1, reserve0);
        require(reserveIn > 0 && reserveOut > 0, "no liquidity");

        uint256 amountInWithFee = amountIn * (BPS_DENOM - FEE_BPS);
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = (reserveIn * BPS_DENOM) + amountInWithFee;
        amountOut = numerator / denominator;
    }

    /// @notice Execute a swap. Caller must have approved this pool for `amountIn`.
    function swap(uint256 amountIn, bool zeroForOne, uint256 minAmountOut, address to)
        external
        returns (uint256 amountOut)
    {
        amountOut = getAmountOut(amountIn, zeroForOne);
        require(amountOut >= minAmountOut, "slippage");

        (IERC20 tokenIn, IERC20 tokenOut) =
            zeroForOne ? (token0, token1) : (token1, token0);

        require(tokenIn.transferFrom(msg.sender, address(this), amountIn), "in transfer failed");
        require(tokenOut.transfer(to, amountOut), "out transfer failed");

        if (zeroForOne) {
            reserve0 += amountIn;
            reserve1 -= amountOut;
        } else {
            reserve1 += amountIn;
            reserve0 -= amountOut;
        }

        emit Swap(msg.sender, zeroForOne, amountIn, amountOut);
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
