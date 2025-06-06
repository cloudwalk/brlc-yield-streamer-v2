// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

/**
 * @title IYieldStreamerConfiguration_Errors interface
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 * @dev Defines the custom errors used by the yield streamer configuration contract.
 */
interface IYieldStreamerConfiguration_Errors {
    /// @dev Thrown when a yield rate item index provided is invalid (out of bounds).
    error YieldStreamer_YieldRateInvalidItemIndex();

    /// @dev Thrown when the effective day for a yield rate is invalid or out of sequence.
    error YieldStreamer_YieldRateInvalidEffectiveDay();

    /// @dev Thrown when attempting to add a yield rate that is already configured with the same value.
    error YieldStreamer_YieldRateAlreadyConfigured();

    /// @dev Thrown when the fee receiver has already been configured to the specified address.
    error YieldStreamer_FeeReceiverAlreadyConfigured();

    /// @dev Thrown when attempting to assign an account to a group it is already assigned to.
    error YieldStreamer_GroupAlreadyAssigned(address account);

    /// @dev Thrown when the yield streamer contract is already archived.
    error YieldStreamer_ContractAlreadyArchived();
}

/**
 * @title IYieldStreamerConfiguration_Events interface
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 * @dev Defines the events emitted by the yield streamer configuration contract.
 */
interface IYieldStreamerConfiguration_Events {
    /**
     * @dev Emitted when an account is assigned to a new group.
     *
     * @param account The address of the account being assigned.
     * @param newGroupId The ID of the new group the account is assigned to.
     * @param oldGroupId The ID of the group the account was previously assigned to.
     */
    event YieldStreamer_GroupAssigned(
        address indexed account, // Tools: this comment prevents Prettier from formatting into a single line.
        uint256 indexed newGroupId,
        uint256 indexed oldGroupId
    );

    /**
     * @dev Emitted when a new yield rate is added for a group.
     *
     * @param groupId The ID of the group the yield rate is added to.
     * @param effectiveDay The day index from which the yield rate becomes effective.
     * @param tierRates The yield rate value for each tier (scaled by RATE_FACTOR).
     * @param tierCaps The balance cap for each tier.
     */
    event YieldStreamer_YieldRateAdded(
        uint256 indexed groupId, // Tools: this comment prevents Prettier from formatting into a single line.
        uint256 effectiveDay,
        uint256[] tierRates,
        uint256[] tierCaps
    );

    /**
     * @dev Emitted when an existing yield rate is updated for a group.
     *
     * @param groupId The ID of the group the yield rate is updated for.
     * @param itemIndex The index of the yield rate in the group's rate array.
     * @param effectiveDay The new effective day for the yield rate.
     * @param tierRates The new yield rate value for each tier (scaled by RATE_FACTOR).
     * @param tierCaps The new balance cap for each tier.
     */
    event YieldStreamer_YieldRateUpdated(
        uint256 indexed groupId,
        uint256 itemIndex,
        uint256 effectiveDay,
        uint256[] tierRates,
        uint256[] tierCaps
    );

    /**
     * @dev Emitted when the fee receiver address is changed.
     *
     * @param newFeeReceiver The new fee receiver address.
     * @param oldFeeReceiver The previous fee receiver address.
     */
    event YieldStreamer_FeeReceiverChanged(
        address indexed newFeeReceiver, // Tools: this comment prevents Prettier from formatting into a single line.
        address indexed oldFeeReceiver
    );

    /**
     * @dev Emitted when the archived state of the yield streamer contract is changed.
     *
     * @param isArchived The new archived state of the yield streamer contract.
     */
    event YieldStreamer_IsArchivedChanged(bool isArchived);
}

/**
 * @title IYieldStreamerConfiguration_Functions interface
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 * @dev Defines the function signatures for the yield streamer configuration contract.
 */
interface IYieldStreamerConfiguration_Functions {
    /**
     * @dev Sets the archived state of the yield streamer contract.
     * When archived, yield calculation functions return zeroed values.
     *
     * @param isArchived If true, the yield streamer is considered archived.
     */
    function setIsArchived(bool isArchived) external;

    /**
     * @dev Adds a new yield rate for a specific group.
     * The yield rate becomes effective starting from the specified effective day.
     *
     * @param groupId The ID of the group to which the yield rate is added.
     * @param effectiveDay The day index from which the yield rate becomes effective.
     * @param tierRates The yield rate value for each tier (scaled by RATE_FACTOR).
     * @param tierCaps The balance cap for each tier.
     */
    function addYieldRate(
        uint256 groupId,
        uint256 effectiveDay,
        uint256[] memory tierRates,
        uint256[] memory tierCaps
    ) external;

    /**
     * @dev Updates an existing yield rate for a specific group at a given index.
     *
     * @param groupId The ID of the group whose yield rate is being updated.
     * @param itemIndex The index of the yield rate to update within the group's rate array.
     * @param effectiveDay The new effective day for the yield rate.
     * @param tierRates The new yield rate value for each tier (scaled by RATE_FACTOR).
     * @param tierCaps The new balance cap for each tier.
     */
    function updateYieldRate(
        uint256 groupId,
        uint256 itemIndex,
        uint256 effectiveDay,
        uint256[] memory tierRates,
        uint256[] memory tierCaps
    ) external;

    /**
     * @dev Assigns a group to multiple accounts.
     * Optionally forces yield accrual for the accounts before assignment.
     *
     * @param groupId The ID of the group to assign the accounts to.
     * @param accounts An array of account addresses to assign to the group.
     * @param forceYieldAccrue If true, accrues yield for the accounts before assignment.
     */
    function assignGroup(uint256 groupId, address[] memory accounts, bool forceYieldAccrue) external;

    /**
     * @dev Sets the fee receiver address for the yield streamer.
     * The fee receiver collects fees deducted during yield claims.
     *
     * @param newFeeReceiver The new fee receiver address.
     */
    function setFeeReceiver(address newFeeReceiver) external;
}

/**
 * @title IYieldStreamerConfiguration interface
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 * @dev Defines the interface for the yield streamer configuration contract
 * by combining the types, errors, events and functions interfaces.
 */
interface IYieldStreamerConfiguration is
    IYieldStreamerConfiguration_Errors,
    IYieldStreamerConfiguration_Events,
    IYieldStreamerConfiguration_Functions
{
    // Empty interface to combine errors, events, and functions
}
