import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { Contract, ContractFactory } from "ethers";
import {
  AccruePreview,
  ClaimPreview,
  DAY,
  ERRORS,
  HOUR,
  RATE_FACTOR,
  RateTier,
  ROUND_FACTOR,
  YieldRate,
  YieldResult,
  YieldState
} from "../test-utils/specific";
import { getAddress } from "../test-utils/eth";
import { setUpFixture } from "../test-utils/common";

const INITIAL_DAY_INDEX = 21_000n; // 21000 days
const INITIAL_TIMESTAMP = INITIAL_DAY_INDEX * DAY;

interface Fixture {
  yieldStreamer: Contract;
  tokenMock: Contract;
}

/*
 * Acronyms:
 * - IB --- initial balance;
 * - FDi -- full day number i, e.g. FD2 -- full day number 2;
 * - PFD -- partial first day;
 * - PLD -- partial last day;
 * - SY --- stream yield.
 */

describe("Contract 'YieldStreamer' regarding internal functions", async () => {
  let yieldStreamerTestableFactory: ContractFactory;

  before(async () => {
    yieldStreamerTestableFactory = await ethers.getContractFactory("YieldStreamerTestable");
  });

  async function deployContracts(): Promise<Fixture> {
    const tokenMockFactory = await ethers.getContractFactory("ERC20TokenMock");
    const tokenMock = await tokenMockFactory.deploy("Mock Token", "MTK");
    await tokenMock.waitForDeployment();
    const tokenMockAddress = getAddress(tokenMock);

    const yieldStreamer: Contract = await upgrades.deployProxy(yieldStreamerTestableFactory, [tokenMockAddress]);
    await yieldStreamer.waitForDeployment();

    return { yieldStreamer, tokenMock };
  }

  function roundDown(amount: bigint): bigint {
    return (amount / ROUND_FACTOR) * ROUND_FACTOR;
  }

  function createSampleYieldRates(count: number): YieldRate[] {
    const rates: YieldRate[] = [];

    // Build the yield rates array.
    for (let i = 0n; i < count; i++) {
      rates.push({
        tiers: [{
          rate: i,
          cap: i
        }],
        effectiveDay: i
      });
    }

    return rates;
  }

  function normalizeYieldRate(rate: YieldRate): YieldRate {
    return {
      effectiveDay: rate.effectiveDay,
      tiers: rate.tiers.map((tier: RateTier) => ({
        rate: tier.rate,
        cap: tier.cap
      }))
    };
  }

  function normalizeYieldResult(result: YieldResult): YieldResult {
    return {
      partialFirstDayYield: result.partialFirstDayYield,
      fullDaysYield: result.fullDaysYield,
      partialLastDayYield: result.partialLastDayYield,
      partialFirstDayYieldTiered: [...result.partialFirstDayYieldTiered],
      fullDaysYieldTiered: [...result.fullDaysYieldTiered],
      partialLastDayYieldTiered: [...result.partialLastDayYieldTiered]
    };
  }

  function normalizeAccruePreview(result: AccruePreview): AccruePreview {
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
      results: result.results.map((r: YieldResult) => ({
        partialFirstDayYield: r.partialFirstDayYield,
        fullDaysYield: r.fullDaysYield,
        partialLastDayYield: r.partialLastDayYield,
        partialFirstDayYieldTiered: [...r.partialFirstDayYieldTiered],
        fullDaysYieldTiered: [...r.fullDaysYieldTiered],
        partialLastDayYieldTiered: [...r.partialLastDayYieldTiered]
      }))
    };
  }

  function normalizeClaimPreview(claimPreview: ClaimPreview): ClaimPreview {
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

  function simpleYield(amount: bigint, rate: bigint, elapsedSeconds: bigint): bigint {
    return (amount * rate * elapsedSeconds) / (DAY * RATE_FACTOR);
  }

  describe("Function '_getAccruePreview()'", async () => {
    interface GetAccruePreviewTestCase {
      description: string;
      state: YieldState;
      rates: YieldRate[];
      currentTimestamp: bigint;
      expected: AccruePreview;
    }

    const testCases: GetAccruePreviewTestCase[] = [
      {
        description: "Single yield rate period",
        state: {
          lastUpdateTimestamp: INITIAL_TIMESTAMP + HOUR * 6n,
          lastUpdateBalance: 3000000n,
          streamYield: 1000000n,
          accruedYield: 2000000n,
          flags: 0n
        },
        rates: [
          {
            tiers: [
              { rate: RATE_FACTOR / 1000n, cap: 0n } // - 0.1% rate, no cap
            ],
            effectiveDay: 0n
          },
          {
            tiers: [
              { rate: (RATE_FACTOR / 100n) * 3n, cap: 1000000n }, // - 3% rate, cap 1000000
              { rate: (RATE_FACTOR / 100n) * 2n, cap: 1000000n }, // - 2% rate, cap 1000000
              { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n } // -------- 1% rate, no cap
            ],
            effectiveDay: INITIAL_DAY_INDEX
          }
        ],
        currentTimestamp: INITIAL_TIMESTAMP + DAY * 3n + HOUR * 6n,
        expected: {
          fromTimestamp: INITIAL_TIMESTAMP + HOUR * 6n,
          toTimestamp: INITIAL_TIMESTAMP + DAY * 3n + HOUR * 6n,
          balance: 3000000n,
          streamYieldBefore: 1000000n,
          accruedYieldBefore: 2000000n,
          accruedYieldAfter:
            2000000n + // -------------- Initial accrued yield
            1000000n + // -------------- Initial stream yield
            60000n + // ---------------- PFD yield
            90600n + // ---------------- FD1 yield
            91506n, // ----------------- FD2 yield
          streamYieldAfter: 23105n, // - PLD yield
          rates: [
            {
              tiers: [
                { rate: (RATE_FACTOR / 100n) * 3n, cap: 1000000n }, // - 3% rate, cap 1000000
                { rate: (RATE_FACTOR / 100n) * 2n, cap: 1000000n }, // - 2% rate, cap 1000000
                { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n } // -------- 1% rate, no cap
              ],
              effectiveDay: INITIAL_DAY_INDEX
            }
          ],
          results: [
            {
              partialFirstDayYield:
              // PFD Total: 1000000 + 60000 = 1060000
                1000000n + // - Stream yield
                22500n + // --- T1: 3% on 1000000 for 18 hours (Initial balance)
                15000n + // --- T2: 2% on 2000000 for 18 hours (Initial balance)
                22500n, // ---- T3: 1% on 3000000 for 18 hours (Initial balance)
              fullDaysYield:
              // FD1 Total: 90600
                30000n + // - T1: 3% on 1000000 for 1 day (Initial balance)
                20000n + // - T2: 2% on 1000000 for 1 day (Initial balance)
                40600n + // - T3: 1% on 3000000 + 1000000 + 60000 for 1 day (IB + SY + PFD)
                // ------
                // FD2 Total: 91506
                30000n + // - T1: 3% on 1000000 for 1 day (Initial balance)
                20000n + // - T2: 2% on 1000000 for 1 day (Initial balance)
                41506n, // -- T3: 1% on 3000000 + 1000000 + 60000 + 90600 for 1 day (IB + SY + PFD + FD1)
              partialLastDayYield:
              // PLD Total: 23105
                7500n + // - T1: 3% on 1000000 for 6 hours (Initial balance)
                5000n + // - T2: 2% on 1000000 for 6 hours (Initial balance)
                10605n, // - T3: 1% on 3000000 + 1000000 + 60000 + 90600 for 6 hours (IB + SY + PFD + FD1)
              partialFirstDayYieldTiered: [
                // PFD Total: 60000
                simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, HOUR * 18n), // - PFD T1: 22500
                simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, HOUR * 18n), // - PFD T2: 15000
                simpleYield(3000000n, (RATE_FACTOR / 100n) * 1n, HOUR * 18n) // -- PFD T3: 22500
              ],
              fullDaysYieldTiered: [
                // FD1 + FD2 Total: 182106
                // FD1 Total: 30000 + 20000 + 40600 = 90600
                // FD2 Total: 30000 + 20000 + 41506 = 91506
                simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, DAY) + // - FD1 T1: 30000
                simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, DAY), // -- FD2 T1: 30000
                simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, DAY) + // - FD1 T2: 20000
                simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, DAY), // -- FD2 T2: 20000
                simpleYield(
                  3000000n + // - Initial balance
                  1000000n + // - Stream yield
                  60000n, // ---- PFD yield
                  (RATE_FACTOR / 100n) * 1n,
                  DAY
                ) + // ----------------------------------------------------- FD1 T3: 40600
                simpleYield(
                  3000000n + // - Initial balance
                  1000000n + // - Stream yield
                  60000n + // --- PFD yield
                  90600n, // ---- FD1 yield
                  (RATE_FACTOR / 100n) * 1n,
                  DAY
                ) // ------------------------------------------------------- FD2 T3: 41506
              ],
              partialLastDayYieldTiered: [
                // PLD Total: 23105
                simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, HOUR * 6n), // - PLD T1: 7500
                simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, HOUR * 6n), // - PLD T2: 5000
                simpleYield(
                  3000000n + // - Initial balance
                  1000000n + // - Stream yield
                  60000n + // --- PFD yield
                  90600n + // --- FD1 yield
                  91506n, // ---- FD2 yield
                  (RATE_FACTOR / 100n) * 1n,
                  HOUR * 6n
                ) // ------------------------------------------------------------- PLD T3: 10605
              ]
            }
          ]
        }
      },
      {
        description: "Two yield rate periods",
        state: {
          lastUpdateTimestamp: INITIAL_TIMESTAMP + HOUR * 6n,
          lastUpdateBalance: 3000000n,
          streamYield: 1000000n,
          accruedYield: 2000000n,
          flags: 0n
        },
        rates: [
          {
            tiers: [
              { rate: RATE_FACTOR / 1000n, cap: 0n } // - 0.1% rate, no cap
            ],
            effectiveDay: 0n
          },
          {
            tiers: [
              { rate: (RATE_FACTOR / 100n) * 3n, cap: 1000000n }, // - 3% rate, cap 1000000
              { rate: (RATE_FACTOR / 100n) * 2n, cap: 1000000n }, // - 2% rate, cap 1000000
              { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n } // -------- 1% rate, no cap
            ],
            effectiveDay: INITIAL_DAY_INDEX
          },
          {
            tiers: [
              { rate: (RATE_FACTOR / 100n) * 3n, cap: 1000000n }, // - 3% rate, cap 1000000
              { rate: (RATE_FACTOR / 100n) * 2n, cap: 1000000n }, // - 2% rate, cap 1000000
              { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n } // -------- 1% rate, no cap
            ],
            effectiveDay: INITIAL_DAY_INDEX + 2n
          },
          {
            tiers: [
              { rate: RATE_FACTOR / 1000n, cap: 0n } // - 0.1% rate, no cap
            ],
            effectiveDay: INITIAL_DAY_INDEX + 1000n
          }
        ],
        currentTimestamp: INITIAL_TIMESTAMP + DAY * 3n + HOUR * 6n,
        expected: {
          fromTimestamp: INITIAL_TIMESTAMP + HOUR * 6n,
          toTimestamp: INITIAL_TIMESTAMP + DAY * 3n + HOUR * 6n,
          balance: 3000000n,
          streamYieldBefore: 1000000n,
          accruedYieldBefore: 2000000n,
          accruedYieldAfter:
            2000000n + // -------------- Initial accrued yield
            1000000n + // -------------- Initial stream yield
            60000n + // ---------------- PFD yield
            90600n + // ---------------- FD1 yield
            91506n, // ----------------- FD2 yield
          streamYieldAfter: 23105n, // - PLD yield
          rates: [
            {
              tiers: [
                { rate: (RATE_FACTOR / 100n) * 3n, cap: 1000000n }, // - 3% rate, cap 1000000
                { rate: (RATE_FACTOR / 100n) * 2n, cap: 1000000n }, // - 2% rate, cap 1000000
                { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n } // -------- 1% rate, no cap
              ],
              effectiveDay: INITIAL_DAY_INDEX
            },
            {
              tiers: [
                { rate: (RATE_FACTOR / 100n) * 3n, cap: 1000000n }, // - 3% rate, cap 1000000
                { rate: (RATE_FACTOR / 100n) * 2n, cap: 1000000n }, // - 2% rate, cap 1000000
                { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n } // -------- 1% rate, no cap
              ],
              effectiveDay: INITIAL_DAY_INDEX + 2n
            }
          ],
          results: [
            {
              partialFirstDayYield:
              // PFD Total: 1000000 + 60000 = 1060000
                1000000n + // - Stream yield
                22500n + // --- T1: 3% on 1000000 for 18 hours (Initial balance)
                15000n + // --- T2: 2% on 2000000 for 18 hours (Initial balance)
                22500n, // ---- T3: 1% on 3000000 for 18 hours (Initial balance)
              fullDaysYield:
              // FD1 Total: 90600
                30000n + // - T1: 3% on 1000000 for 1 day (Initial balance)
                20000n + // - T2: 2% on 1000000 for 1 day (Initial balance)
                40600n, // -- T3: 1% on 3000000 + 1000000 + 60000 for 1 day (Initial balance + Stream yield + PFD yield)
              partialLastDayYield: 0n,
              partialFirstDayYieldTiered: [
                // PFD Total: 60000
                simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, HOUR * 18n), // - PFD T1: 22500
                simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, HOUR * 18n), // - PFD T2: 15000
                simpleYield(3000000n, (RATE_FACTOR / 100n) * 1n, HOUR * 18n) // -- PFD T3: 22500
              ],
              fullDaysYieldTiered: [
                // FD1 Total: 90600
                simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, DAY), // -------- FD1 T1: 30000
                simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, DAY), // -------- FD1 T2: 20000
                simpleYield(
                  3000000n + // - Initial balance
                  1000000n + // - Stream yield
                  60000n, // ---- PFD yield
                  (RATE_FACTOR / 100n) * 1n,
                  DAY
                ) // ------------------------------------------------------------- FD1 T3: 40600
              ],
              partialLastDayYieldTiered: [0n, 0n, 0n]
            },
            {
              partialFirstDayYield: 0n,
              fullDaysYield:
              // FD2 Total: 91506
                30000n + // - T1: 3% on 1000000 for 1 day (Initial balance)
                20000n + // - T2: 2% on 1000000 for 1 day (Initial balance)
                41506n, // -- T3: 1% on 3000000 + 1000000 + 60000 + 90600 for 1 day (IB + SY + PFD + FD1)
              partialLastDayYield:
              // PLD Total: 23105
                7500n + // - T1: 3% on 1000000 for 6 hours (Initial balance)
                5000n + // - T2: 2% on 1000000 for 6 hours (Initial balance)
                10605n, // - T3: 1% on 3000000 + 1000000 + 60000 + 90600 + 91506 for 6 hours (IB + SY + PFD + FD1 + FD2)
              partialFirstDayYieldTiered: [0n, 0n, 0n],
              fullDaysYieldTiered: [
                // FD2 Total: 91506
                simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, DAY), // ------- FD2 T1: 30000
                simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, DAY), // ------- FD2 T2: 20000
                simpleYield(
                  3000000n + // - Initial balance
                  1000000n + // - Stream yield
                  60000n + // --- PFD yield
                  90600n, // ---- FD1 yield
                  (RATE_FACTOR / 100n) * 1n,
                  DAY
                ) // ------------------------------------------------------------ FD2 T3: 41506
              ],
              partialLastDayYieldTiered: [
                // PLD Total: 23105
                simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, HOUR * 6n), // - PLD T1: 7500
                simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, HOUR * 6n), // - PLD T2: 5000
                simpleYield(
                  3000000n + // - Initial balance
                  1000000n + // - Stream yield
                  60000n + // --- PFD yield
                  90600n + // --- FD1 yield
                  91506n, // ---- FD2 yield
                  (RATE_FACTOR / 100n) * 1n,
                  HOUR * 6n
                ) // ------------------------------------------------------------ PLD T3: 10605
              ]
            }
          ]
        }
      },
      {
        description: "Three yield rate periods",
        state: {
          lastUpdateTimestamp: INITIAL_TIMESTAMP + HOUR * 6n,
          lastUpdateBalance: 3000000n,
          streamYield: 1000000n,
          accruedYield: 2000000n,
          flags: 0n
        },
        rates: [
          {
            tiers: [
              { rate: RATE_FACTOR / 1000n, cap: 0n } // - 0.1% rate, no cap
            ],
            effectiveDay: 0n
          },
          {
            tiers: [
              { rate: (RATE_FACTOR / 100n) * 3n, cap: 1000000n }, // - 3% rate, cap 1000000
              { rate: (RATE_FACTOR / 100n) * 2n, cap: 1000000n }, // - 2% rate, cap 1000000
              { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n } // -------- 1% rate, no cap
            ],
            effectiveDay: INITIAL_DAY_INDEX
          },
          {
            tiers: [
              { rate: (RATE_FACTOR / 100n) * 3n, cap: 1000000n }, // - 3% rate, cap 1000000
              { rate: (RATE_FACTOR / 100n) * 2n, cap: 1000000n }, // - 2% rate, cap 1000000
              { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n } // -------- 1% rate, no cap
            ],
            effectiveDay: INITIAL_DAY_INDEX + 2n
          },
          {
            tiers: [
              { rate: (RATE_FACTOR / 100n) * 3n, cap: 1000000n }, // - 3% rate, cap 1000000
              { rate: (RATE_FACTOR / 100n) * 2n, cap: 1000000n }, // - 2% rate, cap 1000000
              { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n } // -------- 1% rate, no cap
            ],
            effectiveDay: INITIAL_DAY_INDEX + 3n
          },
          {
            tiers: [
              { rate: RATE_FACTOR / 1000n, cap: 0n } // - 0.1% rate, no cap
            ],
            effectiveDay: INITIAL_DAY_INDEX + 1000n
          }
        ],
        currentTimestamp: INITIAL_TIMESTAMP + DAY * 3n + HOUR * 6n,
        expected: {
          fromTimestamp: INITIAL_TIMESTAMP + HOUR * 6n,
          toTimestamp: INITIAL_TIMESTAMP + DAY * 3n + HOUR * 6n,
          balance: 3000000n,
          streamYieldBefore: 1000000n,
          accruedYieldBefore: 2000000n,
          accruedYieldAfter:
            2000000n + // -------------- Initial accrued yield
            1000000n + // -------------- Initial stream yield
            60000n + // ---------------- PFD yield
            90600n + // ---------------- FD1 yield
            91506n, // ----------------- FD2 yield
          streamYieldAfter: 23105n, // - PLD yield
          rates: [
            {
              tiers: [
                { rate: (RATE_FACTOR / 100n) * 3n, cap: 1000000n }, // - 3% rate, cap 1000000
                { rate: (RATE_FACTOR / 100n) * 2n, cap: 1000000n }, // - 2% rate, cap 1000000
                { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n } // -------- 1% rate, no cap
              ],
              effectiveDay: INITIAL_DAY_INDEX
            },
            {
              tiers: [
                { rate: (RATE_FACTOR / 100n) * 3n, cap: 1000000n }, // - 3% rate, cap 1000000
                { rate: (RATE_FACTOR / 100n) * 2n, cap: 1000000n }, // - 2% rate, cap 1000000
                { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n } // -------- 1% rate, no cap
              ],
              effectiveDay: INITIAL_DAY_INDEX + 2n
            },
            {
              tiers: [
                { rate: (RATE_FACTOR / 100n) * 3n, cap: 1000000n }, // - 3% rate, cap 1000000
                { rate: (RATE_FACTOR / 100n) * 2n, cap: 1000000n }, // - 2% rate, cap 1000000
                { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n } // -------- 1% rate, no cap
              ],
              effectiveDay: INITIAL_DAY_INDEX + 3n
            }
          ],
          results: [
            {
              partialFirstDayYield:
              // PFD Total: 1000000 + 60000 = 1060000
                1000000n + // - Stream yield
                22500n + // --- T1: 3% on 1000000 for 18 hours (Initial balance)
                15000n + // --- T2: 2% on 2000000 for 18 hours (Initial balance)
                22500n, // ---- T3: 1% on 3000000 for 18 hours (Initial balance)
              fullDaysYield:
              // FD1 Total: 90600
                30000n + // - T1: 3% on 1000000 for 1 day (Initial balance)
                20000n + // - T2: 2% on 1000000 for 1 day (Initial balance)
                40600n, // -- T3: 1% on 3000000 + 1000000 + 60000 for 1 day (Initial balance + Stream yield + PFD yield)
              partialLastDayYield: 0n,
              partialFirstDayYieldTiered: [
                // PFD Total: 60000
                simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, HOUR * 18n), // - PFD T1: 22500
                simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, HOUR * 18n), // - PFD T2: 15000
                simpleYield(3000000n, (RATE_FACTOR / 100n) * 1n, HOUR * 18n) // -- PFD T3: 22500
              ],
              fullDaysYieldTiered: [
                // FD1 Total: 90600
                simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, DAY), // -------- FD1 T1: 30000
                simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, DAY), // -------- FD1 T2: 20000
                simpleYield(
                  3000000n + // - Initial balance
                  1000000n + // - Stream yield
                  60000n, // ---- PFD yield
                  (RATE_FACTOR / 100n) * 1n,
                  DAY
                ) // ------------------------------------------------------------- FD1 T3: 40600
              ],
              partialLastDayYieldTiered: [0n, 0n, 0n]
            },
            {
              partialFirstDayYield: 0n,
              fullDaysYield:
              // FD2 Total: 91506
                30000n + // - T1: 3% on 1000000 for 1 day (Initial balance)
                20000n + // - T2: 2% on 1000000 for 1 day (Initial balance)
                41506n, // -- T3: 1% on 3000000 + 1000000 + 60000 + 90600 for 1 day (IB + SY + PFD + FD1)
              partialLastDayYield: 0n,
              partialFirstDayYieldTiered: [0n, 0n, 0n],
              fullDaysYieldTiered: [
                // FD2 Total: 91506
                simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, DAY), // - FD2 T1: 30000
                simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, DAY), // - FD2 T2: 20000
                simpleYield(
                  3000000n + // - Initial balance
                  1000000n + // - Stream yield
                  60000n + // --- PFD yield
                  90600n, // ---- FD1 yield
                  (RATE_FACTOR / 100n) * 1n,
                  DAY
                ) // ------------------------------------------------------ FD2 T3: 41506
              ],
              partialLastDayYieldTiered: [0n, 0n, 0n]
            },
            {
              partialFirstDayYield: 0n,
              fullDaysYield: 0n,
              partialLastDayYield:
              // PLD Total: 23105
                7500n + // - T1: 3% on 1000000 for 6 hours (Initial balance)
                5000n + // - T2: 2% on 1000000 for 6 hours (Initial balance)
                10605n, // - T3: 1% on 3000000 + 1000000 + 60000 + 90600 + 91506 for 6 hours (IB + SY + PFD + FD1 + FD2)
              partialFirstDayYieldTiered: [0n, 0n, 0n],
              fullDaysYieldTiered: [0n, 0n, 0n],
              partialLastDayYieldTiered: [
                // PLD Total: 23105
                simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, HOUR * 6n), // - PLD T1: 7500
                simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, HOUR * 6n), // - PLD T2: 5000
                simpleYield(
                  3000000n + // - Initial balance
                  1000000n + // - Stream yield
                  60000n + // --- PFD yield
                  90600n + // --- FD1 yield
                  91506n, // ---- FD2 yield
                  (RATE_FACTOR / 100n) * 1n,
                  HOUR * 6n
                ) // ------------------------------------------------------------ PLD T3: 10605
              ]
            }
          ]
        }
      }
    ];

    for (const [index, testCase] of testCases.entries()) {
      it(`Executes as expected for test case ${index + 1}: ${testCase.description}`, async () => {
        const { yieldStreamer } = await setUpFixture(deployContracts);

        // Add yield rates to contract
        for (let i = 0; i < testCase.rates.length; i++) {
          await yieldStreamer.addYieldRate(
            0,
            testCase.rates[i].effectiveDay,
            testCase.rates[i].tiers.map(tier => tier.rate),
            testCase.rates[i].tiers.map(tier => tier.cap)
          );
        }

        // Call the `_getAccruePreview()` function via the testable contract version
        const actualAccruePreviewRaw = await yieldStreamer.getAccruePreview(
          testCase.state,
          testCase.rates,
          testCase.currentTimestamp
        );

        // Convert the function result to a comparable format
        const actualAccruePreview = normalizeAccruePreview(actualAccruePreviewRaw);

        // Assertion
        expect(actualAccruePreview).to.deep.equal(testCase.expected);
      });
    }
  });

  describe("Function '_calculateYield()'", async () => {
    interface CalculateYieldTestCase {
      description: string;
      params: {
        fromTimestamp: bigint;
        toTimestamp: bigint;
        rateStartIndex: bigint;
        rateEndIndex: bigint;
        initialBalance: bigint;
        initialStreamYield: bigint;
        initialAccruedYield: bigint;
      };
      rates: YieldRate[];
      expected: YieldResult[];
    }

    const testCases: CalculateYieldTestCase[] = [
      {
        description: "Single yield rate period",
        params: {
          fromTimestamp: INITIAL_TIMESTAMP + HOUR * 6n,
          toTimestamp: INITIAL_TIMESTAMP + DAY * 3n + HOUR * 6n,
          rateStartIndex: 1n,
          rateEndIndex: 1n,
          initialBalance: 3000000n,
          initialStreamYield: 1000000n,
          initialAccruedYield: 2000000n
        },
        rates: [
          {
            tiers: [
              { rate: RATE_FACTOR / 1000n, cap: 0n } // - 0.1% rate, no cap
            ],
            effectiveDay: 0n
          },
          {
            tiers: [
              { rate: (RATE_FACTOR / 100n) * 3n, cap: 1000000n }, // - 3% rate, cap 1000000
              { rate: (RATE_FACTOR / 100n) * 2n, cap: 1000000n }, // - 2% rate, cap 1000000
              { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n } // -------- 1% rate, no cap
            ],
            effectiveDay: INITIAL_DAY_INDEX
          }
        ],
        expected: [
          {
            partialFirstDayYield:
            // PFD Total: 1000000 + 60000 = 106000
              1000000n + // - Stream yield
              22500n + // --- T1: 3% on 1000000 for 18 hours (Initial balance)
              15000n + // --- T2: 2% on 2000000 for 18 hours (Initial balance)
              22500n, // ---- T3: 1% on 3000000 for 18 hours (Initial balance)
            fullDaysYield:
            // FD1 Total: 90600
              30000n + // - T1: 3% on 1000000 for 1 day (Initial balance)
              20000n + // - T2: 2% on 1000000 for 1 day (Initial balance)
              40600n + // - T3: 1% on 3000000 + 1000000 + 60000 for 1 day (Initial balance + Stream yield + PFD yield)
              // ------
              // FD2 Total: 91506
              30000n + // - T1: 3% on 1000000 for 1 day (Initial balance)
              20000n + // - T2: 2% on 1000000 for 1 day (Initial balance)
              41506n, // -- T3: 1% on 3000000 + 1000000 + 60000 + 90600 for 1 day (IB + SY + PFD + FD1)
            partialLastDayYield:
            // PLD Total: 23105
              7500n + // - T1: 3% on 1000000 for 6 hours (Initial balance)
              5000n + // - T2: 2% on 1000000 for 6 hours (Initial balance)
              10605n, // - T3: 1% on 3000000 + 1000000 + 60000 + 90600 + 91506 for 6 hours (IB + SY + PFD + FD1 + FD2)
            partialFirstDayYieldTiered: [
              // PFD Total: 60000
              simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, HOUR * 18n), // - PFD T1: 22500
              simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, HOUR * 18n), // - PFD T2: 15000
              simpleYield(3000000n, (RATE_FACTOR / 100n) * 1n, HOUR * 18n) // -- PFD T3: 22500
            ],
            fullDaysYieldTiered: [
              // FD1 + FD2 Total: 182106
              // FD1 Total: 30000 + 20000 + 40600 = 90600
              // FD2 Total: 30000 + 20000 + 41506 = 91506
              simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, DAY) + // ------- FD1 T1: 30000
              simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, DAY), // -------- FD2 T1: 30000
              simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, DAY) + // ------- FD1 T2: 20000
              simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, DAY), // -------- FD2 T2: 20000
              simpleYield(
                3000000n + // - Initial balance
                1000000n + // - Stream yield
                60000n, // ---- PFD yield
                (RATE_FACTOR / 100n) * 1n,
                DAY
              ) + // ----------------------------------------------------------- FD1 T3: 40600
              simpleYield(
                3000000n + // - Initial balance
                1000000n + // - Stream yield
                60000n + // --- PFD yield
                90600n, // ---- FD1 yield
                (RATE_FACTOR / 100n) * 1n,
                DAY
              ) // ------------------------------------------------------------- FD2 T3: 41506
            ],
            partialLastDayYieldTiered: [
              // PLD Total: 23105
              simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, HOUR * 6n), // --- PLD T1: 7500
              simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, HOUR * 6n), // --- PLD T2: 5000
              simpleYield(
                3000000n + // - Initial balance
                1000000n + // - Stream yield
                60000n + // --- PFD yield
                90600n + // --- FD1 yield
                91506n, // ---- FD2 yield
                (RATE_FACTOR / 100n) * 1n,
                HOUR * 6n
              ) // ------------------------------------------------------------- PLD T3: 10605
            ]
          }
        ]
      },
      {
        description: "Two yield rate periods",
        params: {
          fromTimestamp: INITIAL_TIMESTAMP + HOUR * 6n,
          toTimestamp: INITIAL_TIMESTAMP + DAY * 3n + HOUR * 6n,
          rateStartIndex: 1n,
          rateEndIndex: 2n,
          initialBalance: 3000000n,
          initialStreamYield: 1000000n,
          initialAccruedYield: 2000000n
        },
        rates: [
          {
            tiers: [
              { rate: RATE_FACTOR / 1000n, cap: 0n } // - 0.1% rate, no cap
            ],
            effectiveDay: 0n
          },
          {
            tiers: [
              { rate: (RATE_FACTOR / 100n) * 3n, cap: 1000000n }, // - 3% rate, cap 1000000
              { rate: (RATE_FACTOR / 100n) * 2n, cap: 1000000n }, // - 2% rate, cap 1000000
              { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n } // -------- 1% rate, no cap
            ],
            effectiveDay: INITIAL_DAY_INDEX
          },
          {
            tiers: [
              { rate: (RATE_FACTOR / 100n) * 3n, cap: 1000000n }, // - 3% rate, cap 1000000
              { rate: (RATE_FACTOR / 100n) * 2n, cap: 1000000n }, // - 2% rate, cap 1000000
              { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n } // -------- 1% rate, no cap
            ],
            effectiveDay: INITIAL_DAY_INDEX + 2n
          },
          {
            tiers: [
              { rate: RATE_FACTOR / 1000n, cap: 0n } // - 0.1% rate, no cap
            ],
            effectiveDay: INITIAL_DAY_INDEX + 1000n
          }
        ],
        expected: [
          {
            partialFirstDayYield:
            // PFD Total: 1000000 + 60000 = 1060000
              1000000n + // - Stream yield
              22500n + // --- T1: 3% on 1000000 for 18 hours (Initial balance)
              15000n + // --- T2: 2% on 2000000 for 18 hours (Initial balance)
              22500n, // ---- T3: 1% on 3000000 for 18 hours (Initial balance)
            fullDaysYield:
            // FD1 Total: 90600
              30000n + // - T1: 3% on 1000000 for 1 day (Initial balance)
              20000n + // - T2: 2% on 1000000 for 1 day (Initial balance)
              40600n, // -- T3: 1% on 3000000 + 1000000 + 60000 for 1 day (Initial balance + Stream yield + PFD yield)
            partialLastDayYield: 0n,
            partialFirstDayYieldTiered: [
              // PFD Total: 60000
              simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, HOUR * 18n), // - PFD T1: 22500
              simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, HOUR * 18n), // - PFD T2: 15000
              simpleYield(3000000n, (RATE_FACTOR / 100n) * 1n, HOUR * 18n) // -- PFD T3: 22500
            ],
            fullDaysYieldTiered: [
              // FD1 Total: 90600
              simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, DAY), // -------- FD1 T1: 30000
              simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, DAY), // -------- FD1 T2: 20000
              simpleYield(
                3000000n + // - Initial balance
                1000000n + // - Stream yield
                60000n, // ---- PFD yield
                (RATE_FACTOR / 100n) * 1n,
                DAY
              ) // ------------------------------------------------------------- FD1 T3: 40600
            ],
            partialLastDayYieldTiered: [0n, 0n, 0n]
          },
          {
            partialFirstDayYield: 0n,
            fullDaysYield:
            // FD2 Total: 91506
              30000n + // - T1: 3% on 1000000 for 1 day (Initial balance)
              20000n + // - T2: 2% on 1000000 for 1 day (Initial balance)
              41506n, // -- T3: 1% on 3000000 + 1000000 + 60000 + 90600 for 1 day (IB + SY + PFD + FD1)
            partialLastDayYield:
            // PLD Total: 23105
              7500n + // - T1: 3% on 1000000 for 6 hours (Initial balance)
              5000n + // - T2: 2% on 1000000 for 6 hours (Initial balance)
              10605n, // - T3: 1% on 3000000 + 1000000 + 60000 + 90600 + 91506 for 6 hours (IB + SY + PFD + FD1 + FD2)
            partialFirstDayYieldTiered: [0n, 0n, 0n],
            fullDaysYieldTiered: [
              // FD2 Total: 91506
              simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, DAY), // ------- FD2 T1: 30000
              simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, DAY), // ------- FD2 T2: 20000
              simpleYield(
                3000000n + // - Initial balance
                1000000n + // - Stream yield
                60000n + // --- PFD yield
                90600n, // ---- FD1 yield
                (RATE_FACTOR / 100n) * 1n,
                DAY
              ) // ------------------------------------------------------------ FD2 T3: 41506
            ],
            partialLastDayYieldTiered: [
              // PLD Total: 23105
              simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, HOUR * 6n), // - PLD T1: 7500
              simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, HOUR * 6n), // - PLD T2: 5000
              simpleYield(
                3000000n + // - Initial balance
                1000000n + // - Stream yield
                60000n + // --- PFD yield
                90600n + // --- FD1 yield
                91506n, // ---- FD2 yield
                (RATE_FACTOR / 100n) * 1n,
                HOUR * 6n
              ) // ------------------------------------------------------------ PLD T3: 10605
            ]
          }
        ]
      },
      {
        description: "Three yield rate periods",
        params: {
          fromTimestamp: INITIAL_TIMESTAMP + HOUR * 6n,
          toTimestamp: INITIAL_TIMESTAMP + DAY * 3n + HOUR * 6n,
          rateStartIndex: 1n,
          rateEndIndex: 3n,
          initialBalance: 3000000n,
          initialStreamYield: 1000000n,
          initialAccruedYield: 2000000n
        },
        rates: [
          {
            tiers: [
              { rate: RATE_FACTOR / 1000n, cap: 0n } // - 0.1% rate, no cap
            ],
            effectiveDay: 0n
          },
          {
            tiers: [
              { rate: (RATE_FACTOR / 100n) * 3n, cap: 1000000n }, // - 3% rate, cap 1000000
              { rate: (RATE_FACTOR / 100n) * 2n, cap: 1000000n }, // - 2% rate, cap 1000000
              { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n } // -------- 1% rate, no cap
            ],
            effectiveDay: INITIAL_DAY_INDEX
          },
          {
            tiers: [
              { rate: (RATE_FACTOR / 100n) * 3n, cap: 1000000n }, // - 3% rate, cap 1000000
              { rate: (RATE_FACTOR / 100n) * 2n, cap: 1000000n }, // - 2% rate, cap 1000000
              { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n } // -------- 1% rate, no cap
            ],
            effectiveDay: INITIAL_DAY_INDEX + 2n
          },
          {
            tiers: [
              { rate: (RATE_FACTOR / 100n) * 3n, cap: 1000000n }, // - 3% rate, cap 1000000
              { rate: (RATE_FACTOR / 100n) * 2n, cap: 1000000n }, // - 2% rate, cap 1000000
              { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n } // -------- 1% rate, no cap
            ],
            effectiveDay: INITIAL_DAY_INDEX + 3n
          },
          {
            tiers: [
              { rate: RATE_FACTOR / 1000n, cap: 0n } // - 0.1% rate, no cap
            ],
            effectiveDay: INITIAL_DAY_INDEX + 1000n
          }
        ],
        expected: [
          {
            partialFirstDayYield:
            // PFD Total: 1000000 + 60000 = 1060000
              1000000n + // - Stream yield
              22500n + // --- T1: 3% on 1000000 for 18 hours (Initial balance)
              15000n + // --- T2: 2% on 2000000 for 18 hours (Initial balance)
              22500n, // ---- T3: 1% on 3000000 for 18 hours (Initial balance)
            fullDaysYield:
            // FD1 Total: 90600
              30000n + // - T1: 3% on 1000000 for 1 day (Initial balance)
              20000n + // - T2: 2% on 1000000 for 1 day (Initial balance)
              40600n, // -- T3: 1% on 3000000 + 1000000 + 60000 for 1 day (Initial balance + Stream yield + PFD yield)
            partialLastDayYield: 0n,
            partialFirstDayYieldTiered: [
              // PFD Total: 60000
              simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, HOUR * 18n), // - PFD T1: 22500
              simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, HOUR * 18n), // - PFD T2: 15000
              simpleYield(3000000n, (RATE_FACTOR / 100n) * 1n, HOUR * 18n) // -- PFD T3: 22500
            ],
            fullDaysYieldTiered: [
              // FD1 Total: 90600
              simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, DAY), // -------- FD1 T1: 30000
              simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, DAY), // -------- FD1 T2: 20000
              simpleYield(
                3000000n + // - Initial balance
                1000000n + // - Stream yield
                60000n, // ---- PFD yield
                (RATE_FACTOR / 100n) * 1n,
                DAY
              ) // ------------------------------------------------------------- FD1 T3: 40600
            ],
            partialLastDayYieldTiered: [0n, 0n, 0n]
          },
          {
            partialFirstDayYield: 0n,
            fullDaysYield:
            // FD2 Total: 91506
              30000n + // - T1: 3% on 1000000 for 1 day (Initial balance)
              20000n + // - T2: 2% on 1000000 for 1 day (Initial balance)
              41506n, // -- T3: 1% on 3000000 + 1000000 + 60000 + 90600 for 1 day (IB + SY + PFD + FD1)
            partialLastDayYield: 0n,
            partialFirstDayYieldTiered: [0n, 0n, 0n],
            fullDaysYieldTiered: [
              // FD2 Total: 91506
              simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, DAY), // - FD2 T1: 30000
              simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, DAY), // - FD2 T2: 20000
              simpleYield(
                3000000n + // - Initial balance
                1000000n + // - Stream yield
                60000n + // --- PFD yield
                90600n, // ---- FD1 yield
                (RATE_FACTOR / 100n) * 1n,
                DAY
              ) // ------------------------------------------------------ FD2 T3: 41506
            ],
            partialLastDayYieldTiered: [0n, 0n, 0n]
          },
          {
            partialFirstDayYield: 0n,
            fullDaysYield: 0n,
            partialLastDayYield:
            // PLD Total: 23105
              7500n + // - T1: 3% on 1000000 for 6 hours (Initial balance)
              5000n + // - T2: 2% on 1000000 for 6 hours (Initial balance)
              10605n, // - T3: 1% on 3000000 + 1000000 + 60000 + 90600 + 91506 for 6 hours (IB + SY + PFD + FD1 + FD2)
            partialFirstDayYieldTiered: [0n, 0n, 0n],
            fullDaysYieldTiered: [0n, 0n, 0n],
            partialLastDayYieldTiered: [
              // PLD Total: 23105
              simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, HOUR * 6n), // - PLD T1: 7500
              simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, HOUR * 6n), // - PLD T2: 5000
              simpleYield(
                3000000n + // - Initial balance
                1000000n + // - Stream yield
                60000n + // --- PFD yield
                90600n + // --- FD1 yield
                91506n, // ---- FD2 yield
                (RATE_FACTOR / 100n) * 1n,
                HOUR * 6n
              ) // ------------------------------------------------------------ PLD T3: 10605
            ]
          }
        ]
      }
    ];

    for (const [index, testCase] of testCases.entries()) {
      it(`Executes as expected for test case ${index + 1}: ${testCase.description}`, async () => {
        const { yieldStreamer } = await setUpFixture(deployContracts);

        // Add yield rates to contract
        for (let i = 0; i < testCase.rates.length; i++) {
          await yieldStreamer.addYieldRate(
            0,
            testCase.rates[i].effectiveDay,
            testCase.rates[i].tiers.map(tier => tier.rate),
            testCase.rates[i].tiers.map(tier => tier.cap)
          );
        }

        // Call the `_calculateYield()` function via the testable contract version
        const yieldResultsRaw = await yieldStreamer.calculateYield(testCase.params, testCase.rates);

        // Convert the function result to a comparable format
        const yieldResults = yieldResultsRaw.map(normalizeYieldResult);

        // Assertion
        expect(yieldResults).to.deep.equal(testCase.expected);
      });
    }
  });

  describe("Function '_compoundYield()'", async () => {
    interface CompoundYieldTestCase {
      description: string;
      params: {
        fromTimestamp: bigint;
        toTimestamp: bigint;
        tiers: RateTier[];
        balance: bigint;
        streamYield: bigint;
      };
      expected: {
        partialFirstDayYield: bigint;
        fullDaysYield: bigint;
        partialLastDayYield: bigint;
        partialFirstDayYieldTiered: bigint[];
        fullDaysYieldTiered: bigint[];
        partialLastDayYieldTiered: bigint[];
      };
      shouldRevert?: boolean;
      revertMessage?: string;
    }

    const testCases: CompoundYieldTestCase[] = [
      {
        description: "Single partial day: D1:00:00:00 - D1:01:00:00",
        params: {
          fromTimestamp: INITIAL_TIMESTAMP,
          toTimestamp: INITIAL_TIMESTAMP + HOUR,
          tiers: [
            { rate: (RATE_FACTOR / 100n) * 3n, cap: 1000000n }, // - 3% rate, cap 1000000
            { rate: (RATE_FACTOR / 100n) * 2n, cap: 1000000n }, // - 2% rate, cap 1000000
            { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n } // -------- 1% rate, no cap
          ],
          balance: 5000000n,
          streamYield: 1000000n
        },
        expected: {
          partialFirstDayYield:
          // PFD Total: 1000000
            1000000n, // - Stream yield
          fullDaysYield: 0n,
          partialLastDayYield:
          // PLD Total: 3749
            1250n + // - T1: 3% on 1000000 for 1 hour (Initial balance)
            833n + // -- T2: 2% on 1000000 for 1 hour (Initial balance)
            1666n, // -- T3: 1% on (3000000 + 1000000) for 1 hour (Initial balance + Stream yield)
          partialFirstDayYieldTiered: [0n, 0n, 0n],
          fullDaysYieldTiered: [0n, 0n, 0n],
          partialLastDayYieldTiered: [
            // PLD Total: 3749
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, HOUR), // - PLD T1: 1250
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, HOUR), // - PLD T2: 833
            simpleYield(
              3000000n + // - Initial balance
              1000000n, // -- Stream yield
              (RATE_FACTOR / 100n) * 1n,
              HOUR
            ) // ------------------------------------------------------- PLD T3: 1666
          ]
        }
      },
      {
        description: "Single partial day: D1:01:00:00 - D1:23:00:00",
        params: {
          fromTimestamp: INITIAL_TIMESTAMP + HOUR,
          toTimestamp: INITIAL_TIMESTAMP + DAY - HOUR,
          tiers: [
            { rate: (RATE_FACTOR / 100n) * 3n, cap: 1000000n }, // - 3% rate, cap 1000000
            { rate: (RATE_FACTOR / 100n) * 2n, cap: 1000000n }, // - 2% rate, cap 1000000
            { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n } // -------- 1% rate, no cap
          ],
          balance: 5000000n,
          streamYield: 1000000n
        },
        expected: {
          partialFirstDayYield: 0n,
          fullDaysYield: 0n,
          partialLastDayYield:
          // PLD Total: 1000000 + 73333 = 1073333
            1000000n + // - Stream yield
            27500n + // --- T1: 3% on 1000000 for 22 hours (Initial balance)
            18333n + // --- T2: 2% on 1000000 for 22 hours (Initial balance)
            27500n, // ---- T3: 1% on 3000000 for 22 hours (Initial balance)
          partialFirstDayYieldTiered: [0n, 0n, 0n],
          fullDaysYieldTiered: [0n, 0n, 0n],
          partialLastDayYieldTiered: [
            // PLD Total: 73333
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, HOUR * 22n), // - PLD T1: 27500
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, HOUR * 22n), // - PLD T2: 18333
            simpleYield(3000000n, (RATE_FACTOR / 100n) * 1n, HOUR * 22n) // -- PLD T3: 27500
          ]
        }
      },
      {
        description: "Single partial day: D1:23:00:00 - D2:00:00:00",
        params: {
          fromTimestamp: INITIAL_TIMESTAMP + DAY - HOUR,
          toTimestamp: INITIAL_TIMESTAMP + DAY,
          tiers: [
            { rate: (RATE_FACTOR / 100n) * 3n, cap: 1000000n }, // - 3% rate, cap 1000000
            { rate: (RATE_FACTOR / 100n) * 2n, cap: 1000000n }, // - 2% rate, cap 1000000
            { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n } // -------- 1% rate, no cap
          ],
          balance: 5000000n,
          streamYield: 1000000n
        },
        expected: {
          partialFirstDayYield: 0n,
          fullDaysYield: 0n,
          partialLastDayYield:
          // PLD Total: 1000000 + 3333 = 1003333
            1000000n + // - Stream yield
            1250n + // ---- T1: 3% on 1000000 for 1 hour (Initial balance)
            833n + // ----- T2: 2% on 1000000 for 1 hour (Initial balance)
            1250n, // ----- T3: 1% on 3000000 for 1 hour (Initial balance)
          partialFirstDayYieldTiered: [0n, 0n, 0n],
          fullDaysYieldTiered: [0n, 0n, 0n],
          partialLastDayYieldTiered: [
            // PLD Total: 3333
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, HOUR), // - PLD T1: 1250
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, HOUR), // - PLD T2: 833
            simpleYield(3000000n, (RATE_FACTOR / 100n) * 1n, HOUR) // -- PLD T3: 1250
          ]
        }
      },
      {
        description: "Single full day: D1:00:00:00 - D2:00:00:00",
        params: {
          fromTimestamp: INITIAL_TIMESTAMP,
          toTimestamp: INITIAL_TIMESTAMP + DAY,
          tiers: [
            { rate: (RATE_FACTOR / 100n) * 3n, cap: 1000000n }, // - 3% rate, cap 1000000
            { rate: (RATE_FACTOR / 100n) * 2n, cap: 1000000n }, // - 2% rate, cap 1000000
            { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n } // -------- 1% rate, no cap
          ],
          balance: 5000000n,
          streamYield: 1000000n
        },
        expected: {
          partialFirstDayYield:
          // FDP Total: 1000000
            1000000n, // - Stream yield
          fullDaysYield:
          // FD1 Total: 90000
            30000n + // - T1: 3% on 1000000 for 1 day (Initial balance)
            20000n + // - T2: 2% on 1000000 for 1 day (Initial balance)
            40000n, // -- T3: 1% on 3000000 + 1000000 for 1 day (Initial balance + Stream yield)
          partialLastDayYield: 0n,
          partialFirstDayYieldTiered: [0n, 0n, 0n],
          fullDaysYieldTiered: [
            // FD1 Total: 90000
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, DAY), // - FD1 T1: 30000
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, DAY), // - FD1 T2: 20000
            simpleYield(
              3000000n + // - Initial balance
              1000000n, // -- Stream yield
              (RATE_FACTOR / 100n) * 1n,
              DAY
            ) // ------------------------------------------------------ FD1 T3: 40000
          ],
          partialLastDayYieldTiered: [0n, 0n, 0n]
        }
      },
      {
        description: "Two full days: D1:00:00:00 - D3:00:00:00",
        params: {
          fromTimestamp: INITIAL_TIMESTAMP,
          toTimestamp: INITIAL_TIMESTAMP + DAY * 2n,
          tiers: [
            { rate: (RATE_FACTOR / 100n) * 3n, cap: 1000000n }, // - 3% rate, cap 1000000
            { rate: (RATE_FACTOR / 100n) * 2n, cap: 1000000n }, // - 2% rate, cap 1000000
            { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n } // -------- 1% rate, no cap
          ],
          balance: 5000000n,
          streamYield: 1000000n
        },
        expected: {
          partialFirstDayYield:
          // FDP Total: 1000000
            1000000n, // - Stream yield
          fullDaysYield:
          // FD1 Total: 90000
            30000n + // - T1: 3% on 1000000 for 1 day (Initial balance)
            20000n + // - T2: 2% on 1000000 for 1 day (Initial balance)
            40000n + // - T3: 1% on 3000000 + 1000000 for 1 day (Initial balance + Stream yield)
            // ------
            // FD2 Total: 90900
            30000n + // - T1: 3% on 1000000 for 1 day (Initial balance)
            20000n + // - T2: 2% on 1000000 for 1 day (Initial balance)
            40900n, // -- T3: 1% on 3000000 + 1000000 + 90000 for 1 day (Initial balance + Stream yield + FD1 yield)
          partialLastDayYield: 0n,
          partialFirstDayYieldTiered: [0n, 0n, 0n],
          fullDaysYieldTiered: [
            // FD1 + FD2 Total: 180900
            // FD1 Total: 30000 + 20000 + 40000 = 90000
            // FD2 Total: 30000 + 20000 + 40900 = 90900
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, DAY) + // - FD1 T1: 30000
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, DAY), // -- FD2 T1: 30000
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, DAY) + // - FD1 T2: 20000
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, DAY), // -- FD2 T2: 20000
            simpleYield(
              3000000n + // - Initial balance
              1000000n, // -- Stream yield
              (RATE_FACTOR / 100n) * 1n,
              DAY
            ) + // ----------------------------------------------------- FD1 T3: 40000
            simpleYield(
              3000000n + // - Initial balance
              1000000n + // - Stream yield
              90000n, // ---- FD1 yield
              (RATE_FACTOR / 100n) * 1n,
              DAY
            ) // ------------------------------------------------------- FD2 T3: 40900
          ],
          partialLastDayYieldTiered: [0n, 0n, 0n]
        }
      },
      {
        description: "Two full days AND first partial day: D1:06:00:00 - D4:00:00:00",
        params: {
          fromTimestamp: INITIAL_TIMESTAMP + HOUR * 6n,
          toTimestamp: INITIAL_TIMESTAMP + DAY * 3n,
          tiers: [
            { rate: (RATE_FACTOR / 100n) * 3n, cap: 1000000n }, // - 3% rate, cap 1000000
            { rate: (RATE_FACTOR / 100n) * 2n, cap: 1000000n }, // - 2% rate, cap 1000000
            { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n } // -------- 1% rate, no cap
          ],
          balance: 5000000n,
          streamYield: 1000000n
        },
        expected: {
          partialFirstDayYield:
          // FDP Total: 1000000 + 60000 = 1060000
            1000000n + // - Stream yield
            22500n + // --- T1: 3% on 1000000 for 18 hours (Initial balance)
            15000n + // --- T2: 2% on 2000000 for 18 hours (Initial balance)
            22500n, // ---- T3: 1% on 3000000 for 18 hours (Initial balance)
          // PD0 Total: 60000
          fullDaysYield:
          // FD1 Total: 90600
            30000n + // - T1: 3% on 1000000 for 1 day (Initial balance)
            20000n + // - T2: 2% on 1000000 for 1 day (Initial balance)
            40600n + // - T3: 1% on 3000000 + 1000000 + 60000 for 1 day (Initial balance + Stream yield + FDP yield)
            // ------
            // FD2 Total: 91506
            30000n + // - T1: 3% on 1000000 for 1 day (Initial balance)
            20000n + // - T2: 2% on 1000000 for 1 day (Initial balance)
            41506n, // -- T3: 1% on 3000000 + 1000000 + 60000 + 90600 for 1 day (IB + SY + FDP + FD1)
          partialLastDayYield: 0n,
          partialFirstDayYieldTiered: [
            // PFD Total: 60000
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, HOUR * 18n), // - PFD T1: 22500
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, HOUR * 18n), // - PFD T2: 15000
            simpleYield(3000000n, (RATE_FACTOR / 100n) * 1n, HOUR * 18n) // -- PFD T3: 22500
          ],
          fullDaysYieldTiered: [
            // FD1 + FD2 Total: 181506
            // FD1 Total: 30000 + 20000 + 40600 = 90600
            // FD2 Total: 30000 + 20000 + 41506 = 91506
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, DAY) + // - FD1 T1: 30000
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, DAY), // -- FD2 T1: 30000
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, DAY) + // - FD1 T2: 20000
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, DAY), // -- FD2 T2: 20000
            simpleYield(
              3000000n + // - Initial balance
              1000000n + // - Stream yield
              60000n, // ---- PFD yield
              (RATE_FACTOR / 100n) * 1n,
              DAY
            ) + // ----------------------------------------------------- FD1 T3: 40600
            simpleYield(
              3000000n + // - Initial balance
              1000000n + // - Stream yield
              60000n + // --- PFD yield
              90600n, // ---- FD1 yield
              (RATE_FACTOR / 100n) * 1n,
              DAY
            ) // ------------------------------------------------------- FD2 T3: 41506
          ],
          partialLastDayYieldTiered: [0n, 0n, 0n]
        }
      },
      {
        description: "Two full days AND last partial day: D1:00:00:00 - D4:06:00:00",
        params: {
          fromTimestamp: INITIAL_TIMESTAMP,
          toTimestamp: INITIAL_TIMESTAMP + DAY * 2n + HOUR * 6n,
          tiers: [
            { rate: (RATE_FACTOR / 100n) * 3n, cap: 1000000n }, // - 3% rate, cap 1000000
            { rate: (RATE_FACTOR / 100n) * 2n, cap: 1000000n }, // - 2% rate, cap 1000000
            { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n } // -------- 1% rate, no cap
          ],
          balance: 5000000n,
          streamYield: 1000000n
        },
        expected: {
          partialFirstDayYield:
          // FDP Total: 1000000
            1000000n, // - Stream yield
          fullDaysYield:
          // FD1 Total: 90000
            30000n + // - T1: 3% on 1000000 for 1 day (Initial balance)
            20000n + // - T2: 2% on 1000000 for 1 day (Initial balance)
            40000n + // - T3: 1% on 3000000 + 1000000 for 1 day (Initial balance + Stream yield)
            // ------
            // FD2 Total: 90900
            30000n + // - T1: 3% on 1000000 for 1 day (Initial balance)
            20000n + // - T2: 2% on 1000000 for 1 day (Initial balance)
            40900n, // -- T3: 1% on 3000000 + 1000000 + 90000 for 1 day (Initial balance + Stream yield + FD1 yield)
          partialLastDayYield:
          // LDP Total: 22952
            7500n + // - T1: 3% on 1000000 for 6 hours (Initial balance)
            5000n + // - T2: 2% on 1000000 for 6 hours (Initial balance)
            10452n, // - T3: 1% on 3000000 + 1000000 + 90000 + 90900 for 6 hours (IB + SY + FD1 + FD2)
          partialFirstDayYieldTiered: [0n, 0n, 0n],
          fullDaysYieldTiered: [
            // FD1 + FD2 Total: 180900
            // FD1 Total: 30000 + 20000 + 40000 = 90000
            // FD2 Total: 30000 + 20000 + 40900 = 90900
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, DAY) + // - FD1 T1: 30000
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, DAY), // -- FD2 T1: 30000
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, DAY) + // - FD1 T2: 20000
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, DAY), // -- FD2 T2: 20000
            simpleYield(
              3000000n + // - Initial balance
              1000000n, // -- Stream yield
              (RATE_FACTOR / 100n) * 1n,
              DAY
            ) + // ----------------------------------------------------- FD1 T3: 40000
            simpleYield(
              3000000n + // - Initial balance
              1000000n + // - Stream yield
              90000n, // --- FD1 yield
              (RATE_FACTOR / 100n) * 1n,
              DAY
            ) // ------------------------------------------------------- FD2 T3: 40900
          ],
          partialLastDayYieldTiered: [
            // LDP Total: 22952
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, HOUR * 6n), // - LDP T1: 7500
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, HOUR * 6n), // - LDP T2: 5000
            simpleYield(
              3000000n + // - Initial balance
              1000000n + // - Stream yield
              90000n + // --- FD1 yield
              90900n, // ---- FD2 yield
              (RATE_FACTOR / 100n) * 1n,
              HOUR * 6n
            ) // ------------------------------------------------------------ LDP T3: 10452
          ]
        }
      },
      {
        description: "Two full days AND first partial day AND last partial day: D1:06:00:00 - D4:06:00:00",
        params: {
          fromTimestamp: INITIAL_TIMESTAMP + HOUR * 6n,
          toTimestamp: INITIAL_TIMESTAMP + DAY * 3n + HOUR * 6n,
          tiers: [
            { rate: (RATE_FACTOR / 100n) * 3n, cap: 1000000n }, // - 3% rate, cap 1000000
            { rate: (RATE_FACTOR / 100n) * 2n, cap: 1000000n }, // - 2% rate, cap 1000000
            { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n } // -------- 1% rate, no cap
          ],
          balance: 5000000n,
          streamYield: 1000000n
        },
        expected: {
          partialFirstDayYield:
          // PFD Total: 1000000 + 60000 = 1060000
            1000000n + // - Stream yield
            22500n + // --- T1: 3% on 1000000 for 18 hours (Initial balance)
            15000n + // --- T2: 2% on 2000000 for 18 hours (Initial balance)
            22500n, // ---- T3: 1% on 3000000 for 18 hours (Initial balance)
          fullDaysYield:
          // FD1 Total: 90600
            30000n + // - T1: 3% on 1000000 for 1 day (Initial balance)
            20000n + // - T2: 2% on 1000000 for 1 day (Initial balance)
            40600n + // - T3: 1% on 3000000 + 1000000 + 60000 for 1 day (Initial balance + Stream yield + FDP yield)
            // ------
            // FD2 Total: 91506
            30000n + // - T1: 3% on 1000000 for 1 day (Initial balance)
            20000n + // - T2: 2% on 1000000 for 1 day (Initial balance)
            41506n, // -- T3: 1% on 3000000 + 1000000 + 60000 + 90600 for 1 day (IB + SY + FDP + FD1)
          partialLastDayYield:
          // PLD Total: 23105
            7500n + // - T1: 3% on 1000000 for 6 hours (Initial balance)
            5000n + // - T2: 2% on 1000000 for 6 hours (Initial balance)
            10605n, // - T3: 1% on 3000000 + 1000000 + 60000 + 90600 + 91506 for 6 hours (IB + SY + FDP + FD1 + FD2)
          partialFirstDayYieldTiered: [
            // PFD Total: 60000
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, HOUR * 18n), // - PFD T1: 22500
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, HOUR * 18n), // - PFD T2: 15000
            simpleYield(3000000n, (RATE_FACTOR / 100n) * 1n, HOUR * 18n) // -- PFD T3: 22500
          ],
          fullDaysYieldTiered: [
            // FD1 + FD2 Total: 182106
            // FD1 Total: 30000 + 20000 + 40600 = 90600
            // FD2 Total: 30000 + 20000 + 41506 = 91506
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, DAY) + // - FD1 T1: 30000
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, DAY), // -- FD2 T1: 30000
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, DAY) + // - FD1 T2: 20000
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, DAY), // -- FD2 T2: 20000
            simpleYield(
              3000000n + // - Initial balance
              1000000n + // - Stream yield
              60000n, // ---- PFD yield
              (RATE_FACTOR / 100n) * 1n,
              DAY
            ) + // -------------------------------------------------------- FD1 T3: 40600
            simpleYield(
              3000000n + // - Initial balance
              1000000n + // - Stream yield
              60000n + // --- PFD yield
              90600n, // ---- FD1 yield
              (RATE_FACTOR / 100n) * 1n,
              DAY
            ) // ---------------------------------------------------------- FD2 T3: 41506
          ],
          partialLastDayYieldTiered: [
            // PLD Total: 7500 + 5000 + 10605 = 23105
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, HOUR * 6n), // - PLD T1: 7500
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, HOUR * 6n), // - PLD T2: 5000
            simpleYield(
              3000000n + // - Initial balance
              1000000n + // - Stream yield
              60000n + // --- PFD yield
              90600n + // --- FD1 yield
              91506n, // ---- FD2 yield
              (RATE_FACTOR / 100n) * 1n,
              HOUR * 6n
            ) // ------------------------------------------------------------ PLD T3: 10605
          ]
        }
      },
      {
        description: "Two partial days: D1:06:00:00 - D2:06:00:00",
        params: {
          fromTimestamp: INITIAL_TIMESTAMP + HOUR * 6n,
          toTimestamp: INITIAL_TIMESTAMP + DAY + HOUR * 6n,
          tiers: [
            { rate: (RATE_FACTOR / 100n) * 3n, cap: 1000000n }, // - 3% rate, cap 1000000
            { rate: (RATE_FACTOR / 100n) * 2n, cap: 1000000n }, // - 2% rate, cap 1000000
            { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n } // -------- 1% rate, no cap
          ],
          balance: 5000000n,
          streamYield: 1000000n
        },
        expected: {
          partialFirstDayYield:
          // FDP Total: 1000000 + 60000 = 1060000
            1000000n + // - Stream yield
            22500n + // --- T1: 3% on 1000000 for 18 hours (Initial balance)
            15000n + // --- T2: 2% on 2000000 for 18 hours (Initial balance)
            22500n, // ---- T3: 1% on 3000000 for 18 hours (Initial balance)
          fullDaysYield: 0n,
          partialLastDayYield:
          // PLD Total: 22650
            7500n + // - T1: 3% on 1000000 for 6 hours (Initial balance)
            5000n + // - T2: 2% on 1000000 for 6 hours (Initial balance)
            10150n, // - T3: 1% on 3000000 + 1000000 + 60000 for 6 hours (Initial balance + Stream yield + FDP yield)
          partialFirstDayYieldTiered: [
            // PFD Total: 60000
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, HOUR * 18n), // - PFD T1: 22500
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, HOUR * 18n), // - PFD T2: 15000
            simpleYield(3000000n, (RATE_FACTOR / 100n) * 1n, HOUR * 18n) // -- PFD T3: 22500
          ],
          fullDaysYieldTiered: [0n, 0n, 0n],
          partialLastDayYieldTiered: [
            // PLD Total: 22650
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 3n, HOUR * 6n), // - PLD T1: 7500
            simpleYield(1000000n, (RATE_FACTOR / 100n) * 2n, HOUR * 6n), // - PLD T2: 5000
            simpleYield(
              3000000n + // - Initial balance
              1000000n + // - Stream yield
              60000n, // ---- PFD yield
              (RATE_FACTOR / 100n) * 1n,
              HOUR * 6n
            ) // ------------------------------------------------------------ PLD T3: 10105
          ]
        }
      }
    ];

    for (const [index, testCase] of testCases.entries()) {
      it(`Executes as expected for test case  ${index + 1}: ${testCase.description}`, async () => {
        const { yieldStreamer } = await setUpFixture(deployContracts);

        if (testCase.shouldRevert) {
          // Call the `_compoundYield()` function via the testable contract version and expect it to revert
          await expect(yieldStreamer.compoundYield(testCase.params)).to.be.revertedWithCustomError(
            yieldStreamer,
            testCase.revertMessage!
          );
        } else {
          // Call the `_compoundYield()` function via the testable contract version and expect it to return
          const yieldResultRaw = await yieldStreamer.compoundYield(testCase.params);

          // Convert the function result to a comparable format
          const yieldResult = normalizeYieldResult(yieldResultRaw);

          // Assertion
          expect(yieldResult).to.deep.equal(testCase.expected);
        }
      });
    }
  });

  describe("Function '_calculateTieredYield()'", async () => {
    interface CalculateTieredYieldTestCase {
      description: string;
      amount: bigint;
      tiers: RateTier[];
      elapsedSeconds: bigint;
      expectedTieredYield: bigint[];
    }

    const testCases: CalculateTieredYieldTestCase[] = [
      {
        description: "Single tier - zero cap - 1 hour",
        amount: 650000000n,
        tiers: [{ rate: (RATE_FACTOR / 100n) * 5n, cap: 0n }],
        elapsedSeconds: HOUR,
        expectedTieredYield: [((RATE_FACTOR / 100n) * 5n * 650000000n * HOUR) / (DAY * RATE_FACTOR)]
      },
      {
        description: "Multiple tiers - total cap less than amount - 1 hour",
        amount: 650000000n,
        tiers: [
          { rate: (RATE_FACTOR / 100n) * 5n, cap: 300000000n },
          { rate: (RATE_FACTOR / 100n) * 3n, cap: 200000000n },
          { rate: (RATE_FACTOR / 100n) * 2n, cap: 100000000n },
          { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n }
        ],
        elapsedSeconds: HOUR,
        expectedTieredYield: [
          ((RATE_FACTOR / 100n) * 5n * 300000000n * HOUR) / (DAY * RATE_FACTOR),
          ((RATE_FACTOR / 100n) * 3n * 200000000n * HOUR) / (DAY * RATE_FACTOR),
          ((RATE_FACTOR / 100n) * 2n * 100000000n * HOUR) / (DAY * RATE_FACTOR),
          ((RATE_FACTOR / 100n) * 1n * 50000000n * HOUR) / (DAY * RATE_FACTOR)
        ]
      },
      {
        description: "Multiple tiers - total cap greater than amount - 1 hour",
        amount: 450000000n,
        tiers: [
          { rate: (RATE_FACTOR / 100n) * 5n, cap: 300000000n },
          { rate: (RATE_FACTOR / 100n) * 3n, cap: 200000000n },
          { rate: (RATE_FACTOR / 100n) * 2n, cap: 100000000n },
          { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n }
        ],
        elapsedSeconds: HOUR,
        expectedTieredYield: [
          ((RATE_FACTOR / 100n) * 5n * 300000000n * HOUR) / (DAY * RATE_FACTOR),
          ((RATE_FACTOR / 100n) * 3n * 150000000n * HOUR) / (DAY * RATE_FACTOR),
          0n,
          0n
        ]
      },
      {
        description: "Multiple tiers - total cap greater than amount - 1 day + 3 hours",
        amount: 450000000n,
        tiers: [
          { rate: (RATE_FACTOR / 100n) * 5n, cap: 300000000n },
          { rate: (RATE_FACTOR / 100n) * 3n, cap: 200000000n },
          { rate: (RATE_FACTOR / 100n) * 2n, cap: 100000000n },
          { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n }
        ],
        elapsedSeconds: DAY + HOUR * 3n,
        expectedTieredYield: [
          ((RATE_FACTOR / 100n) * 5n * 300000000n * (DAY + HOUR * 3n)) / (DAY * RATE_FACTOR),
          ((RATE_FACTOR / 100n) * 3n * 150000000n * (DAY + HOUR * 3n)) / (DAY * RATE_FACTOR),
          0n,
          0n
        ]
      },
      {
        description: "Multiple tiers - total cap greater than amount - 2 days + 18 hours",
        amount: 450000000n,
        tiers: [
          { rate: (RATE_FACTOR / 100n) * 5n, cap: 300000000n },
          { rate: (RATE_FACTOR / 100n) * 3n, cap: 200000000n },
          { rate: (RATE_FACTOR / 100n) * 2n, cap: 100000000n },
          { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n }
        ],
        elapsedSeconds: DAY * 2n + HOUR * 18n,
        expectedTieredYield: [
          ((RATE_FACTOR / 100n) * 5n * 300000000n * (DAY * 2n + HOUR * 18n)) / (DAY * RATE_FACTOR),
          ((RATE_FACTOR / 100n) * 3n * 150000000n * (DAY * 2n + HOUR * 18n)) / (DAY * RATE_FACTOR),
          0n,
          0n
        ]
      },
      {
        description: "Multiple tiers - zero rates present in the tiers array",
        amount: 650000000n,
        tiers: [
          { rate: 0n, cap: 300000000n },
          { rate: (RATE_FACTOR / 100n) * 2n, cap: 200000000n },
          { rate: 0n, cap: 100000000n },
          { rate: (RATE_FACTOR / 100n) * 1n, cap: 50000000n }
        ],
        elapsedSeconds: HOUR,
        expectedTieredYield: [
          0n,
          ((RATE_FACTOR / 100n) * 2n * 200000000n * HOUR) / (DAY * RATE_FACTOR),
          0n,
          ((RATE_FACTOR / 100n) * 1n * 50000000n * HOUR) / (DAY * RATE_FACTOR)
        ]
      },
      {
        description: "Multiple tiers - zero elapsed seconds",
        amount: 650000000n,
        tiers: [
          { rate: (RATE_FACTOR / 100n) * 5n, cap: 300000000n },
          { rate: (RATE_FACTOR / 100n) * 3n, cap: 200000000n },
          { rate: (RATE_FACTOR / 100n) * 2n, cap: 100000000n },
          { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n }
        ],
        elapsedSeconds: 0n,
        expectedTieredYield: [0n, 0n, 0n, 0n]
      },
      {
        description: "Nultiple tiers - zero amount",
        amount: 0n,
        tiers: [
          { rate: (RATE_FACTOR / 100n) * 5n, cap: 300000000n },
          { rate: (RATE_FACTOR / 100n) * 3n, cap: 200000000n },
          { rate: (RATE_FACTOR / 100n) * 2n, cap: 100000000n },
          { rate: (RATE_FACTOR / 100n) * 1n, cap: 0n }
        ],
        elapsedSeconds: HOUR,
        expectedTieredYield: [0n, 0n, 0n, 0n]
      }
    ];

    for (const [index, testCase] of testCases.entries()) {
      it(`Executes as expected for test case ${index + 1}: ${testCase.description}`, async () => {
        const { yieldStreamer } = await setUpFixture(deployContracts);

        // Calculate the expected yield
        const expectedTotalYield = testCase.expectedTieredYield.reduce((acc, curr) => acc + curr, 0n);

        // Call the `_calculateTieredYield()` function via the testable contract version
        const resultRaw = await yieldStreamer.calculateTieredYield(
          testCase.amount,
          testCase.elapsedSeconds,
          testCase.tiers
        );

        // Convert the function result to a comparable format
        const totalYield: bigint = resultRaw[0];
        const tieredYield: bigint[] = resultRaw[1];

        // Assertion
        expect(tieredYield).to.deep.equal(testCase.expectedTieredYield);
        expect(totalYield).to.equal(expectedTotalYield);
      });
    }
  });

  describe("Function '_calculateSimpleYield()'", async () => {
    it("Returns zero when the provided rate is zero", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      const amount = 1000n;
      const rate = 0n; // Zero rate
      const elapsedSeconds = (HOUR);

      // Call the `_calculateSimpleYield()` function via the testable contract version
      const yieldAmount = await yieldStreamer.calculateSimpleYield(amount, rate, elapsedSeconds);

      // Assertion
      expect(yieldAmount).to.equal(0);
    });

    it("Returns zero when the provided amount is zero", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      const amount = 0n; // Zero amount
      const rate = 1000n;
      const elapsedSeconds = (HOUR);

      // Call the `_calculateSimpleYield()` function via the testable contract version
      const yieldAmount = await yieldStreamer.calculateSimpleYield(amount, rate, elapsedSeconds);

      // Assertion
      expect(yieldAmount).to.equal(0);
    });

    it("Returns zero when the provided 'elapsedSeconds' parameter is zero", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      const amount = 1000n;
      const rate = 1000n;
      const elapsedSeconds = 0n; // Zero elapsed seconds

      // Call the `_calculateSimpleYield()` function via the testable contract version
      const yieldAmount = await yieldStreamer.calculateSimpleYield(amount, rate, elapsedSeconds);

      // Assertion
      expect(yieldAmount).to.equal(0);
    });

    it("Calculates the yield correctly when provided elapsed seconds are equal to 1 day", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      const amount = 123456789n;
      const rate = 123456789n;
      const elapsedSeconds = DAY;
      const expectedYield = (amount * rate * elapsedSeconds) / (DAY * RATE_FACTOR);

      // Call the `_calculateSimpleYield()` function via the testable contract version
      const yieldAmount = await yieldStreamer.calculateSimpleYield(amount, rate, elapsedSeconds);

      // Assertion
      expect(yieldAmount).to.equal(expectedYield);
    });

    it("Сalculates the yield correctly when provided elapsed seconds are less than 1 day", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      const amount = 123456789n;
      const rate = 123456789n;
      const elapsedSeconds = HOUR * 3n;
      const expectedYield = (amount * rate * elapsedSeconds) / (DAY * RATE_FACTOR);

      // Call the `calculateSimpleYield` function
      const yieldAmount = await yieldStreamer.calculateSimpleYield(amount, rate, elapsedSeconds);

      // Assertion
      expect(yieldAmount).to.equal(expectedYield);
    });

    it("Calculates the yield correctly when provided elapsed seconds are greater than 1 day", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      const amount = 123456789n;
      const rate = 123456789n;
      const elapsedSeconds = DAY * 2n + HOUR * 3n;
      const expectedYield = (amount * rate * elapsedSeconds) / (DAY * RATE_FACTOR);

      // Call the `_calculateSimpleYield()` function via the testable contract version
      const yieldAmount = await yieldStreamer.calculateSimpleYield(amount, rate, elapsedSeconds);

      // Assertion
      expect(yieldAmount).to.equal(expectedYield);
    });
  });

  describe("Function '_inRangeYieldRates()'", async () => {
    it("Returns indices (0, 0) when there is only one yield rate in the array", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // Set up `fromTimestamp` and `toTimestamp`
      const fromTimestamp = 100n;
      const toTimestamp = 200n;

      // Set up one yield rate with `effectiveDay` equal to 0
      // It's a rule that the first rate has to be with `effectiveDay` equal to 0
      const rates: YieldRate[] = [
        {
          tiers: [{ rate: 1000n, cap: 1000n }],
          effectiveDay: 0n
        }
      ];

      // Call the `_calculateSimpleYield()` function via the testable contract version
      const [startIndex, endIndex] = await yieldStreamer.inRangeYieldRates(rates, fromTimestamp, toTimestamp);

      // Assertion
      expect(startIndex).to.equal(0);
      expect(endIndex).to.equal(0);
    });

    /**
     * Testing with varying `fromTimestamp` and `toTimestamp` values, and multiple rates.
     * Test cases are prepared to cover all the possible scenarios.
     */

    interface InRangeYieldRatesTestCase {
      description: string;
      fromTimestamp: bigint;
      toTimestamp: bigint;
      expectedStartIndex: number;
      expectedEndIndex: number;
    }

    const firstRateEffectiveDay = 0n;
    const secondRateEffectiveDay = 10n;
    const thirdRateEffectiveDay = 20n;

    const testRates: YieldRate[] = [
      {
        tiers: [{ rate: 1000n, cap: 1000n }],
        effectiveDay: firstRateEffectiveDay
      },
      {
        tiers: [{ rate: 2000n, cap: 2000n }],
        effectiveDay: secondRateEffectiveDay
      },
      {
        tiers: [{ rate: 3000n, cap: 3000n }],
        effectiveDay: thirdRateEffectiveDay
      }
    ];

    const testCases: InRangeYieldRatesTestCase[] = [
      {
        description:
          "`fromTimestamp` is 2s before the second rate eff. day, `toTimestamp` is 1s before the second rate eff. day",
        fromTimestamp: -2n + secondRateEffectiveDay * DAY,
        toTimestamp: -1n + secondRateEffectiveDay * DAY,
        expectedStartIndex: 0,
        expectedEndIndex: 0
      },
      {
        description:
          "`fromTimestamp` is 1s before the second rate eff. day, `toTimestamp` is exactly on the second rate eff. day",
        fromTimestamp: -1n + secondRateEffectiveDay * DAY,
        toTimestamp: 0n + secondRateEffectiveDay * DAY,
        expectedStartIndex: 0,
        expectedEndIndex: 0
      },
      {
        description:
          "`fromTimestamp` is 1s before the second rate eff. day, `toTimestamp` is 1s after the second rate eff. day",
        fromTimestamp: -1n + secondRateEffectiveDay * DAY,
        toTimestamp: 1n + secondRateEffectiveDay * DAY,
        expectedStartIndex: 0,
        expectedEndIndex: 1
      },
      {
        description:
          "`fromTimestamp` is 1s before the second rate eff. day, `toTimestamp` is 1s before the third rate eff. day",
        fromTimestamp: -1n + secondRateEffectiveDay * DAY,
        toTimestamp: -1n + thirdRateEffectiveDay * DAY,
        expectedStartIndex: 0,
        expectedEndIndex: 1
      },
      {
        description:
          "`fromTimestamp` is 1s before the second rate eff. day, `toTimestamp` is exactly on the third rate eff. day",
        fromTimestamp: -1n + secondRateEffectiveDay * DAY,
        toTimestamp: 0n + thirdRateEffectiveDay * DAY,
        expectedStartIndex: 0,
        expectedEndIndex: 1
      },
      {
        description:
          "`fromTimestamp` is 1s before the second rate eff. day, `toTimestamp` is 1s after the third rate eff. day",
        fromTimestamp: -1n + secondRateEffectiveDay * DAY,
        toTimestamp: 1n + thirdRateEffectiveDay * DAY,
        expectedStartIndex: 0,
        expectedEndIndex: 2
      },
      {
        description:
          "`fromTimestamp` is exactly on the second rate eff. day, `toTimestamp` is 1s after the third rate eff. day",
        fromTimestamp: 0n + secondRateEffectiveDay * DAY,
        toTimestamp: 1n + thirdRateEffectiveDay * DAY,
        expectedStartIndex: 1,
        expectedEndIndex: 2
      },
      {
        description:
          "`fromTimestamp` is 1s after the second rate eff. day, `toTimestamp` is 1s after the third rate eff. day",
        fromTimestamp: 1n + secondRateEffectiveDay * DAY,
        toTimestamp: 1n + thirdRateEffectiveDay * DAY,
        expectedStartIndex: 1,
        expectedEndIndex: 2
      },
      {
        description:
          "`fromTimestamp` is 1s before the third rate eff. day, `toTimestamp` is 1s after the third rate eff. day",
        fromTimestamp: -1n + thirdRateEffectiveDay * DAY,
        toTimestamp: 1n + thirdRateEffectiveDay * DAY,
        expectedStartIndex: 1,
        expectedEndIndex: 2
      },
      {
        description:
          "`fromTimestamp` is exactly on the third rate eff. day, `toTimestamp` is 1s after the third rate eff. day",
        fromTimestamp: 0n + thirdRateEffectiveDay * DAY,
        toTimestamp: 1n + thirdRateEffectiveDay * DAY,
        expectedStartIndex: 2,
        expectedEndIndex: 2
      },
      {
        description:
          "`fromTimestamp` is 1s after the third rate eff. day, `toTimestamp` is 2s after the third rate eff. day",
        fromTimestamp: 1n + thirdRateEffectiveDay * DAY,
        toTimestamp: 2n + thirdRateEffectiveDay * DAY,
        expectedStartIndex: 2,
        expectedEndIndex: 2
      },
      {
        description:
          "`fromTimestamp` is exactly on the second rate eff. day, `toTimestamp` is 1s before the third rate eff. day",
        fromTimestamp: 0n + secondRateEffectiveDay * DAY,
        toTimestamp: -1n + thirdRateEffectiveDay * DAY,
        expectedStartIndex: 1,
        expectedEndIndex: 1
      }
    ];

    for (const [index, testCase] of testCases.entries()) {
      it(`Executes as expected for test case  ${index + 1}: ${testCase.description}.`, async () => {
        const { yieldStreamer } = await setUpFixture(deployContracts);

        // Call the `_inRangeYieldRates()` function via the testable contract version for the given test case
        const [startIndex, endIndex] = await yieldStreamer.inRangeYieldRates(
          testRates,
          testCase.fromTimestamp,
          testCase.toTimestamp
        );

        // Assertion
        expect(startIndex).to.equal(testCase.expectedStartIndex);
        expect(endIndex).to.equal(testCase.expectedEndIndex);
      });
    }

    it("Is reverted when `fromTimestamp` is greater than `toTimestamp`", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // Set up `fromTimestamp` and `toTimestamp`
      const fromTimestamp = 101n;
      const toTimestamp = 100n;

      // Call the `_inRangeYieldRates()` function via the testable contract version
      await expect(
        yieldStreamer.inRangeYieldRates(testRates, fromTimestamp, toTimestamp)
      ).to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_TimeRangeIsInvalid);
    });

    it("Is reverted when `fromTimestamp` is equal to `toTimestamp`", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // Set up `fromTimestamp` and `toTimestamp`
      const fromTimestamp = 100n;
      const toTimestamp = 100n;

      // Call the `_inRangeYieldRates()` function via the testable contract version
      await expect(
        yieldStreamer.inRangeYieldRates(testRates, fromTimestamp, toTimestamp)
      ).to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_TimeRangeIsInvalid);
    });

    it("Is reverted when there are no yield rates in the array", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // Set up `fromTimestamp` and `toTimestamp`
      const fromTimestamp = 100n;
      const toTimestamp = 200n;

      // Call the `_inRangeYieldRates()` function via the testable contract version
      await expect(
        yieldStreamer.inRangeYieldRates([], fromTimestamp, toTimestamp)
      ).to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_YieldRateArrayIsEmpty);
    });
  });

  describe("Function '_aggregateYield()'", async () => {
    it("Correctly aggregates a single yield result", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // Set up a single yield result with sample values
      const yieldResult: YieldResult = {
        partialFirstDayYield: 100n,
        fullDaysYield: 200n,
        partialLastDayYield: 50n,
        partialFirstDayYieldTiered: [100n],
        fullDaysYieldTiered: [200n],
        partialLastDayYieldTiered: [50n]
      };
      const yieldResults: YieldResult[] = [yieldResult];

      // Calculate expected values based on the function logic
      const expectedAccruedYield = yieldResult.partialFirstDayYield + yieldResult.fullDaysYield;
      const expectedStreamYield = yieldResult.partialLastDayYield;

      // Call the `_aggregateYield()` function via the testable contract version with the yield results
      const [accruedYield, streamYield] = await yieldStreamer.aggregateYield(yieldResults);

      // Assertion
      expect(accruedYield).to.equal(expectedAccruedYield);
      expect(streamYield).to.equal(expectedStreamYield);
    });

    it("Correctly aggregates multiple yield results", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // Set up multiple yield results with sample values
      const yieldResults: YieldResult[] = [
        {
          partialFirstDayYield: 100n,
          fullDaysYield: 200n,
          partialLastDayYield: 50n,
          partialFirstDayYieldTiered: [100n],
          fullDaysYieldTiered: [200n],
          partialLastDayYieldTiered: [50n]
        },
        {
          partialFirstDayYield: 80n,
          fullDaysYield: 150n,
          partialLastDayYield: 40n,
          partialFirstDayYieldTiered: [80n],
          fullDaysYieldTiered: [150n],
          partialLastDayYieldTiered: [40n]
        },
        {
          partialFirstDayYield: 70n,
          fullDaysYield: 120n,
          partialLastDayYield: 30n,
          partialFirstDayYieldTiered: [70n],
          fullDaysYieldTiered: [120n],
          partialLastDayYieldTiered: [30n]
        }
      ];

      // Calculate expected `accruedYield` according to the function logic
      const expectedAccruedYield =
        // First period: include `partialFirstDayYield`, `fullDaysYield`, and `partialLastDayYield`
        yieldResults[0].partialFirstDayYield +
        yieldResults[0].fullDaysYield +
        yieldResults[0].partialLastDayYield +
        // Second period: include `partialFirstDayYield`, `fullDaysYield`, and `partialLastDayYield`
        yieldResults[1].partialFirstDayYield +
        yieldResults[1].fullDaysYield +
        yieldResults[1].partialLastDayYield +
        // Third period: include `partialFirstDayYield` and `fullDaysYield` (exclude `partialLastDayYield`)
        yieldResults[2].partialFirstDayYield +
        yieldResults[2].fullDaysYield;
      // Calculate expected `streamYield` according to the function logic
      const expectedStreamYield = yieldResults[yieldResults.length - 1].partialLastDayYield;

      // Call the `_aggregateYield()` function via the testable contract version with the yield results
      const [accruedYield, streamYield] = await yieldStreamer.aggregateYield(yieldResults);

      // Assertion
      expect(accruedYield).to.equal(expectedAccruedYield);
      expect(streamYield).to.equal(expectedStreamYield);
    });

    it("Correctly aggregates an empty yield results array", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // Call the `_aggregateYield()` function via the testable contract version with an empty array
      const yieldResults: YieldResult[] = [];
      const [accruedYield, streamYield] = await yieldStreamer.aggregateYield(yieldResults);

      // Assertion
      expect(accruedYield).to.equal(0);
      expect(streamYield).to.equal(0);
    });
  });

  describe("Function '_effectiveTimestamp()'", async () => {
    it("Returns the effective timestamp as expected", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      const timestamps = [0n, 1n, 50n, 86399n, 86400n, 86401n, 2n * 86400n, 3n * 86400n + 12345n, 1660135722n];

      for (const timestamp of timestamps) {
        const effectiveTimestamp = await yieldStreamer.effectiveTimestamp(timestamp); // Call via the testable version
        const expectedEffectiveTimestamp = (timestamp / DAY) * DAY;
        expect(effectiveTimestamp).to.equal(expectedEffectiveTimestamp);
      }
    });
  });

  describe("Function '_truncateArray()'", async () => {
    it("Returns the full array when `startIndex` is 0 and `endIndex` is `rates.length - 1`", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      const rates = createSampleYieldRates(5);

      // Call the `truncateArray` function via the testable contract version
      const yieldRatesRaw = await yieldStreamer.truncateArray(0, rates.length - 1, rates);
      const yieldRates: YieldRate[] = yieldRatesRaw.map(normalizeYieldRate);

      // Assertion
      expect(yieldRates).to.deep.equal(rates);
    });

    it("Returns a truncated array when `startIndex` and `endIndex` are different (internal range)", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      const rates = createSampleYieldRates(5);

      // Call the `_truncateArray()` function
      const yieldRatesRaw = await yieldStreamer.truncateArray(1, 3, rates);
      const yieldRates: YieldRate[] = yieldRatesRaw.map(normalizeYieldRate); // Call via the testable version

      // Assertion
      expect(yieldRates).to.deep.equal(rates.slice(1, 4));
    });

    it("Return a truncated array when `startIndex` != `endIndex` (include the first element)", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      const rates = createSampleYieldRates(5);

      // Call the `truncateArray` function
      const yieldRatesRaw = await yieldStreamer.truncateArray(0, 3, rates); // Call via the testable version
      const yieldRates: YieldRate[] = yieldRatesRaw.map(normalizeYieldRate);

      // Assertion
      expect(yieldRates).to.deep.equal(rates.slice(0, 4));
    });

    it("Returns a truncated array when `startIndex` != `endIndex` (include the last element)", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      const rates = createSampleYieldRates(5);

      // Call the `truncateArray` function
      const yieldRatesRaw = await yieldStreamer.truncateArray(1, 4, rates); // Call via the testable version
      const yieldRates: YieldRate[] = yieldRatesRaw.map(normalizeYieldRate);

      // Assertion
      expect(yieldRates).to.deep.equal(rates.slice(1, 5));
    });

    it("Returns a single element when `startIndex` == `endIndex` (multiple rates in array)", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      const rates = createSampleYieldRates(5);

      // Call the `_truncateArray()` function via the testable contract version
      const yieldRatesRaw = await yieldStreamer.truncateArray(2, 2, rates);
      const yieldRates: YieldRate[] = yieldRatesRaw.map(normalizeYieldRate);

      // Assertion
      expect(yieldRates.length).to.equal(1);
      expect(yieldRates[0]).to.deep.equal(rates[2]);
    });

    it("Returns a single element when `startIndex` == `endIndex` (single rate in array)", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      const rates = createSampleYieldRates(1);

      // Call the `_truncateArray()` function via the testable contract version
      const yieldRatesRaw = await yieldStreamer.truncateArray(0, 0, rates);
      const yieldRates: YieldRate[] = yieldRatesRaw.map(normalizeYieldRate);

      // Assertion
      expect(yieldRates.length).to.equal(1);
      expect(yieldRates[0]).to.deep.equal(rates[0]);
    });

    it("Is reverted when `startIndex` is greater than `endIndex`", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      const rates = createSampleYieldRates(5);

      // Arithmetic operation overflowed outside an unchecked block
      await expect(yieldStreamer.truncateArray(3, 2, rates)).to.be.revertedWithPanic(0x11);
    });

    it("Is reverted when `endIndex` is out of bounds", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      const rates = createSampleYieldRates(5);

      // Array accessed at an out-of-bounds or negative index
      await expect(yieldStreamer.truncateArray(5, 5, rates)).to.be.revertedWithPanic(0x32);
    });

    it("Is reverted when rates array is empty", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // Array accessed at an out-of-bounds or negative index
      await expect(yieldStreamer.truncateArray(0, 0, [])).to.be.revertedWithPanic(0x32);
    });
  });

  describe("Function '_calculateFee()'", async () => {
    it("Calculates fee as expected", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // `FEE_RATE` is 0, so the fee should always be 0
      expect(await yieldStreamer.calculateFee(0n)).to.equal(0n);
      expect(await yieldStreamer.calculateFee(1000000n)).to.equal(0n);
      expect(await yieldStreamer.calculateFee(1000000000000n)).to.equal(0n);
    });
  });

  describe("Function '_roundDown()'", async () => {
    it("Rounds down as expected", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      expect(await yieldStreamer.roundDown(0n)).to.equal(0n);
      expect(await yieldStreamer.roundDown(10000000n)).to.equal(10000000n);
      expect(await yieldStreamer.roundDown(10000001n)).to.equal(10000000n);
      expect(await yieldStreamer.roundDown(10009999n)).to.equal(10000000n);
    });
  });

  describe("Function '_roundUp()'", async () => {
    it("Rounds up as expected", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      expect(await yieldStreamer.roundUp(0n)).to.equal(0n);
      expect(await yieldStreamer.roundUp(10000000n)).to.equal(10000000n);
      expect(await yieldStreamer.roundUp(10000001n)).to.equal(10010000n);
      expect(await yieldStreamer.roundUp(10009999n)).to.equal(10010000n);
    });
  });

  describe("Function '_map()'", async () => {
    // Create an `AccruePreview` struct with sample data
    const accruePreview: AccruePreview = {
      fromTimestamp: 10000000n,
      toTimestamp: 20000000n,
      balance: 30000000n,
      streamYieldBefore: 199996n,
      accruedYieldBefore: 299996n,
      streamYieldAfter: 499996n,
      accruedYieldAfter: 399996n,
      rates: [
        {
          tiers: [
            { rate: 101n, cap: 102n },
            { rate: 201n, cap: 202n }
          ],
          effectiveDay: 1n
        },
        {
          tiers: [
            { rate: 301n, cap: 302n },
            { rate: 401n, cap: 402n }
          ],
          effectiveDay: 9n
        }
      ],
      results: [
        {
          partialFirstDayYield: 111n,
          fullDaysYield: 211n,
          partialLastDayYield: 311n,
          partialFirstDayYieldTiered: [101n, 10n],
          fullDaysYieldTiered: [201n, 10n],
          partialLastDayYieldTiered: [301n, 10n]
        },
        {
          partialFirstDayYield: 411n,
          fullDaysYield: 511n,
          partialLastDayYield: 611n,
          partialFirstDayYieldTiered: [401n, 10n],
          fullDaysYieldTiered: [501n, 10n],
          partialLastDayYieldTiered: [601n, 10n]
        }
      ]
    };

    it("Executes as expected", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // Call the `_map()` function via the testable contract version
      const actualClaimPreviewRaw: ClaimPreview = await yieldStreamer.map(accruePreview);

      // Create the `ClaimPreview` struct with expected values
      const expectedClaimPreview: ClaimPreview = {
        yieldExact: accruePreview.accruedYieldAfter + accruePreview.streamYieldAfter,
        yieldRounded: roundDown(accruePreview.accruedYieldAfter + accruePreview.streamYieldAfter),
        feeExact: 0n,
        feeRounded: 0n,
        balance: accruePreview.balance,
        timestamp: accruePreview.toTimestamp,
        rates: accruePreview.rates[accruePreview.rates.length - 1].tiers.map(tier => tier.rate),
        caps: accruePreview.rates[accruePreview.rates.length - 1].tiers.map(tier => tier.cap)
      };

      const actualClaimPreview = normalizeClaimPreview(actualClaimPreviewRaw);

      // Assertion
      expect(actualClaimPreview).to.deep.equal(expectedClaimPreview);
    });
  });
});
