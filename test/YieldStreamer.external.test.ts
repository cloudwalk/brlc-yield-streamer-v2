import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { Contract, ContractFactory, TransactionResponse } from "ethers";
import {
  checkContractUupsUpgrading,
  connect,
  getAddress,
  getLatestBlockTimestamp,
  getTxTimestamp,
  increaseBlockTimestampTo,
  proveTx
} from "../test-utils/eth";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { checkEquality, setUpFixture } from "../test-utils/common";
import {
  DAY,
  defaultYieldState,
  ENABLE_YIELD_STATE_AUTO_INITIALIZATION,
  ERRORS,
  FEE_RATE,
  HOUR,
  MIN_CLAIM_AMOUNT,
  NEGATIVE_TIME_SHIFT,
  RATE_FACTOR,
  ROUND_FACTOR,
  YieldRate,
  YieldState
} from "../test-utils/specific";

const ADDRESS_ZERO = ethers.ZeroAddress;
const DEFAULT_GROUP_ID = 0n;
const DEFAULT_SOURCE_GROUP_KEY = ethers.ZeroHash;
const STATE_FLAG_INITIALIZED = 1n;

const INITIAL_YIELD_STREAMER_BALANCE = 1_000_000_000n;
const RATE_40 = (RATE_FACTOR * 40n) / 100n; // 40%
const RATE_80 = (RATE_FACTOR * 80n) / 100n; // 80%
const YIELD_RATE = (RATE_FACTOR * 10n) / 100n; // 10%

const OWNER_ROLE: string = ethers.id("OWNER_ROLE");
const ADMIN_ROLE: string = ethers.id("ADMIN_ROLE");
const PAUSER_ROLE: string = ethers.id("PAUSER_ROLE");

// export interface ClaimResult {
//   nextClaimDay: bigint;
//   nextClaimDebit: bigint;
//   firstYieldDay: bigint;
//   prevClaimDebit: bigint;
//   primaryYield: bigint;
//   streamYield: bigint;
//   lastDayPartialYield: bigint;
//   shortfall: bigint;
//   fee: bigint;
//   yield: bigint;
// }

interface Version {
  major: number;
  minor: number;
  patch: number;

  [key: string]: number; // Indexing signature to ensure that fields are iterated over in a key-value style
}

interface BalanceActionItem {
  relativeTime: { day: bigint; hour: bigint }; // The action time relative to the scenario start time
  balanceChange: bigint; // Amount to increase (positive) or decrease (negative) the balance
  expectedYieldState: { // The expected yield state fields after the balance action
    lastUpdateBalance: bigint;
    accruedYield: bigint;
    streamYield: bigint;
  };
}

interface Fixture {
  yieldStreamer: Contract;
  yieldStreamerUnderAdmin: Contract;
  yieldStreamerV1Mock: Contract;
  tokenMock: Contract;
  tokenMockAddress: string;
}

const EXPECTED_VERSION: Version = {
  major: 2,
  minor: 2,
  patch: 0
};

// export const defaultClaimResult: ClaimResult = {
//   nextClaimDay: 0n,
//   nextClaimDebit: 0n,
//   firstYieldDay: 0n,
//   prevClaimDebit: 0n,
//   primaryYield: 10000000n,
//   streamYield: 0n,
//   lastDayPartialYield: 1999999n,
//   shortfall: 0n,
//   fee: 0n,
//   yield: 0n
// };

