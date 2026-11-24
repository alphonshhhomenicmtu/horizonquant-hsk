// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ISwapRouter
/// @notice Exact interface verified against HashKey Chain Mainnet HSKSwap V3 SwapRouter
///         at 0x1f3858C46F8F6fE76260b8208995D228C5cddc64 (Uniswap V3 SwapRouter v1 ABI with deadline).
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);

    function factory() external view returns (address);

    function WETH9() external view returns (address);
}

/// @title IUniswapV3PoolMinimal
/// @notice Minimal read interface for HashKey Chain HSKSwap V3 concentrated liquidity pools.
interface IUniswapV3PoolMinimal {
    function token0() external view returns (address);

    function token1() external view returns (address);

    function fee() external view returns (uint24);

    function liquidity() external view returns (uint128);

    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
}

/// @title IERC20Minimal
/// @notice Minimal ERC-20 interface for vault custody and balance inspection.
interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);

    function allowance(address owner, address spender) external view returns (uint256);

    function approve(address spender, uint256 amount) external returns (bool);

    function transfer(address to, uint256 amount) external returns (bool);

    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    function decimals() external view returns (uint8);
}
