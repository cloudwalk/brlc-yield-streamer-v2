// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

/**
 * @dev IYieldStreamerTypes Interface
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 * @dev Defines the data structures and enumerations for the yield streamer contract.
 */
interface IYieldStreamerTypes {
    /**
     * @dev Enumeration of possible flag indices for the yield state.
     * Used to manage boolean flags within the `YieldState` structure using bitwise operations.
     *
     * Values:
     * - `Initialized`: Indicates whether the yield state has been initialized.
     */
    enum YieldStateFlagIndex {
        Initialized
    }

    /**
     * @dev Structure representing a group to which accounts can be assigned.
     * Used to identify the group of accounts that share the same yield rate.
     *
     * Fields:
     * - `id`: The unique identifier of the group.
     */
    struct Group {
        uint32 id;
        // uint224 __reserved; // Reserved for future use until the end of the storage slot.
    }

    /**
     * @dev Structure representing a yield rate that becomes effective from a specific day.
     * Contains multiple tiers, each applying a specific rate up to a balance cap.
     *
     * Fields:
     * - `effectiveDay`: The day index from which this yield rate becomes effective.
     * - `tiers`: An array of `RateTier` structs defining the rate tiers.
     */
    struct YieldRate {
        RateTier[] tiers;
        uint16 effectiveDay;
        // uint240 __reserved; // Reserved for future use until the end of the storage slot.
    }

    /**
     * @dev Structure representing a rate tier within a yield rate.
     * Applies a specific rate to a portion of the balance up to a specified cap.
     *
     * Fields:
     * - `rate`: The yield rate value (scaled by RATE_FACTOR).
     * - `cap`: The maximum balance amount for which this rate applies.
     */
    struct RateTier {
        uint48 rate;
        uint64 cap;
        // uint144 __reserved; // Reserved for future use until the end of the storage slot.
    }

    /**
     * @dev Structure representing the yield state of an account.
     * Used to store information about the account's yield accrual and balances.
     *
     * Fields:
     * - `flags`: A byte used to store boolean flags using bitwise operations (e.g., initialization status).
     * - `streamYield`: The amount of yield accrued during the current day (not yet finalized).
     * - `accruedYield`: The total amount of yield accrued and finalized up to the last update.
     * - `lastUpdateTimestamp`: The timestamp of the last yield accrual or balance update.
     * - `lastUpdateBalance`: The account's token balance at the time of the last update.
     */
    struct YieldState {
        uint8 flags;
        uint64 streamYield;
        uint64 accruedYield;
        uint40 lastUpdateTimestamp;
        uint64 lastUpdateBalance;
        // uint16 __reserved; // Reserved for future use until the end of the storage slot.
    }

    /**
     * @dev Structure representing a preview of the claimable yield for an account.
     * Used to estimate the yield that can be claimed without modifying the contract state.
     *
     * Fields:
     * - `yieldExact`: The total claimable yield amount available for the account (without rounding).
     * - `feeExact`: The fee amount that would be deducted during the claim (without rounding).
     * - `yieldRounded`: The total claimable yield amount available for the account (rounded).
     * - `feeRounded`: The fee amount that would be deducted during the claim (rounded).
     * - `timestamp`: The timestamp at which the preview was calculated.
     * - `balance`: The account's token balance used in the calculation.
     * - `rates`: The current yield rates applicable to the account.
     * - `caps`: The current rate caps applicable to the account.
     */
    struct ClaimPreview {
        uint256 yieldExact;
        uint256 feeExact;
        uint256 yieldRounded;
        uint256 feeRounded;
        uint256 timestamp;
        uint256 balance;
        uint256[] rates;
        uint256[] caps;
    }

    /**
     * @dev Structure representing a preview of the yield accrual over a period for an account.
     * Provides detailed information about how the yield would accrue without modifying the state.
     *
     * Fields:
     * - `fromTimestamp`: The starting timestamp of the accrual period.
     * - `toTimestamp`: The ending timestamp of the accrual period.
     * - `balance`: The account's token balance at the beginning of the period.
     * - `accruedYieldBefore`: The accrued yield before the accrual period.
     * - `streamYieldBefore`: The stream yield before the accrual period.
     * - `accruedYieldAfter`: The accrued yield after the accrual period.
     * - `streamYieldAfter`: The stream yield after the accrual period.
     * - `rates`: An array of `YieldRate` structs used during the accrual period.
     * - `results`: An array of `YieldResult` structs detailing yield calculations for sub-periods.
     */
    struct AccruePreview {
        uint256 fromTimestamp;
        uint256 toTimestamp;
        uint256 balance;
        uint256 streamYieldBefore;
        uint256 accruedYieldBefore;
        uint256 streamYieldAfter;
        uint256 accruedYieldAfter;
        YieldRate[] rates;
        YieldResult[] results;
    }

    /**
     * @dev Structure representing the result of a yield calculation for a specific period.
     * Details the yield accrued during different parts of the period (partial days and full days).
     *
     * Fields:
     * - `partialFirstDayYield`: Yield accrued during the partial first day of the period.
     * - `fullDaysYield`: Total yield accrued during the full days within the period.
     * - `partialLastDayYield`: Yield accrued during the partial last day of the period.
     */
    struct YieldResult {
        uint256 partialFirstDayYield;
        uint256 fullDaysYield;
        uint256 partialLastDayYield;
        uint256[] partialFirstDayYieldTiered;
        uint256[] fullDaysYieldTiered;
        uint256[] partialLastDayYieldTiered;
    }
}
