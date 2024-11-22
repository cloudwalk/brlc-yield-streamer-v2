// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import { IYieldStreamerV1 } from "../interfaces/IYieldStreamerV1.sol";

/**
 * @title YieldStreamerV1Mock contract
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 * @dev An implementation of the {YieldStreamerV1} contract for testing purposes.
 */
contract YieldStreamerV1Mock is IYieldStreamerV1 {
    // Errors
    error YieldStreamerV1Mock_NotImplemented();

    // ------------------ Storage---- ----------------------------- //

    mapping(address => ClaimResult) private _claimAllPreview;
    mapping(address => bool) private _isBlocklister;

    // ------------------ IYieldStreamerV1 ------------------------ //

    /**
     * @inheritdoc IYieldStreamerV1
     */
    function claimAllPreview(address account) external view returns (ClaimResult memory) {
        return _claimAllPreview[account];
    }

    /**
     * @inheritdoc IYieldStreamerV1
     */
    function blocklist(address account) external {
        // revert YieldStreamerV1Mock_NotImplemented();
    }

    /**
     * @inheritdoc IYieldStreamerV1
     */
    function isBlocklister(address account) external view returns (bool) {
        //revert YieldStreamerV1Mock_NotImplemented();
        return true;
    }

    /**
     * @inheritdoc IYieldStreamerV1
     */
    function getAccountGroup(address account) external view returns (bytes32) {
        //revert YieldStreamerV1Mock_NotImplemented();
        return bytes32(0);
    }

    // ------------------ Functions ------------------------------- //

    /**
     * @dev Sets the preview result for a given account.
     * @param account The address of the account to set the preview for.
     * @param preview The preview result to set for the account.
     */
    function setClaimAllPreview(address account, ClaimResult memory preview) external {
        _claimAllPreview[account] = preview;
    }

    /**
     * @dev Sets the blocklister status for a given account.
     * @param account The address of the account to set the blocklister status for.
     * @param isBlocklister_ The blocklister status to set for the account.
     */
    function setBlocklister(address account, bool isBlocklister_) external {
        _isBlocklister[account] = isBlocklister_;
    }
}