describe("Contract 'YieldStreamer' regarding external functions", async () => {
  let yieldStreamerFactory: ContractFactory;
  let yieldStreamerV1MockFactory: ContractFactory;
  let tokenMockFactory: ContractFactory;

  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  before(async () => {
    [deployer, admin, user, stranger] = await ethers.getSigners();

    // Factories with an explicitly specified deployer account
    yieldStreamerFactory = await ethers.getContractFactory("YieldStreamerTestable");
    yieldStreamerFactory = yieldStreamerFactory.connect(deployer);
    yieldStreamerV1MockFactory = await ethers.getContractFactory("YieldStreamerV1Mock");
    yieldStreamerV1MockFactory = yieldStreamerV1MockFactory.connect(deployer);
    tokenMockFactory = await ethers.getContractFactory("ERC20TokenMock");
    tokenMockFactory = tokenMockFactory.connect(deployer);
  });

  function adjustTimestamp(timestamp: number | bigint): bigint {
    return BigInt(timestamp) - NEGATIVE_TIME_SHIFT;
  }

  function normalizeTimestamp(timestamp: number | bigint): number {
    return Number(BigInt(timestamp) + NEGATIVE_TIME_SHIFT);
  }

  async function getLatestBlockAdjustedTimestamp(): Promise<bigint> {
    return adjustTimestamp(await getLatestBlockTimestamp());
  }

  async function getNearestDayEndAdjustedTimestamp(): Promise<bigint> {
    const adjustedTimestamp = await getLatestBlockAdjustedTimestamp();
    return (adjustedTimestamp / DAY) * DAY + DAY - 1n;
  }

  function calculateEffectiveDay(adjustedTimestamp: bigint, additionalNumberOfDays: bigint): bigint {
    return (adjustedTimestamp + additionalNumberOfDays * DAY) / DAY;
  }

  async function addYieldRates(
    yieldStreamer: Contract,
    yieldRates: YieldRate[],
    groupId: number | bigint = DEFAULT_GROUP_ID
  ): Promise<void> {
    for (const yieldRate of yieldRates) {
      const tierRates = yieldRate.tiers.map(tier => tier.rate);
      const tierCaps = yieldRate.tiers.map(tier => tier.cap);
      await proveTx(yieldStreamer.addYieldRate(groupId, yieldRate.effectiveDay, tierRates, tierCaps));
    }
  }

  async function executeBalanceActionsAndCheck(
    fixture: Fixture,
    yieldRates: YieldRate[],
    balanceActions: BalanceActionItem[]
  ) {
    const { yieldStreamer, tokenMock } = fixture;

    await tokenMock.setHook(getAddress(yieldStreamer));

    // Set the initialized state for the user
    await yieldStreamer.setInitializedFlag(user.address, true);

    // Add yield rates to the contract
    await addYieldRates(yieldStreamer, yieldRates);

    // Set the current block timestamp to the needed start time
    const adjustedStartTimestamp = await getNearestDayEndAdjustedTimestamp();
    await increaseBlockTimestampTo(normalizeTimestamp(adjustedStartTimestamp));

    // Iterate over each action in the schedule
    for (const [index, actionItem] of balanceActions.entries()) {
      // Calculate the desired internal timestamp for the action based on day and hour offsets
      const desiredInternalTimestamp =
        adjustedStartTimestamp + actionItem.relativeTime.day * DAY + actionItem.relativeTime.hour * HOUR;

      // Adjust for NEGATIVE_TIME_SHIFT to set the block.timestamp
      const normalizedTimestamp = normalizeTimestamp(desiredInternalTimestamp);

      // Ensure the timestamp is strictly greater than the current block timestamp
      const currentTimestamp = await getLatestBlockTimestamp();
      const timestampToSet = normalizedTimestamp <= currentTimestamp ? currentTimestamp + 1 : normalizedTimestamp;

      // Increase the blockchain time to the desired adjusted timestamp
      await increaseBlockTimestampTo(timestampToSet);

      // Perform the deposit or withdraw action based on the action type
      let tx: Promise<TransactionResponse>;
      if (actionItem.balanceChange >= 0) {
        // Perform a deposit action
        tx = tokenMock.mint(user.address, actionItem.balanceChange);
      } else {
        // Perform a withdrawal action
        tx = tokenMock.burn(user.address, -actionItem.balanceChange);
      }
      const txTimestamp = await getTxTimestamp(tx);

      // Fetch the actual yield state from the contract after the action
      const actualYieldState = await yieldStreamer.getYieldState(user.address);

      // Update the expected lastUpdateTimestamp with the adjusted block timestamp and set the correct flags
      const expectedYieldState: YieldState = {
        ...defaultYieldState,
        flags: STATE_FLAG_INITIALIZED,
        lastUpdateTimestamp: adjustTimestamp(txTimestamp),
        lastUpdateBalance: actionItem.expectedYieldState.lastUpdateBalance,
        accruedYield: actionItem.expectedYieldState.accruedYield,
        streamYield: actionItem.expectedYieldState.streamYield
      };

      // Assert that the actual yield state matches the expected state
      checkEquality(actualYieldState, expectedYieldState, index);
    }
  }

  async function deployContracts(): Promise<Fixture> {
    let tokenMock: Contract = (await tokenMockFactory.deploy("Mock Token", "MTK")) as Contract;
    tokenMock = connect(tokenMock, deployer); // Explicitly specifying the initial account
    await tokenMock.waitForDeployment();

    let yieldStreamerV1Mock: Contract = (await yieldStreamerV1MockFactory.deploy()) as Contract;
    yieldStreamerV1Mock = connect(yieldStreamerV1Mock, deployer); // Explicitly specifying the initial account
    await yieldStreamerV1Mock.waitForDeployment();

    const tokenMockAddress = getAddress(tokenMock);
    let yieldStreamer: Contract = (await upgrades.deployProxy(yieldStreamerFactory, [tokenMockAddress])) as Contract;
    yieldStreamer = connect(yieldStreamer, deployer); // Explicitly specifying the initial account
    await yieldStreamer.waitForDeployment();
    const yieldStreamerUnderAdmin = connect(yieldStreamer, admin);

    return { yieldStreamer, yieldStreamerUnderAdmin, yieldStreamerV1Mock, tokenMock, tokenMockAddress };
  }

  async function deployAndConfigureContracts(): Promise<Fixture> {
    const fixture = await deployContracts();
    const { yieldStreamer, yieldStreamerV1Mock, tokenMock } = fixture;

    await yieldStreamer.setSourceYieldStreamer(getAddress(yieldStreamerV1Mock));
    await yieldStreamerV1Mock.setBlocklister(getAddress(yieldStreamer), true);
    await yieldStreamer.grantRole(ADMIN_ROLE, admin.address);
    const yieldRate: YieldRate = {
      effectiveDay: 0n,
      tiers: [{ rate: YIELD_RATE, cap: 0n }]
    };
    await addYieldRates(yieldStreamer, [yieldRate]);

    await yieldStreamer.setInitializedFlag(user.address, true);
    await proveTx(tokenMock.mint(getAddress(yieldStreamer), INITIAL_YIELD_STREAMER_BALANCE));

    return fixture;
  }

  describe("Function initialize()", async () => {
    it("Configures the contract as expected", async () => {
      const { yieldStreamer, tokenMockAddress } = await setUpFixture(deployContracts);

      // Role hashes
      expect(await yieldStreamer.OWNER_ROLE()).to.equal(OWNER_ROLE);
      expect(await yieldStreamer.ADMIN_ROLE()).to.equal(ADMIN_ROLE);
      expect(await yieldStreamer.PAUSER_ROLE()).to.equal(PAUSER_ROLE);

      // The role admins
      expect(await yieldStreamer.getRoleAdmin(OWNER_ROLE)).to.equal(OWNER_ROLE);
      expect(await yieldStreamer.getRoleAdmin(ADMIN_ROLE)).to.equal(OWNER_ROLE);
      expect(await yieldStreamer.getRoleAdmin(PAUSER_ROLE)).to.equal(OWNER_ROLE);

      // Roles
      expect(await yieldStreamer.hasRole(OWNER_ROLE, deployer.address)).to.equal(true);
      expect(await yieldStreamer.hasRole(ADMIN_ROLE, deployer.address)).to.equal(false);
      expect(await yieldStreamer.hasRole(PAUSER_ROLE, deployer.address)).to.equal(false);

      // The initial contract state is unpaused
      expect(await yieldStreamer.paused()).to.equal(false);

      // Public constants
      expect(await yieldStreamer.RATE_FACTOR()).to.equal(RATE_FACTOR);
      expect(await yieldStreamer.ROUND_FACTOR()).to.equal(ROUND_FACTOR);
      expect(await yieldStreamer.FEE_RATE()).to.equal(FEE_RATE);
      expect(await yieldStreamer.NEGATIVE_TIME_SHIFT()).to.equal(NEGATIVE_TIME_SHIFT);
      expect(await yieldStreamer.MIN_CLAIM_AMOUNT()).to.equal(MIN_CLAIM_AMOUNT);
      expect(await yieldStreamer.ENABLE_YIELD_STATE_AUTO_INITIALIZATION()).to.equal(
        ENABLE_YIELD_STATE_AUTO_INITIALIZATION
      );

      // Default values of the internal structures, mappings and variables. Also checks the set of fields
      expect(await yieldStreamer.underlyingToken()).to.equal(tokenMockAddress);
      expect(await yieldStreamer.feeReceiver()).to.equal(ADDRESS_ZERO);
      expect(await yieldStreamer.getAccountGroup(user.address)).to.eq(DEFAULT_GROUP_ID);
      checkEquality(await yieldStreamer.getYieldState(user.address), defaultYieldState);
      const actualYieldRates = await yieldStreamer.getGroupYieldRates(DEFAULT_GROUP_ID);
      expect(actualYieldRates.length).to.equal(0);

      expect(await yieldStreamer.sourceYieldStreamer()).to.equal(ADDRESS_ZERO);
      expect(
        await yieldStreamer.getSourceGroupMapping(DEFAULT_SOURCE_GROUP_KEY) // Call via the testable version
      ).to.equal(DEFAULT_GROUP_ID);
    });

    it("Is reverted if called a second time", async () => {
      const { yieldStreamer, tokenMockAddress } = await setUpFixture(deployContracts);

      await expect(yieldStreamer.initialize(tokenMockAddress)).to.be.revertedWithCustomError(
        yieldStreamer,
        ERRORS.InvalidInitialization
      );
    });

    it("Is reverted if the internal initializer is called outside the init process", async () => {
      const { yieldStreamer, tokenMockAddress } = await setUpFixture(deployContracts);
      await expect(
        yieldStreamer.call_parent_initialize(tokenMockAddress) // Call via the testable version
      ).to.be.revertedWithCustomError(yieldStreamer, ERRORS.NotInitializing);
    });

    it("Is reverted if the unchained internal initializer is called outside the init process", async () => {
      const { yieldStreamer, tokenMockAddress } = await setUpFixture(deployContracts);
      await expect(
        yieldStreamer.call_parent_initialize_unchained(tokenMockAddress) // Call via the testable version
      ).to.be.revertedWithCustomError(yieldStreamer, ERRORS.NotInitializing);
    });
  });

  describe("Function '$__VERSION()'", async () => {
    it("Returns expected values", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);
      const actualVersion = await yieldStreamer.$__VERSION();
      checkEquality(actualVersion, EXPECTED_VERSION);
    });
  });

  describe("Function 'upgradeToAndCall()'", async () => {
    it("Executes as expected", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);
      await checkContractUupsUpgrading(yieldStreamer, yieldStreamerFactory);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      await expect(connect(yieldStreamer, admin).upgradeToAndCall(yieldStreamer, "0x"))
        .to.be.revertedWithCustomError(yieldStreamer, ERRORS.AccessControlUnauthorizedAccount)
        .withArgs(admin.address, OWNER_ROLE);
      await expect(connect(yieldStreamer, stranger).upgradeToAndCall(yieldStreamer, "0x"))
        .to.be.revertedWithCustomError(yieldStreamer, ERRORS.AccessControlUnauthorizedAccount)
        .withArgs(stranger.address, OWNER_ROLE);
    });

    it("Is reverted if the provided implementation address is not a yield streamer contract", async () => {
      const { yieldStreamer, tokenMockAddress } = await setUpFixture(deployContracts);

      await expect(yieldStreamer.upgradeToAndCall(tokenMockAddress, "0x"))
        .to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_ImplementationAddressInvalid);
    });
  });

  describe("Function 'claimAmountFor()'", async () => {
    // + Should revert when the account is not initialized.
    // + Should revert when the claim amount is below the minimum claim threshold.
    // + Should revert when the claim amount is not rounded down to the required precision.
    // Should revert when the underlying token transfer fails due to insufficient balance in the contract.
    // + Should revert if the claim amount exceeds the total available yield for the account.

    // Should successfully claim the exact minimum claim amount when all conditions are met.
    // Should successfully claim an amount equal to the account's accrued yield.
    // Should successfully claim an amount less than the account's total yield (accrued plus stream yield).
    // Should successfully claim the maximum possible yield available to the account.

    // Should correctly accrue yield before transferring the claimed amount.

    // Should correctly deduct the claimed amount from the account's accrued and stream yield balances.

    // Should correctly handle fee deduction and transfer the fee to the designated fee receiver.

    // Should emit the appropriate events upon successful yield transfer.

    // Should revert if the fee receiver address is not configured when a fee is applicable.

    // Should handle multiple consecutive claims correctly, updating the yield balances each time.

    // Should handle claims for accounts with zero yielded balance gracefully by reverting appropriately.
    // Should correctly handle claims immediately after yield accrual without delays.
    // Should revert if the _accrueYield function fails during the claim process.

    it("Is reverted if the claim amount exceeds the total available yield for the account", async () => {
      const { yieldStreamerUnderAdmin } = await setUpFixture(deployAndConfigureContracts);
      const yieldState: YieldState = {
        ...defaultYieldState,
        flags: STATE_FLAG_INITIALIZED,
        accruedYield: MIN_CLAIM_AMOUNT,
        lastUpdateTimestamp: await getLatestBlockAdjustedTimestamp()
      };
      await proveTx(yieldStreamerUnderAdmin.setYieldState(user.address, yieldState)); // Call via the testable version

      await expect(
        yieldStreamerUnderAdmin.claimAmountFor(user.address, yieldState.accruedYield + ROUND_FACTOR)
      ).to.be.revertedWithCustomError(yieldStreamerUnderAdmin, ERRORS.YieldStreamer_YieldBalanceInsufficient);
    });

    it("Is reverted if the underlying token transfer fails due to insufficient balance in the contract", async () => {
      const { yieldStreamerUnderAdmin, tokenMock } = await setUpFixture(deployAndConfigureContracts);
      const yieldState: YieldState = {
        ...defaultYieldState,
        flags: STATE_FLAG_INITIALIZED,
        accruedYield: MIN_CLAIM_AMOUNT,
        lastUpdateTimestamp: await getLatestBlockAdjustedTimestamp()
      };
      await proveTx(yieldStreamerUnderAdmin.setYieldState(user.address, yieldState)); // Call via the testable version
      await proveTx(tokenMock.burn(getAddress(yieldStreamerUnderAdmin), INITIAL_YIELD_STREAMER_BALANCE));

      await expect(
        yieldStreamerUnderAdmin.claimAmountFor(user.address, MIN_CLAIM_AMOUNT)
      ).to.be.revertedWithCustomError(tokenMock, ERRORS.ERC20InsufficientBalance);
    });

    it("Is reverted if the account is not initialized", async () => {
      const { yieldStreamerUnderAdmin } = await setUpFixture(deployAndConfigureContracts);
      const yieldState: YieldState = {
        ...defaultYieldState,
        flags: 0n,
        accruedYield: 1000n
      };
      await proveTx(yieldStreamerUnderAdmin.setYieldState(user.address, yieldState)); // Call via the testable version
      await expect(
        yieldStreamerUnderAdmin.claimAmountFor(user.address, MIN_CLAIM_AMOUNT)
      ).to.be.revertedWithCustomError(yieldStreamerUnderAdmin, ERRORS.YieldStreamer_AccountNotInitialized);
    });

    it("Is reverted if the amount is less than the minimum claim amount", async () => {
      const { yieldStreamerUnderAdmin } = await setUpFixture(deployAndConfigureContracts);
      const claimAmount = MIN_CLAIM_AMOUNT - 1n;

      await expect(
        yieldStreamerUnderAdmin.claimAmountFor(user.address, claimAmount)
      ).to.be.revertedWithCustomError(yieldStreamerUnderAdmin, ERRORS.YieldStreamer_ClaimAmountBelowMinimum);
    });

    it("Is reverted is the amount is not rounded down to the required precision", async () => {
      const { yieldStreamerUnderAdmin } = await setUpFixture(deployAndConfigureContracts);
      const claimAmount = MIN_CLAIM_AMOUNT + 1n;

      await expect(
        yieldStreamerUnderAdmin.claimAmountFor(user.address, claimAmount)
      ).to.be.revertedWithCustomError(yieldStreamerUnderAdmin, ERRORS.YieldStreamer_ClaimAmountNonRounded);
    });
  });

  describe("Function 'blockTimestamp()'", async () => {
    it("Executes as expected", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const expectedTimestamp = await getLatestBlockAdjustedTimestamp();
      const actualTimestamp = await yieldStreamer.blockTimestamp();
      expect(actualTimestamp).to.equal(expectedTimestamp);
    });
  });

  describe("Function 'proveYieldStreamer()'", async () => {
    it("Executes as expected", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      await expect(yieldStreamer.proveYieldStreamer()).to.not.be.reverted;
    });
  });

  describe("Function 'afterTokenTransfer()'", async () => {
    describe("Executes as expected in the case of", async () => {
      it("An increasing balance scenario with a single yield rate and a cap", async () => {
        const fixture = await setUpFixture(deployContracts);

        // Yield rates to be added to the contract
        const yieldRates: YieldRate[] = [{
          effectiveDay: 0n,
          tiers: [
            { rate: RATE_40, cap: 100n },
            { rate: RATE_40, cap: 0n }
          ]
        }];

        const balanceActions: BalanceActionItem[] = [
          {
            relativeTime: { day: 0n, hour: 6n },
            balanceChange: 1000n,
            expectedYieldState: {
              lastUpdateBalance: 1000n,
              accruedYield: 0n,
              streamYield: 0n
            }
          },
          {
            relativeTime: { day: 0n, hour: 12n },
            balanceChange: 1000n,
            expectedYieldState: {
              lastUpdateBalance: 2000n,
              accruedYield: 0n,
              streamYield: 100n // Assuming yield accrual logic
            }
          },
          {
            relativeTime: { day: 0n, hour: 18n },
            balanceChange: 1000n,
            expectedYieldState: {
              lastUpdateBalance: 3000n,
              accruedYield: 0n,
              streamYield: 300n
            }
          },
          {
            relativeTime: { day: 1n, hour: 6n },
            balanceChange: 1000n,
            expectedYieldState: {
              lastUpdateBalance: 4000n,
              accruedYield: 600n,
              streamYield: 360n
            }
          },
          {
            relativeTime: { day: 1n, hour: 12n },
            balanceChange: 1000n,
            expectedYieldState: {
              lastUpdateBalance: 5000n,
              accruedYield: 600n,
              streamYield: 820n
            }
          },
          {
            relativeTime: { day: 1n, hour: 18n },
            balanceChange: 1000n,
            expectedYieldState: {
              lastUpdateBalance: 6000n,
              accruedYield: 600n,
              streamYield: 1380n
            }
          },
          {
            relativeTime: { day: 4n, hour: 6n },
            balanceChange: 1000n,
            expectedYieldState: {
              lastUpdateBalance: 7000n,
              accruedYield: 10934n,
              streamYield: 1693n
            }
          },
          {
            relativeTime: { day: 4n, hour: 12n },
            balanceChange: 1000n,
            expectedYieldState: {
              lastUpdateBalance: 8000n,
              accruedYield: 10934n,
              streamYield: 3486n
            }
          },
          {
            relativeTime: { day: 4n, hour: 18n },
            balanceChange: 1000n,
            expectedYieldState: {
              lastUpdateBalance: 9000n,
              accruedYield: 10934n,
              streamYield: 5379n
            }
          },
          {
            relativeTime: { day: 5n, hour: 6n },
            balanceChange: 1000n,
            expectedYieldState: {
              lastUpdateBalance: 10000n,
              accruedYield: 18306n,
              streamYield: 2730n
            }
          },
          {
            relativeTime: { day: 5n, hour: 12n },
            balanceChange: 1000n,
            expectedYieldState: {
              lastUpdateBalance: 11000n,
              accruedYield: 18306n,
              streamYield: 5560n
            }
          },
          {
            relativeTime: { day: 5n, hour: 18n },
            balanceChange: 1000n,
            expectedYieldState: {
              lastUpdateBalance: 12000n,
              accruedYield: 18306n,
              streamYield: 8490n
            }
          }
        ];

        await executeBalanceActionsAndCheck(fixture, yieldRates, balanceActions);
      });

      it("An increasing balance scenario with multiple yield rates and caps", async () => {
        const fixture = await setUpFixture(deployContracts);

        const adjustedBlockTime = await getNearestDayEndAdjustedTimestamp();

        // Yield rates to be added to the contract
        const yieldRates: YieldRate[] = [
          // 40% yield rate at day 0
          {
            effectiveDay: 0n,
            tiers: [
              { rate: RATE_40, cap: 100n },
              { rate: RATE_40, cap: 0n }
            ]
          },
          // 80% yield rate at day 3
          {
            effectiveDay: calculateEffectiveDay(adjustedBlockTime, 3n),
            tiers: [
              { rate: RATE_80, cap: 100n },
              { rate: RATE_80, cap: 0n }
            ]
          },
          // 40% yield rate at day 5
          {
            effectiveDay: calculateEffectiveDay(adjustedBlockTime, 5n),
            tiers: [
              { rate: RATE_40, cap: 100n },
              { rate: RATE_40, cap: 0n }
            ]
          }
        ];

        // Simulated deposit schedule
        const balanceActions: BalanceActionItem[] = [
          {
            relativeTime: { day: 0n, hour: 6n },
            balanceChange: 1000n,
            expectedYieldState: {
              lastUpdateBalance: 1000n,
              accruedYield: 0n,
              streamYield: 0n
            }
          },
          {
            relativeTime: { day: 0n, hour: 12n },
            balanceChange: 1000n,
            expectedYieldState: {
              lastUpdateBalance: 2000n,
              accruedYield: 0n,
              streamYield: 100n
            }
          },
          {
            relativeTime: { day: 0n, hour: 18n },
            balanceChange: 1000n,
            expectedYieldState: {
              lastUpdateBalance: 3000n,
              accruedYield: 0n,
              streamYield: 300n
            }
          },
          {
            relativeTime: { day: 1n, hour: 6n },
            balanceChange: 1000n,
            expectedYieldState: {
              lastUpdateBalance: 4000n,
              accruedYield: 600n,
              streamYield: 360n
            }
          },
          {
            relativeTime: { day: 1n, hour: 12n },
            balanceChange: 1000n,
            expectedYieldState: {
              lastUpdateBalance: 5000n,
              accruedYield: 600n,
              streamYield: 820n
            }
          },
          {
            relativeTime: { day: 1n, hour: 18n },
            balanceChange: 1000n,
            expectedYieldState: {
              lastUpdateBalance: 6000n,
              accruedYield: 600n,
              streamYield: 1380n
            }
          },
          {
            relativeTime: { day: 4n, hour: 6n },
            balanceChange: 1000n,
            expectedYieldState: {
              lastUpdateBalance: 7000n,
              accruedYield: 21993n,
              streamYield: 2799n
            }
          },
          {
            relativeTime: { day: 4n, hour: 12n },
            balanceChange: 1000n,
            expectedYieldState: {
              lastUpdateBalance: 8000n,
              accruedYield: 21993n,
              streamYield: 5698n
            }
          },
          {
            relativeTime: { day: 4n, hour: 18n },
            balanceChange: 1000n,
            expectedYieldState: {
              lastUpdateBalance: 9000n,
              accruedYield: 21993n,
              streamYield: 8697n
            }
          },
          {
            relativeTime: { day: 5n, hour: 6n },
            balanceChange: 1000n,
            expectedYieldState: {
              lastUpdateBalance: 10000n,
              accruedYield: 33789n,
              streamYield: 4278n
            }
          },
          {
            relativeTime: { day: 5n, hour: 12n },
            balanceChange: 1000n,
            expectedYieldState: {
              lastUpdateBalance: 11000n,
              accruedYield: 33789n,
              streamYield: 8656n
            }
          },
          {
            relativeTime: { day: 5n, hour: 18n },
            balanceChange: 1000n,
            expectedYieldState: {
              lastUpdateBalance: 12000n,
              accruedYield: 33789n,
              streamYield: 13134n
            }
          }
        ];

        await executeBalanceActionsAndCheck(fixture, yieldRates, balanceActions);
      });

      it("A decreasing balance scenario with a single yield rates and a cap", async () => {
        const fixture = await setUpFixture(deployContracts);

        // Yield rates to be added to the contract
        const yieldRates: YieldRate[] = [{
          effectiveDay: 0n,
          tiers: [
            { rate: RATE_40, cap: 100n },
            { rate: RATE_40, cap: 0n }
          ]
        }];

        // Simulated action schedule of deposits and withdrawals
        const balanceActions: BalanceActionItem[] = [
          {
            relativeTime: { day: 0n, hour: 6n },
            balanceChange: 11000n,
            expectedYieldState: {
              lastUpdateBalance: 11000n,
              accruedYield: 0n,
              streamYield: 0n
            }
          },
          {
            relativeTime: { day: 0n, hour: 12n },
            balanceChange: -1000n,
            expectedYieldState: {
              lastUpdateBalance: 10000n,
              accruedYield: 0n,
              streamYield: 1100n
            }
          },
          {
            relativeTime: { day: 0n, hour: 18n },
            balanceChange: -1000n,
            expectedYieldState: {
              lastUpdateBalance: 9000n,
              accruedYield: 0n,
              streamYield: 2100n
            }
          },
          {
            relativeTime: { day: 1n, hour: 6n },
            balanceChange: -1000n,
            expectedYieldState: {
              lastUpdateBalance: 8000n,
              accruedYield: 3000n,
              streamYield: 1200n
            }
          },
          {
            relativeTime: { day: 1n, hour: 12n },
            balanceChange: -1000n,
            expectedYieldState: {
              lastUpdateBalance: 7000n,
              accruedYield: 3000n,
              streamYield: 2300n
            }
          },
          {
            relativeTime: { day: 1n, hour: 18n },
            balanceChange: -1000n,
            expectedYieldState: {
              lastUpdateBalance: 6000n,
              accruedYield: 3000n,
              streamYield: 3300n
            }
          },
          {
            relativeTime: { day: 4n, hour: 6n },
            balanceChange: -1000n,
            expectedYieldState: {
              lastUpdateBalance: 5000n,
              accruedYield: 19872n,
              streamYield: 2587n
            }
          },
          {
            relativeTime: { day: 4n, hour: 12n },
            balanceChange: -1000n,
            expectedYieldState: {
              lastUpdateBalance: 4000n,
              accruedYield: 19872n,
              streamYield: 5074n
            }
          },
          {
            relativeTime: { day: 4n, hour: 18n },
            balanceChange: -1000n,
            expectedYieldState: {
              lastUpdateBalance: 3000n,
              accruedYield: 19872n,
              streamYield: 7461n
            }
          },
          {
            relativeTime: { day: 5n, hour: 6n },
            balanceChange: -1000n,
            expectedYieldState: {
              lastUpdateBalance: 2000n,
              accruedYield: 29620n,
              streamYield: 3262n
            }
          },
          {
            relativeTime: { day: 5n, hour: 12n },
            balanceChange: -1000n,
            expectedYieldState: {
              lastUpdateBalance: 1000n,
              accruedYield: 29620n,
              streamYield: 6424n
            }
          },
          {
            relativeTime: { day: 5n, hour: 18n },
            balanceChange: -1000n,
            expectedYieldState: {
              lastUpdateBalance: 0n,
              accruedYield: 29620n,
              streamYield: 9486n
            }
          }
        ];

        await executeBalanceActionsAndCheck(fixture, yieldRates, balanceActions);
      });

      it("A decreasing balance scenario with multiple yield rates and caps", async () => {
        const fixture = await setUpFixture(deployContracts);

        const adjustedBlockTime = await getNearestDayEndAdjustedTimestamp();

        // Yield rates to be added to the contract
        const yieldRates: YieldRate[] = [
          // 40% yield rate at day 0
          {
            effectiveDay: 0n,
            tiers: [
              { rate: RATE_40, cap: 100n },
              { rate: RATE_40, cap: 0n }
            ]
          },
          // 80% yield rate at day 3
          {
            effectiveDay: calculateEffectiveDay(adjustedBlockTime, 3n),
            tiers: [
              { rate: RATE_80, cap: 100n },
              { rate: RATE_80, cap: 0n }
            ]
          },
          // 40% yield rate at day 5
          {
            effectiveDay: calculateEffectiveDay(adjustedBlockTime, 5n),
            tiers: [
              { rate: RATE_40, cap: 100n },
              { rate: RATE_40, cap: 0n }
            ]
          }
        ];

        // Simulated action schedule
        const balanceActions: BalanceActionItem[] = [
          {
            relativeTime: { day: 0n, hour: 6n },
            balanceChange: 11000n,
            expectedYieldState: {
              lastUpdateBalance: 11000n,
              accruedYield: 0n,
              streamYield: 0n
            }
          },
          {
            relativeTime: { day: 0n, hour: 12n },
            balanceChange: -1000n,
            expectedYieldState: {
              lastUpdateBalance: 10000n,
              accruedYield: 0n,
              streamYield: 1100n
            }
          },
          {
            relativeTime: { day: 0n, hour: 18n },
            balanceChange: -1000n,
            expectedYieldState: {
              lastUpdateBalance: 9000n,
              accruedYield: 0n,
              streamYield: 2100n
            }
          },
          {
            relativeTime: { day: 1n, hour: 6n },
            balanceChange: -1000n,
            expectedYieldState: {
              lastUpdateBalance: 8000n,
              accruedYield: 3000n,
              streamYield: 1200n
            }
          },
          {
            relativeTime: { day: 1n, hour: 12n },
            balanceChange: -1000n,
            expectedYieldState: {
              lastUpdateBalance: 7000n,
              accruedYield: 3000n,
              streamYield: 2300n
            }
          },
          {
            relativeTime: { day: 1n, hour: 18n },
            balanceChange: -1000n,
            expectedYieldState: {
              lastUpdateBalance: 6000n,
              accruedYield: 3000n,
              streamYield: 3300n
            }
          },
          {
            relativeTime: { day: 4n, hour: 6n },
            balanceChange: -1000n,
            expectedYieldState: {
              lastUpdateBalance: 5000n,
              accruedYield: 36768n,
              streamYield: 4276n
            }
          },
          {
            relativeTime: { day: 4n, hour: 12n },
            balanceChange: -1000n,
            expectedYieldState: {
              lastUpdateBalance: 4000n,
              accruedYield: 36768n,
              streamYield: 8452n
            }
          },
          {
            relativeTime: { day: 4n, hour: 18n },
            balanceChange: -1000n,
            expectedYieldState: {
              lastUpdateBalance: 3000n,
              accruedYield: 36768n,
              streamYield: 12528n
            }
          },
          {
            relativeTime: { day: 5n, hour: 6n },
            balanceChange: -1000n,
            expectedYieldState: {
              lastUpdateBalance: 2000n,
              accruedYield: 53272n,
              streamYield: 5627n
            }
          },
          {
            relativeTime: { day: 5n, hour: 12n },
            balanceChange: -1000n,
            expectedYieldState: {
              lastUpdateBalance: 1000n,
              accruedYield: 53272n,
              streamYield: 11154n
            }
          },
          {
            relativeTime: { day: 5n, hour: 18n },
            balanceChange: -1000n,
            expectedYieldState: {
              lastUpdateBalance: 0n,
              accruedYield: 53272n,
              streamYield: 16581n
            }
          }
        ];
        // Run the action schedule and test the yield states
        await executeBalanceActionsAndCheck(fixture, yieldRates, balanceActions);
      });
    });
    describe("Is reverted if", async () => {
      it("It is called not by a token contract", async () => {
        const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
        const fromAddress = (ADDRESS_ZERO);
        const toAddress = user.address;
        const amount = 1n;

        await expect(
          connect(yieldStreamer, deployer).afterTokenTransfer(fromAddress, toAddress, amount)
        ).to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_HookCallerUnauthorized);

        await expect(
          connect(yieldStreamer, admin).afterTokenTransfer(fromAddress, toAddress, amount)
        ).to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_HookCallerUnauthorized);
      });
    });
  });
});
