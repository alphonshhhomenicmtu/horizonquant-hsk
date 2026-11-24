// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Minimal, ISwapRouter, IUniswapV3PoolMinimal} from "./interfaces/ISwapRouter.sol";

/// @title MockHSKSwapRouter
/// @notice Deterministic HSKSwap V3 SwapRouter simulator for local Foundry and HSK Chain Testnet (133) validation.
contract MockHSKSwapRouter is ISwapRouter {
    uint256 public constant RATE_SCALE = 1e18;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    address public immutable override factory;
    address public immutable override WETH9;
    address public admin;

    // Directed rate: amountOutRaw = (amountInRaw * rateE18[tokenIn][tokenOut]) / 1e18
    mapping(address => mapping(address => uint256)) public rateE18;
    // Simulated extra execution slippage in bps (e.g., 25 = 0.25% adverse fill)
    uint16 public simulatedSlippageBps;
    uint160 public lastSqrtPriceLimitX96;

    event MockSwapExecuted(
        address indexed sender,
        address indexed tokenIn,
        address indexed tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 amountOut
    );

    error RouterDeadlineExpired();
    error UnconfiguredRate();
    error InsufficientOutputAmount(uint256 amountOut, uint256 minAmountOut);
    error OnlyAdmin();

    constructor(address factory_, address whsk_) {
        factory = factory_;
        WETH9 = whsk_;
        admin = msg.sender;
    }

    function setRate(address tokenIn, address tokenOut, uint256 rate) external {
        if (msg.sender != admin) revert OnlyAdmin();
        rateE18[tokenIn][tokenOut] = rate;
    }

    function setSimulatedSlippageBps(uint16 slippageBps) external {
        if (msg.sender != admin) revert OnlyAdmin();
        simulatedSlippageBps = slippageBps;
    }

    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external payable override returns (uint256 amountOut) {
        if (block.timestamp > params.deadline) revert RouterDeadlineExpired();

        uint256 rate = rateE18[params.tokenIn][params.tokenOut];
        if (rate == 0) revert UnconfiguredRate();

        lastSqrtPriceLimitX96 = params.sqrtPriceLimitX96;

        require(
            IERC20Minimal(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn),
            "TRANSFER_IN_FAILED"
        );

        // Apply Uniswap V3 fee tier (fee is in millionths: 500 = 0.05%, 3000 = 0.30%)
        uint256 effectiveIn = (params.amountIn * (1_000_000 - uint256(params.fee))) / 1_000_000;
        uint256 grossOut = (effectiveIn * rate) / RATE_SCALE;
        amountOut = (grossOut * (BPS_DENOMINATOR - simulatedSlippageBps)) / BPS_DENOMINATOR;

        if (amountOut < params.amountOutMinimum) {
            revert InsufficientOutputAmount(amountOut, params.amountOutMinimum);
        }

        require(IERC20Minimal(params.tokenOut).transfer(params.recipient, amountOut), "TRANSFER_OUT_FAILED");

        emit MockSwapExecuted(msg.sender, params.tokenIn, params.tokenOut, params.fee, params.amountIn, amountOut);
    }
}

/// @title MockV3Pool
/// @notice Deterministic HSKSwap V3 pool mock exposing `slot0()`, `observe()`, `liquidity()`, and cardinality growth.
contract MockV3Pool is IUniswapV3PoolMinimal {
    address public immutable override token0;
    address public immutable override token1;
    uint24 public immutable override fee;
    uint128 public override liquidity;
    uint160 public currentSqrtPriceX96;
    int24 public currentTick;
    int24 public twapTick;
    uint16 public observationCardinality = 16;
    bool public unlocked = true;

    constructor(
        address token0_,
        address token1_,
        uint24 fee_,
        uint160 sqrtPriceX96_,
        int24 initialTick_,
        uint128 liquidity_
    ) {
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
        currentSqrtPriceX96 = sqrtPriceX96_;
        currentTick = initialTick_;
        twapTick = initialTick_;
        liquidity = liquidity_;
    }

    function setSqrtPriceX96(uint160 newSqrtPriceX96, int24 newTick) external {
        currentSqrtPriceX96 = newSqrtPriceX96;
        currentTick = newTick;
    }

    function setTwapTick(int24 newTwapTick) external {
        twapTick = newTwapTick;
    }

    function setLiquidity(uint128 newLiquidity) external {
        liquidity = newLiquidity;
    }

    function setUnlocked(bool isUnlocked) external {
        unlocked = isUnlocked;
    }

    function increaseObservationCardinalityNext(uint16 observationCardinalityNext) external override {
        if (observationCardinalityNext > observationCardinality) {
            observationCardinality = observationCardinalityNext;
        }
    }

    function slot0()
        external
        view
        override
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 obsCardinality,
            uint16 obsCardinalityNext,
            uint8 feeProtocol,
            bool isUnlocked
        )
    {
        return (currentSqrtPriceX96, currentTick, 0, observationCardinality, observationCardinality, 0, unlocked);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        override
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        uint256 len = secondsAgos.length;
        tickCumulatives = new int56[](len);
        secondsPerLiquidityCumulativeX128s = new uint160[](len);
        int56 baseCumulative = int56(twapTick) * int56(uint56(block.timestamp));
        for (uint256 i = 0; i < len; ++i) {
            tickCumulatives[i] = baseCumulative - (int56(twapTick) * int56(uint56(secondsAgos[i])));
            secondsPerLiquidityCumulativeX128s[i] = 0;
        }
    }
}
