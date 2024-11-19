// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import { IYieldStreamerV1 } from "../interfaces/IYieldStreamerV1.sol";

contract YieldStreamerV1Mock is IYieldStreamerV1 {
    bool blocklisterStatus = true;

    function claimAllPreview(address account) external view returns (ClaimResult memory) {
        return ClaimResult(0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    }

    function blocklist(address account) external {
        return;
    }

    function isBlocklister(address account) external view returns (bool) {
        return blocklisterStatus;
    }

    function setBlocklisterStatus(bool status) external {
        blocklisterStatus = status;
    }

    function getAccountGroup(address account) external view returns (bytes32) {
        return bytes32(uint(1));
    }
}
