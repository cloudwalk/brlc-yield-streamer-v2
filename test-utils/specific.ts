export const ERRORS = {
  AccessControlUnauthorizedAccount: "AccessControlUnauthorizedAccount",
  ERC20InsufficientBalance: "ERC20InsufficientBalance",
  InvalidInitialization: "InvalidInitialization",
  NotInitializing: "NotInitializing",
  YieldStreamer_AccountNotInitialized: "YieldStreamer_AccountNotInitialized",
  YieldStreamer_ClaimAmountBelowMinimum: "YieldStreamer_ClaimAmountBelowMinimum",
  YieldStreamer_ClaimAmountNonRounded: "YieldStreamer_ClaimAmountNonRounded",
  YieldStreamer_FeeReceiverNotConfigured: "YieldStreamer_FeeReceiverNotConfigured",
  YieldStreamer_HookCallerUnauthorized: "YieldStreamer_HookCallerUnauthorized",
  YieldStreamer_ImplementationAddressInvalid: "YieldStreamer_ImplementationAddressInvalid",
  YieldStreamer_NoYieldRatesInRange: "YieldStreamer_NoYieldRatesInRange",
  YieldStreamer_TimeRangeInvalid: "YieldStreamer_TimeRangeInvalid",
  YieldStreamer_TimeRangeIsInvalid: "YieldStreamer_TimeRangeIsInvalid",
  YieldStreamer_YieldBalanceInsufficient: "YieldStreamer_YieldBalanceInsufficient",
  YieldStreamer_YieldRateArrayIsEmpty: "YieldStreamer_YieldRateArrayIsEmpty"
};

export const HOUR = 3600n; // 1 hour (in seconds)
export const DAY = 24n * HOUR; // 1 day (in seconds)

export const RATE_FACTOR = 1_000_000_000_000n; // 10^12
export const ROUND_FACTOR = 10_000n; // 10^4
export const FEE_RATE = 0n;
export const NEGATIVE_TIME_SHIFT = 3n * HOUR; // 3 hours
export const MIN_CLAIM_AMOUNT = 1_000_000n; // 1 BRLC
export const ENABLE_YIELD_STATE_AUTO_INITIALIZATION = false;

export interface YieldState {
  flags: bigint;
  streamYield: bigint;
  accruedYield: bigint;
  lastUpdateTimestamp: bigint;
  lastUpdateBalance: bigint;
}

export interface RateTier {
  rate: bigint;
  cap: bigint;
}

export interface YieldRate {
  tiers: RateTier[];
  effectiveDay: bigint;
}

export interface YieldResult {
  partialFirstDayYield: bigint;
  fullDaysYield: bigint;
  partialLastDayYield: bigint;
  partialFirstDayYieldTiered: bigint[];
  fullDaysYieldTiered: bigint[];
  partialLastDayYieldTiered: bigint[];
}

export interface AccruePreview {
  fromTimestamp: bigint;
  toTimestamp: bigint;
  balance: bigint;
  streamYieldBefore: bigint;
  accruedYieldBefore: bigint;
  streamYieldAfter: bigint;
  accruedYieldAfter: bigint;
  rates: YieldRate[];
  results: YieldResult[];
}

export interface ClaimPreview {
  yieldExact: bigint;
  yieldRounded: bigint;
  feeExact: bigint;
  feeRounded: bigint;
  timestamp: bigint;
  balance: bigint;
  rates: bigint[];
  caps: bigint[];
}

export const defaultYieldState: YieldState = {
  flags: 0n,
  streamYield: 0n,
  accruedYield: 0n,
  lastUpdateTimestamp: 0n,
  lastUpdateBalance: 0n
};
