// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import { YieldStreamer } from "../YieldStreamer.sol";
import { Bitwise } from "../libs/Bitwise.sol";

/**
 * @title YieldStreamerTestable contract
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 * @dev Implements additional functions to test internal functions of the yield streamer contract.
 */
contract YieldStreamerTestable is YieldStreamer {
    // ------------------ Internal initializers ------------------- //

    function call_parent_initialize(address underlyingToken) external {
        __YieldStreamer_init(underlyingToken);
    }

    function call_parent_initialize_unchained(address underlyingToken) external {
        __YieldStreamer_init_init_unchained(underlyingToken);
    }

    // ------------------ Setters for storage structures ---------- //

    function setYieldState(address account, YieldState calldata newState) external {
        _yieldStreamerStorage().yieldStates[account] = newState;
    }

    // ------------------ Getters for storage structures ---------- //

    function getSourceGroupMapping(bytes32 groupKey) external view returns (uint256) {
        return _yieldStreamerInitializationStorage().groupIds[groupKey];
    }

    // ------------------ Account initializers -------------------- //

    function initializeSingleAccount(address account) external {
        _initializeSingleAccount(account);
    }

    // ------------------ Yield calculation ----------------------- //

    function getAccruePreview(
        YieldState memory state,
        YieldRate[] memory rates,
        uint256 currentTimestamp
    ) external view returns (AccruePreview memory) {
        return _getAccruePreview(state, rates, currentTimestamp);
    }

    function calculateYield(
        CalculateYieldParams memory params,
        YieldRate[] memory rates
    ) external pure returns (YieldResult[] memory) {
        return _calculateYield(params, rates);
    }

    function compoundYield(CompoundYieldParams memory params) external pure returns (YieldResult memory) {
        return _compoundYield(params);
    }

    function calculateTieredYield(
        uint256 amount,
        uint256 elapsedSeconds,
        RateTier[] memory tiers
    ) external pure returns (uint256, uint256[] memory) {
        return _calculateTieredYield(amount, elapsedSeconds, tiers);
    }

    function calculateSimpleYield(
        uint256 amount,
        uint256 rate,
        uint256 elapsedSeconds
    ) external pure returns (uint256) {
        return _calculateSimpleYield(amount, rate, elapsedSeconds);
    }

    function inRangeYieldRates(
        YieldRate[] memory rates,
        uint256 fromTimestamp,
        uint256 toTimestamp
    ) external pure returns (uint256, uint256) {
        return _inRangeYieldRates(rates, fromTimestamp, toTimestamp);
    }

    function aggregateYield(YieldResult[] memory yieldResults) external pure returns (uint256, uint256) {
        return _aggregateYield(yieldResults);
    }

    // ------------------ Timestamp ------------------------------- //

    function effectiveTimestamp(uint256 timestamp) external pure returns (uint256) {
        return _effectiveTimestamp(timestamp);
    }

    // ------------------ Utility --------------------------------- //

    function truncateArray(
        uint256 startIndex,
        uint256 endIndex,
        YieldRate[] memory rates
    ) external pure returns (YieldRate[] memory) {
        return _truncateArray(startIndex, endIndex, rates);
    }

    function calculateFee(uint256 amount) external pure returns (uint256) {
        return _calculateFee(amount);
    }

    function roundDown(uint256 amount) external pure returns (uint256) {
        return _roundDown(amount);
    }

    function roundUp(uint256 amount) external pure returns (uint256) {
        return _roundUp(amount);
    }

    function map(AccruePreview memory accrue) external pure returns (ClaimPreview memory) {
        return _map(accrue);
    }

    // ------------------ Bitwise functions ----------------------- //

    function setBit(uint8 flags, uint256 bitIndex) external pure returns (uint8) {
        return Bitwise.setBit(flags, bitIndex);
    }

    function clearBit(uint8 flags, uint256 bitIndex) external pure returns (uint8) {
        return Bitwise.clearBit(flags, bitIndex);
    }

    function isBitSet(uint8 flags, uint256 bitIndex) external pure returns (bool) {
        return Bitwise.isBitSet(flags, bitIndex);
    }
}
