// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Zero-dependency Foundry Vm cheatcode interface so `forge test` runs offline without external git submodules.
interface Vm {
    function warp(uint256 newTimestamp) external;
    function roll(uint256 newHeight) external;
    function chainId(uint256 newChainId) external;
    function prank(address msgSender) external;
    function startPrank(address msgSender) external;
    function stopPrank() external;
    function deal(address account, uint256 newBalance) external;
    function addr(uint256 privateKey) external pure returns (address);
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function expectRevert() external;
    function expectRevert(bytes4 revertData) external;
    function expectRevert(bytes calldata revertData) external;
    function assume(bool condition) external pure;
    function envUint(string calldata name) external view returns (uint256);
    function envAddress(string calldata name) external view returns (address);
    function startBroadcast(uint256 privateKey) external;
    function startBroadcast() external;
    function stopBroadcast() external;
}

abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertTrue(bool condition, string memory message) internal pure {
        require(condition, message);
    }

    function assertFalse(bool condition, string memory message) internal pure {
        require(!condition, message);
    }

    function assertEq(uint256 a, uint256 b, string memory message) internal pure {
        require(a == b, message);
    }

    function assertEq(address a, address b, string memory message) internal pure {
        require(a == b, message);
    }

    function assertEq(bytes32 a, bytes32 b, string memory message) internal pure {
        require(a == b, message);
    }

    function assertGt(uint256 a, uint256 b, string memory message) internal pure {
        require(a > b, message);
    }

    function assertGe(uint256 a, uint256 b, string memory message) internal pure {
        require(a >= b, message);
    }

    function assertLe(uint256 a, uint256 b, string memory message) internal pure {
        require(a <= b, message);
    }

    function assertApproxEqRel(uint256 a, uint256 b, uint256 maxPercentDelta18, string memory message) internal pure {
        if (b == 0) {
            require(a == 0, message);
            return;
        }
        uint256 diff = a > b ? a - b : b - a;
        require((diff * 1e18) / b <= maxPercentDelta18, message);
    }

    function bound(uint256 x, uint256 min, uint256 max) internal pure returns (uint256) {
        require(min <= max, "BOUND_RANGE");
        if (x >= min && x <= max) return x;
        uint256 size = max - min + 1;
        return min + (x % size);
    }
}
