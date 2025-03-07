export const ERRORS = {
  AccessControlUnauthorizedAccount: "AccessControlUnauthorizedAccount",
  Bitwise_BitIndexOutOfBounds: "Bitwise_BitIndexOutOfBounds",
  ERC20InsufficientBalance: "ERC20InsufficientBalance",
  InvalidInitialization: "InvalidInitialization",
  NotInitializing: "NotInitializing",
  SafeCastOverflowedUintDowncast: "SafeCastOverflowedUintDowncast",
  YieldStreamer_AccountAlreadyInitialized: "YieldStreamer_AccountAlreadyInitialized",
  YieldStreamer_AccountInitializationProhibited: "YieldStreamer_AccountInitializationProhibited",
  YieldStreamer_AccountNotInitialized: "YieldStreamer_AccountNotInitialized",
  YieldStreamer_ClaimAmountBelowMinimum: "YieldStreamer_ClaimAmountBelowMinimum",
  YieldStreamer_ClaimAmountNonRounded: "YieldStreamer_ClaimAmountNonRounded",
  YieldStreamer_EmptyArray: "YieldStreamer_EmptyArray",
  YieldStreamer_FeeReceiverAlreadyConfigured: "YieldStreamer_FeeReceiverAlreadyConfigured",
  YieldStreamer_GroupAlreadyAssigned: "YieldStreamer_GroupAlreadyAssigned",
  YieldStreamer_HookCallerUnauthorized: "YieldStreamer_HookCallerUnauthorized",
  YieldStreamer_ImplementationAddressInvalid: "YieldStreamer_ImplementationAddressInvalid",
  YieldStreamer_SourceYieldStreamerAlreadyConfigured: "YieldStreamer_SourceYieldStreamerAlreadyConfigured",
  YieldStreamer_SourceYieldStreamerGroupAlreadyMapped: "YieldStreamer_SourceYieldStreamerGroupAlreadyMapped",
  YieldStreamer_SourceYieldStreamerNotConfigured: "YieldStreamer_SourceYieldStreamerNotConfigured",
  YieldStreamer_SourceYieldStreamerUnauthorizedBlocklister: "YieldStreamer_SourceYieldStreamerUnauthorizedBlocklister",
  YieldStreamer_TimeRangeInvalid: "YieldStreamer_TimeRangeInvalid",
  YieldStreamer_TimeRangeIsInvalid: "YieldStreamer_TimeRangeIsInvalid",
  YieldStreamer_TokenAddressZero: "YieldStreamer_TokenAddressZero",
  YieldStreamer_YieldBalanceInsufficient: "YieldStreamer_YieldBalanceInsufficient",
  YieldStreamer_YieldRateArrayIsEmpty: "YieldStreamer_YieldRateArrayIsEmpty",
  YieldStreamer_YieldRateInvalidEffectiveDay: "YieldStreamer_YieldRateInvalidEffectiveDay",
  YieldStreamer_YieldRateInvalidItemIndex: "YieldStreamer_YieldRateInvalidItemIndex"
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

export function normalizeYieldRate(rate: YieldRate): YieldRate {
  return {
    effectiveDay: rate.effectiveDay,
    tiers: rate.tiers.map((tier: RateTier) => ({
      rate: tier.rate,
      cap: tier.cap
    }))
  };
}

export function normalizeYieldResult(result: YieldResult): YieldResult {
  return {
    partialFirstDayYield: result.partialFirstDayYield,
    fullDaysYield: result.fullDaysYield,
    partialLastDayYield: result.partialLastDayYield,
    partialFirstDayYieldTiered: [...result.partialFirstDayYieldTiered],
    fullDaysYieldTiered: [...result.fullDaysYieldTiered],
    partialLastDayYieldTiered: [...result.partialLastDayYieldTiered]
  };
}

export function normalizeAccruePreview(result: AccruePreview): AccruePreview {
  return {
    fromTimestamp: result.fromTimestamp,
    toTimestamp: result.toTimestamp,
    balance: result.balance,
    streamYieldBefore: result.streamYieldBefore,
    accruedYieldBefore: result.accruedYieldBefore,
    streamYieldAfter: result.streamYieldAfter,
    accruedYieldAfter: result.accruedYieldAfter,
    rates: result.rates.map((r: YieldRate) => ({
      tiers: r.tiers.map((t: RateTier) => ({
        rate: t.rate,
        cap: t.cap
      })),
      effectiveDay: r.effectiveDay
    })),
    results: result.results.map(normalizeYieldResult)
  };
}

export function normalizeClaimPreview(claimPreview: ClaimPreview): ClaimPreview {
  return {
    yieldExact: claimPreview.yieldExact,
    yieldRounded: claimPreview.yieldRounded,
    feeExact: claimPreview.feeExact,
    feeRounded: claimPreview.feeRounded,
    timestamp: claimPreview.timestamp,
    balance: claimPreview.balance,
    rates: [...claimPreview.rates],
    caps: [...claimPreview.caps]
  };
}

export function roundDown(amount: bigint): bigint {
  return (amount / ROUND_FACTOR) * ROUND_FACTOR;
}

export function adjustTimestamp(timestamp: number | bigint): bigint {
  return BigInt(timestamp) - NEGATIVE_TIME_SHIFT;
}

export function normalizeTimestamp(timestamp: number | bigint): number {
  return Number(BigInt(timestamp) + NEGATIVE_TIME_SHIFT);
}
