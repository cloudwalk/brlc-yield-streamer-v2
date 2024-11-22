// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import { YieldStreamer } from "../YieldStreamer.sol";

/**
 * @title YieldStreamerMock contract
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 * @dev An extension of the {YieldStreamer} contract for testing purposes.
 */
contract YieldStreamerMock is YieldStreamer
{
    function getGroupId(bytes32 groupKey) external view returns (uint256) {
        YieldStreamerInitializationStorageLayout storage $init = _yieldStreamerInitializationStorage();
        return $init.groupIds[groupKey];
    }
}