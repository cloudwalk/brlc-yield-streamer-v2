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
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { checkEquality, maxUintForBits, setUpFixture } from "../test-utils/common";
import {
  AccruePreview,
  adjustTimestamp,
  ClaimPreview,
  DAY,
  defaultYieldState,
  ENABLE_YIELD_STATE_AUTO_INITIALIZATION,
  ERRORS,
  FEE_RATE,
  HOUR,
  MIN_CLAIM_AMOUNT,
  NEGATIVE_TIME_SHIFT,
  normalizeAccruePreview,
  normalizeClaimPreview,
  normalizeTimestamp,
  normalizeYieldRate,
  normalizeYieldResult,
  RATE_FACTOR,
  ROUND_FACTOR,
  roundDown,
  YieldRate,
  YieldState
} from "../test-utils/specific";

const EVENTS = {
  YieldStreamer_AccountInitialized: "YieldStreamer_AccountInitialized",
  YieldStreamer_FeeReceiverChanged: "YieldStreamer_FeeReceiverChanged",
  YieldStreamer_GroupAssigned: "YieldStreamer_GroupAssigned",
  YieldStreamer_GroupMapped: "YieldStreamer_GroupMapped",
  YieldStreamer_InitializedFlagSet: "YieldStreamer_InitializedFlagSet",
  YieldStreamer_SourceYieldStreamerChanged: "YieldStreamer_SourceYieldStreamerChanged",
  YieldStreamer_YieldAccrued: "YieldStreamer_YieldAccrued",
  YieldStreamer_YieldRateAdded: "YieldStreamer_YieldRateAdded",
  YieldStreamer_YieldRateUpdated: "YieldStreamer_YieldRateUpdated",
  YieldStreamer_YieldTransferred: "YieldStreamer_YieldTransferred",
  YieldStreamerV1Mock_BlocklistCalled: "YieldStreamerV1Mock_BlocklistCalled"
};

const ADDRESS_ZERO = ethers.ZeroAddress;
const DEFAULT_GROUP_ID = 0n;
const EFFECTIVE_DAY_ZERO = 0n;
const CAP_ZERO = 0n;
const RATE_ZERO = 0n;
const MAX_GROUP_ID = maxUintForBits(32);
const DEFAULT_SOURCE_GROUP_KEY = ethers.ZeroHash;
const STATE_FLAG_INITIALIZED = 1n;

const INITIAL_YIELD_STREAMER_BALANCE = 1_000_000_000n;
const RATE_40 = (RATE_FACTOR * 40n) / 100n; // 40%
const RATE_80 = (RATE_FACTOR * 80n) / 100n; // 80%
const RATE = RATE_FACTOR / 100n; // 1%

const OWNER_ROLE: string = ethers.id("OWNER_ROLE");
const ADMIN_ROLE: string = ethers.id("ADMIN_ROLE");
const PAUSER_ROLE: string = ethers.id("PAUSER_ROLE");

// The yield rates array for the default yield group
const YIELD_RATES1: YieldRate[] = [{
  effectiveDay: 0n,
  tiers: [{ rate: RATE, cap: 0n }]
}];

// The yield rates array for the max yield group
const YIELD_RATES2: YieldRate[] = [
  {
    tiers: [
      {
        rate: maxUintForBits(48),
        cap: maxUintForBits(64)
      },
      {
        rate: 0n,
        cap: 0n
      },
      {
        rate: 123456789n,
        cap: 987654321n
      }
    ],
    effectiveDay: 0n
  },
  {
    tiers: [
      {
        rate: maxUintForBits(48) - 1n,
        cap: maxUintForBits(64) - 1n
      },
      {
        rate: 0n + 1n,
        cap: 0n + 1n
      },
      {
        rate: 123456789n - 1n,
        cap: 987654321n + 1n
      }
    ],
    effectiveDay: 12345n
  },
  {
    tiers: [
      {
        rate: maxUintForBits(48) - 2n,
        cap: maxUintForBits(64) - 2n
      },
      {
        rate: 0n + 2n,
        cap: 0n + 2n
      },
      {
        rate: 123456789n - 2n,
        cap: 987654321n + 2n
      }
    ],
    effectiveDay: maxUintForBits(16)
  }
];

export interface YieldStreamerV1ClaimResult {
  nextClaimDay: bigint;
  nextClaimDebit: bigint;
  firstYieldDay: bigint;
  prevClaimDebit: bigint;
  primaryYield: bigint;
  streamYield: bigint;
  lastDayPartialYield: bigint;
  shortfall: bigint;
  fee: bigint;
  yield: bigint;
}

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

function getTierRates(yieldRate: YieldRate): bigint[] {
  return yieldRate.tiers.map(tier => tier.rate);
}

function getTierCaps(yieldRate: YieldRate): bigint[] {
  return yieldRate.tiers.map(tier => tier.cap);
}

async function getGroupsForAccounts(yieldStreamer: Contract, accounts: string[]): Promise<bigint[]> {
  const actualGroups: bigint[] = [];
  for (const account of accounts) {
    actualGroups.push(await yieldStreamer.getAccountGroup(account));
  }
  return actualGroups;
}

export const yieldStreamerV1ClaimResult: YieldStreamerV1ClaimResult = {
  nextClaimDay: 0n,
  nextClaimDebit: 0n,
  firstYieldDay: 0n,
  prevClaimDebit: 0n,
  primaryYield: 0n,
  streamYield: 0n,
  lastDayPartialYield: 0n,
  shortfall: 0n,
  fee: 0n,
  yield: 0n
};

describe("Contract 'YieldStreamer' regarding external functions", async () => {
  let yieldStreamerFactory: ContractFactory;
  let yieldStreamerV1MockFactory: ContractFactory;
  let tokenMockFactory: ContractFactory;

  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let feeReceiver: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let users: HardhatEthersSigner[];

  before(async () => {
    [deployer, admin, feeReceiver, stranger, ...users] = await ethers.getSigners();

    // Factories with an explicitly specified deployer account
    yieldStreamerFactory = await ethers.getContractFactory("YieldStreamerTestable");
    yieldStreamerFactory = yieldStreamerFactory.connect(deployer);
    yieldStreamerV1MockFactory = await ethers.getContractFactory("YieldStreamerV1Mock");
    yieldStreamerV1MockFactory = yieldStreamerV1MockFactory.connect(deployer);
    tokenMockFactory = await ethers.getContractFactory("ERC20TokenMock");
    tokenMockFactory = tokenMockFactory.connect(deployer);
  });

  async function getLatestBlockAdjustedTimestamp(): Promise<bigint> {
    return adjustTimestamp(await getLatestBlockTimestamp());
  }

  async function getNearestDayEndAdjustedTimestamp(): Promise<bigint> {
    const adjustedTimestamp = await getLatestBlockAdjustedTimestamp();
    let nearestDayEndAdjustedTimestamp = (adjustedTimestamp / DAY) * DAY + DAY - 1n;
    // If the current timestamp is too close to the day end then the next day end must be taken to have time for tests
    if (nearestDayEndAdjustedTimestamp - adjustedTimestamp <= 20 * 60) {
      nearestDayEndAdjustedTimestamp += DAY;
    }
    return nearestDayEndAdjustedTimestamp;
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

    await proveTx(tokenMock.setHook(getAddress(yieldStreamer)));

    // Set the initialized state for the user
    await yieldStreamer.setInitializedFlag(users[0].address, true);

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
        tx = tokenMock.mint(users[0].address, actionItem.balanceChange);
      } else {
        // Perform a withdrawal action
        tx = tokenMock.burn(users[0].address, -actionItem.balanceChange);
      }
      const txTimestamp = await getTxTimestamp(tx);

      // Fetch the actual yield state from the contract after the action
      const actualYieldState = await yieldStreamer.getYieldState(users[0].address);

      // Update the expected lastUpdateTimestamp with the adjusted block timestamp and set the correct flags
      const expectedYieldState: YieldState = {
        ...defaultYieldState,
        flags: STATE_FLAG_INITIALIZED,
        streamYield: actionItem.expectedYieldState.streamYield,
        accruedYield: actionItem.expectedYieldState.accruedYield,
        lastUpdateTimestamp: adjustTimestamp(txTimestamp),
        lastUpdateBalance: actionItem.expectedYieldState.lastUpdateBalance
      };

      // Assert that the actual yield state matches the expected state
      checkEquality(actualYieldState, expectedYieldState, index);
    }
  }

  function calculateStreamYield(
    yieldState: YieldState,
    dailyRate: bigint,
    timestamp: bigint
  ) {
    const dailyYieldWithRateFactor = (yieldState.lastUpdateBalance + yieldState.accruedYield) * dailyRate;
    return dailyYieldWithRateFactor * (timestamp - yieldState.lastUpdateTimestamp) / (DAY * RATE_FACTOR);
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
    await addYieldRates(yieldStreamer, YIELD_RATES1, DEFAULT_GROUP_ID);
    await addYieldRates(yieldStreamer, YIELD_RATES2, MAX_GROUP_ID);

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
      expect(await yieldStreamer.getAccountGroup(users[0].address)).to.equal(DEFAULT_GROUP_ID);
      checkEquality(await yieldStreamer.getYieldState(users[0].address), defaultYieldState);
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

    it("Is reverted if the underlying token address is zero", async () => {
      const wrongTokenAddress = (ADDRESS_ZERO);
      await expect(upgrades.deployProxy(yieldStreamerFactory, [wrongTokenAddress]))
        .to.be.revertedWithCustomError(yieldStreamerFactory, ERRORS.YieldStreamer_TokenAddressZero);
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

  describe("Function 'addYieldRate()'", async () => {
    const groupId = (MAX_GROUP_ID);
    it("Executes as expected", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // Add first yield rate with the zero effective day
      const tx1 = yieldStreamer.addYieldRate(
        groupId,
        YIELD_RATES2[0].effectiveDay,
        getTierRates(YIELD_RATES2[0]),
        getTierCaps(YIELD_RATES2[0])
      );

      await proveTx(tx1);
      const actualRates1: YieldRate[] = (await yieldStreamer.getGroupYieldRates(groupId)).map(normalizeYieldRate);
      const expectedRates1: YieldRate[] = [YIELD_RATES2[0]];
      expect(actualRates1).to.deep.equal(expectedRates1);
      await expect(tx1)
        .to.emit(yieldStreamer, EVENTS.YieldStreamer_YieldRateAdded)
        .withArgs(
          groupId,
          YIELD_RATES2[0].effectiveDay,
          getTierRates(YIELD_RATES2[0]),
          getTierCaps(YIELD_RATES2[0])
        );

      // Add second yield rate with a non-zero effective day
      const tx2 = yieldStreamer.addYieldRate(
        groupId,
        YIELD_RATES2[1].effectiveDay,
        getTierRates(YIELD_RATES2[1]),
        getTierCaps(YIELD_RATES2[1])
      );

      await proveTx(tx2);
      const actualRates2: YieldRate[] = (await yieldStreamer.getGroupYieldRates(groupId)).map(normalizeYieldRate);
      const expectedRates2: YieldRate[] = [YIELD_RATES2[0], YIELD_RATES2[1]];
      expect(actualRates2).to.deep.equal(expectedRates2);
      await expect(tx2)
        .to.emit(yieldStreamer, EVENTS.YieldStreamer_YieldRateAdded)
        .withArgs(
          groupId,
          YIELD_RATES2[1].effectiveDay,
          getTierRates(YIELD_RATES2[1]),
          getTierCaps(YIELD_RATES2[1])
        );
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      await expect(
        connect(yieldStreamer, stranger).addYieldRate(
          groupId,
          YIELD_RATES2[0].effectiveDay,
          getTierRates(YIELD_RATES2[0]),
          getTierCaps(YIELD_RATES2[0])
        )
      ).to.be.revertedWithCustomError(
        yieldStreamer,
        ERRORS.AccessControlUnauthorizedAccount
      ).withArgs(stranger.address, OWNER_ROLE);
    });

    // it("Is reverted if the provided tier rates and tier caps arrays are empty", async () => {
    //   const { yieldStreamer } = await setUpFixture(deployContracts);
    //   const emptyArray: bigint[] = [];
    //
    //   await expect(yieldStreamer.addYieldRate(groupId, 0n, emptyArray, emptyArray)).to.be.reverted;
    // });

    it("Is reverted if the provided tier rates and caps arrays have different lengths", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);
      const tierRates1 = [100n, 200n];
      const tierCaps1 = [300n];
      // const tierRates2 = [100n];
      // const tierCaps2 = [200n, 300n];

      await expect(yieldStreamer.addYieldRate(groupId, 0n, tierRates1, tierCaps1)).to.be.revertedWithPanic(0x32);
      // await expect(yieldStreamer.addYieldRate(groupId, 0n, tierRates2, tierCaps2)).to.be.revertedWithPanic(0x32);
    });

    it("Is reverted if the first added yield rate has a non-zero effective day", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);
      const nonZeroEffectiveDay = 1n;

      await expect(
        yieldStreamer.addYieldRate(
          groupId,
          nonZeroEffectiveDay,
          getTierRates(YIELD_RATES2[0]),
          getTierCaps(YIELD_RATES2[0])
        )
      ).revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_YieldRateInvalidEffectiveDay);
    });

    it("Is reverted if the new eff. day is not greater than the eff. day of the preceding rate object", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // Add initial yield rates to the group
      await addYieldRates(yieldStreamer, [YIELD_RATES2[0], YIELD_RATES2[1]], groupId);

      // Create new yield rate with same effective day as previous rate
      const newYieldRate: YieldRate = { ...YIELD_RATES2[2] };
      newYieldRate.effectiveDay = YIELD_RATES2[1].effectiveDay;

      // Attempt to add yield rate - should revert since effective day is not greater
      await expect(
        yieldStreamer.addYieldRate(
          groupId,
          newYieldRate.effectiveDay,
          getTierRates(newYieldRate),
          getTierCaps(newYieldRate)
        )
      ).revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_YieldRateInvalidEffectiveDay);
    });

    it("Is reverted if the provided effective day is greater than uint16 max value", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);
      const wrongEffectiveDay = maxUintForBits(16) + 1n;

      await proveTx(yieldStreamer.addYieldRate(
        groupId,
        EFFECTIVE_DAY_ZERO,
        getTierRates(YIELD_RATES2[0]),
        getTierCaps(YIELD_RATES2[0])
      ));

      await expect(
        yieldStreamer.addYieldRate(
          groupId,
          wrongEffectiveDay,
          getTierRates(YIELD_RATES2[0]),
          getTierCaps(YIELD_RATES2[0])
        )
      ).revertedWithCustomError(
        yieldStreamer,
        ERRORS.SafeCastOverflowedUintDowncast
      ).withArgs(16, wrongEffectiveDay);
    });

    it("Is reverted if the provided rate is greater than uint48 max value", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);
      const wrongRate = maxUintForBits(48) + 1n;

      await expect(
        yieldStreamer.addYieldRate(
          groupId,
          EFFECTIVE_DAY_ZERO,
          [wrongRate],
          [CAP_ZERO]
        )
      ).revertedWithCustomError(
        yieldStreamer,
        ERRORS.SafeCastOverflowedUintDowncast
      ).withArgs(48, wrongRate);
    });

    it("Is reverted if the provided cap is greater than uint64 max value", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);
      const wrongCap = maxUintForBits(64) + 1n;

      await expect(
        yieldStreamer.addYieldRate(
          groupId,
          EFFECTIVE_DAY_ZERO,
          [RATE_ZERO],
          [wrongCap]
        )
      ).revertedWithCustomError(
        yieldStreamer,
        ERRORS.SafeCastOverflowedUintDowncast
      ).withArgs(64, wrongCap);
    });
  });

  describe("Function 'updateYieldRate()'", async () => {
    const groupId = (MAX_GROUP_ID);

    async function executeAndCheck(initialYieldRates: YieldRate[], props: { groupId: bigint; itemIndex: number }) {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);

      // Set up test parameters
      const { groupId, itemIndex } = props;
      const yieldRateUpdated: YieldRate = { ...initialYieldRates[itemIndex] };
      yieldRateUpdated.tiers = [{ rate: 123456789n, cap: 987654321n }, { rate: 987654321n, cap: 0n }];
      if (initialYieldRates.length > 1 && itemIndex != 0) {
        yieldRateUpdated.effectiveDay =
          (YIELD_RATES2[itemIndex - 1].effectiveDay + YIELD_RATES2[itemIndex].effectiveDay) / 2n;
      }

      const tx = yieldStreamer.updateYieldRate(
        groupId,
        itemIndex,
        yieldRateUpdated.effectiveDay,
        getTierRates(yieldRateUpdated),
        getTierCaps(yieldRateUpdated)
      );
      await proveTx(tx);

      const actualRates: YieldRate[] = (await yieldStreamer.getGroupYieldRates(groupId)).map(normalizeYieldRate);
      const expectedRates: YieldRate[] = [...initialYieldRates];
      expectedRates[itemIndex] = yieldRateUpdated;
      expect(actualRates).to.deep.equal(expectedRates);

      expect(tx)
        .to.emit(yieldStreamer, EVENTS.YieldStreamer_YieldRateUpdated)
        .withArgs(
          groupId,
          itemIndex,
          yieldRateUpdated.effectiveDay,
          getTierRates(yieldRateUpdated),
          getTierCaps(yieldRateUpdated)
        );
    }

    describe("Executes as expected if there are several items in the yield rate array and", async () => {
      it("The item index to update is zero", async () => {
        expect(YIELD_RATES2.length).greaterThanOrEqual(3);
        await executeAndCheck(YIELD_RATES2, { groupId, itemIndex: 0 });
      });

      it("The item index to update is in the middle", async () => {
        expect(YIELD_RATES2.length).greaterThanOrEqual(3);
        await executeAndCheck(YIELD_RATES2, { groupId, itemIndex: 1 });
      });

      it("The item index to update is the last one", async () => {
        expect(YIELD_RATES2.length).greaterThanOrEqual(3);
        await executeAndCheck(YIELD_RATES2, { groupId, itemIndex: YIELD_RATES2.length - 1 });
      });
    });

    describe("Executes as expected if there is a single item in the yield rate array and", async () => {
      it("The item index to update is zero", async () => {
        expect(YIELD_RATES1.length).to.equal(1);
        await executeAndCheck(YIELD_RATES1, { groupId: DEFAULT_GROUP_ID, itemIndex: 0 });
      });
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const itemIndex = 1;

      await expect(
        connect(yieldStreamer, admin).updateYieldRate(
          groupId,
          itemIndex,
          YIELD_RATES2[itemIndex].effectiveDay,
          getTierRates(YIELD_RATES2[itemIndex]),
          getTierCaps(YIELD_RATES2[itemIndex])
        )
      ).to.be.revertedWithCustomError(
        yieldStreamer,
        ERRORS.AccessControlUnauthorizedAccount
      ).withArgs(admin.address, OWNER_ROLE);

      await expect(
        connect(yieldStreamer, stranger).updateYieldRate(
          groupId,
          itemIndex,
          YIELD_RATES2[itemIndex].effectiveDay,
          getTierRates(YIELD_RATES2[itemIndex]),
          getTierCaps(YIELD_RATES2[itemIndex])
        )
      ).to.be.revertedWithCustomError(
        yieldStreamer,
        ERRORS.AccessControlUnauthorizedAccount
      ).withArgs(stranger.address, OWNER_ROLE);
    });

    it("Is reverted if the being updated yield rate has index 0 but the effective day is non-zero", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const itemIndex = 0;
      const nonZeroEffectiveDay = 1n;

      await expect(
        yieldStreamer.updateYieldRate(
          groupId,
          itemIndex,
          nonZeroEffectiveDay,
          getTierRates(YIELD_RATES2[0]),
          getTierCaps(YIELD_RATES2[0])
        )
      ).revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_YieldRateInvalidEffectiveDay);
    });

    it("Is reverted if the yield rate array to update is empty", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const emptyGroupId = 123n;
      const itemIndex = 0;

      await expect(
        yieldStreamer.updateYieldRate(
          emptyGroupId,
          itemIndex,
          YIELD_RATES2[0].effectiveDay,
          getTierRates(YIELD_RATES2[0]),
          getTierCaps(YIELD_RATES2[0])
        )
      ).to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_YieldRateInvalidItemIndex);
    });

    it("Is reverted if the provided item index is greater than the length of the yield rates array", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const lastIndex = YIELD_RATES2.length - 1;
      const invalidItemIndex = lastIndex + 1;

      await expect(
        yieldStreamer.updateYieldRate(
          groupId,
          invalidItemIndex,
          YIELD_RATES2[lastIndex].effectiveDay,
          getTierRates(YIELD_RATES2[lastIndex]),
          getTierCaps(YIELD_RATES2[lastIndex])
        )
      ).revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_YieldRateInvalidItemIndex);
    });

    it("Is reverted if the provided tier rates and tier caps arrays are empty", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const emptyArray: bigint[] = [];
      const itemIndex = 1;

      await expect(yieldStreamer.updateYieldRate(groupId, itemIndex, 0n, emptyArray, emptyArray)).to.be.reverted;
    });

    it("Is reverted if the provided tier rates and caps arrays have different lengths", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const tierRates1 = [100n, 200n];
      const tierCaps1 = [300n];
      // const tierRates2 = [100n];
      // const tierCaps2 = [200n, 300n];
      const itemIndex = 1;

      await expect(
        yieldStreamer.updateYieldRate(
          groupId,
          itemIndex,
          YIELD_RATES2[itemIndex].effectiveDay,
          tierRates1,
          tierCaps1
        )
      ).to.be.reverted;
      // await expect(
      //   yieldStreamer.updateYieldRate(
      //     groupId,
      //     itemIndex,
      //     YIELD_RATES[itemIndex].effectiveDay,
      //     tierRates2,
      //     tierCaps2
      //   )
      // ).to.be.reverted;
    });

    it("Is reverted if the new eff. day is not greater than the eff. day of the preceding rate object", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const itemIndexes = [1, 2];

      for (const itemIndex of itemIndexes) {
        await expect(
          yieldStreamer.updateYieldRate(
            groupId,
            itemIndex,
            YIELD_RATES2[itemIndex - 1].effectiveDay,
            getTierRates(YIELD_RATES2[itemIndex]),
            getTierCaps(YIELD_RATES2[itemIndex])
          )
        ).to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_YieldRateInvalidEffectiveDay);
      }
    });

    it("Is reverted if the new eff. day is not less than the eff. day of the next rate object", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const itemIndexes = [0, 1];

      for (const itemIndex of itemIndexes) {
        await expect(
          yieldStreamer.updateYieldRate(
            groupId,
            itemIndex,
            YIELD_RATES2[itemIndex + 1].effectiveDay,
            getTierRates(YIELD_RATES2[itemIndex]),
            getTierCaps(YIELD_RATES2[itemIndex])
          )
        ).to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_YieldRateInvalidEffectiveDay);
      }
    });

    it("Is reverted if the new eff. day is greater than uint16 max value", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const itemIndex = YIELD_RATES2.length - 1;
      const wrongEffectiveDay = maxUintForBits(16) + 1n;

      await expect(
        yieldStreamer.updateYieldRate(
          groupId,
          itemIndex,
          wrongEffectiveDay,
          getTierRates(YIELD_RATES2[itemIndex]),
          getTierCaps(YIELD_RATES2[itemIndex])
        )
      ).revertedWithCustomError(
        yieldStreamer,
        ERRORS.SafeCastOverflowedUintDowncast
      ).withArgs(16, wrongEffectiveDay);
    });

    it("Is reverted if the new rate is greater than uint48 max value", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const itemIndex = YIELD_RATES2.length - 1;
      const wrongRate = maxUintForBits(48) + 1n;

      await expect(
        yieldStreamer.updateYieldRate(
          groupId,
          itemIndex,
          YIELD_RATES2[itemIndex].effectiveDay,
          [wrongRate],
          [CAP_ZERO]
        )
      ).revertedWithCustomError(
        yieldStreamer,
        ERRORS.SafeCastOverflowedUintDowncast
      ).withArgs(48, wrongRate);
    });

    it("Is reverted if the new cap is greater than uint64 max value", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const itemIndex = YIELD_RATES2.length - 1;
      const wrongCap = maxUintForBits(64) + 1n;

      await expect(
        yieldStreamer.updateYieldRate(
          groupId,
          itemIndex,
          YIELD_RATES2[itemIndex].effectiveDay,
          [RATE_ZERO],
          [wrongCap]
        )
      ).revertedWithCustomError(
        yieldStreamer,
        ERRORS.SafeCastOverflowedUintDowncast
      ).withArgs(64, wrongCap);
    });
  });

  describe("Function 'assignGroup()'", async () => {
    const groupId1 = 1n;
    const groupId2 = (MAX_GROUP_ID);
    describe("Executes as expected if", async () => {
      it("The provided account array is NOT empty", async () => {
        const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
        await addYieldRates(yieldStreamer, [{ effectiveDay: 0n, tiers: [{ rate: RATE_40, cap: 0n }] }], groupId1);

        // Assign one account to the group without yield accrual
        {
          const accounts = [users[0].address];
          const forceYieldAccrue = false;
          const tx = yieldStreamer.assignGroup(groupId1, accounts, forceYieldAccrue);
          await proveTx(tx);

          const actualGroups1 = await getGroupsForAccounts(yieldStreamer, accounts);
          expect(actualGroups1).to.deep.equal([groupId1]);

          await expect(tx)
            .to.emit(yieldStreamer, EVENTS.YieldStreamer_GroupAssigned)
            .withArgs(users[0].address, groupId1, DEFAULT_GROUP_ID);
          await expect(tx).not.to.emit(yieldStreamer, EVENTS.YieldStreamer_YieldAccrued);
        }

        // Assign two accounts to the new group with yield accrual
        {
          const accounts = [users[0].address, users[1].address];
          const forceYieldAccrue = true;

          const tx = yieldStreamer.assignGroup(groupId2, accounts, forceYieldAccrue);
          await proveTx(tx);

          const actualGroups2 = await getGroupsForAccounts(yieldStreamer, accounts);
          expect(actualGroups2).to.deep.equal([groupId2, groupId2]);

          await expect(tx)
            .to.emit(yieldStreamer, EVENTS.YieldStreamer_GroupAssigned)
            .withArgs(accounts[0], groupId2, groupId1);
          await expect(tx)
            .to.emit(yieldStreamer, EVENTS.YieldStreamer_GroupAssigned)
            .withArgs(accounts[1], groupId2, DEFAULT_GROUP_ID);
          await expect(tx)
            .to.emit(yieldStreamer, EVENTS.YieldStreamer_YieldAccrued)
            .withArgs(accounts[0], anyValue, anyValue, anyValue, anyValue);
          await expect(tx)
            .to.emit(yieldStreamer, EVENTS.YieldStreamer_YieldAccrued)
            .withArgs(accounts[1], anyValue, anyValue, anyValue, anyValue);
        }
      });
      it("The provided account array is empty", async () => {
        const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
        await expect(yieldStreamer.assignGroup(groupId2, [], false)).not.to.be.reverted;
      });
    });

    describe("Is reverted if", async () => {
      it("The caller does not have the owner role", async () => {
        const { yieldStreamer } = await setUpFixture(deployContracts);
        const accounts = [users[0].address];
        const forceYieldAccrue = false;

        await expect(connect(yieldStreamer, admin).assignGroup(MAX_GROUP_ID, accounts, forceYieldAccrue))
          .to.be.revertedWithCustomError(yieldStreamer, ERRORS.AccessControlUnauthorizedAccount)
          .withArgs(admin.address, OWNER_ROLE);
        await expect(connect(yieldStreamer, stranger).assignGroup(MAX_GROUP_ID, accounts, forceYieldAccrue))
          .to.be.revertedWithCustomError(yieldStreamer, ERRORS.AccessControlUnauthorizedAccount)
          .withArgs(stranger.address, OWNER_ROLE);
      });

      it("The group is already assigned", async () => {
        const { yieldStreamer } = await setUpFixture(deployContracts);
        const accounts = [users[0].address];
        const forceYieldAccrue = false;

        await expect(
          yieldStreamer.assignGroup(DEFAULT_GROUP_ID, accounts, forceYieldAccrue)
        ).to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_GroupAlreadyAssigned);

        await proveTx(yieldStreamer.assignGroup(MAX_GROUP_ID, accounts, forceYieldAccrue));

        await expect(
          yieldStreamer.assignGroup(MAX_GROUP_ID, accounts, forceYieldAccrue)
        ).to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_GroupAlreadyAssigned);
      });
    });
  });

  describe("Function 'setFeeReceiver()'", async () => {
    it("Executes as expected", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // Initial fee receiver setup
      await expect(yieldStreamer.setFeeReceiver(feeReceiver.address))
        .to.emit(yieldStreamer, EVENTS.YieldStreamer_FeeReceiverChanged)
        .withArgs(feeReceiver.address, ADDRESS_ZERO);

      expect(await yieldStreamer.feeReceiver()).to.equal(feeReceiver.address);

      // Fee receiver reset
      await expect(yieldStreamer.setFeeReceiver(ADDRESS_ZERO))
        .to.emit(yieldStreamer, EVENTS.YieldStreamer_FeeReceiverChanged)
        .withArgs(ADDRESS_ZERO, feeReceiver.address);

      expect(await yieldStreamer.feeReceiver()).to.equal(ADDRESS_ZERO);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      await expect(connect(yieldStreamer, stranger).setFeeReceiver(feeReceiver.address))
        .to.be.revertedWithCustomError(yieldStreamer, ERRORS.AccessControlUnauthorizedAccount)
        .withArgs(stranger.address, OWNER_ROLE);
    });

    it("Is reverted if provided receiver is the same as the current one", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // Set the receiver to zero
      await expect(yieldStreamer.setFeeReceiver(ADDRESS_ZERO))
        .to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_FeeReceiverAlreadyConfigured);

      // Set the receiver to the non-zero address
      await proveTx(yieldStreamer.setFeeReceiver(feeReceiver.address));

      // Try to set the receiver to the same non-zero address
      await expect(yieldStreamer.setFeeReceiver(feeReceiver.address))
        .to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_FeeReceiverAlreadyConfigured);
    });
  });

  describe("Function 'setSourceYieldStreamer()'", async () => {
    const sourceYieldStreamerAddressStub = "0x0000000000000000000000000000000000000001";

    it("Executes as expected", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // Can be set to non-zero
      await expect(yieldStreamer.setSourceYieldStreamer(sourceYieldStreamerAddressStub))
        .to.emit(yieldStreamer, EVENTS.YieldStreamer_SourceYieldStreamerChanged)
        .withArgs(ADDRESS_ZERO, sourceYieldStreamerAddressStub);

      expect(await yieldStreamer.sourceYieldStreamer()).to.equal(sourceYieldStreamerAddressStub);

      // Can be set to zero
      await expect(yieldStreamer.setSourceYieldStreamer(ADDRESS_ZERO))
        .to.emit(yieldStreamer, EVENTS.YieldStreamer_SourceYieldStreamerChanged)
        .withArgs(sourceYieldStreamerAddressStub, ADDRESS_ZERO);

      expect(await yieldStreamer.sourceYieldStreamer()).to.equal(ADDRESS_ZERO);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      await expect(connect(yieldStreamer, stranger).setSourceYieldStreamer(sourceYieldStreamerAddressStub))
        .to.be.revertedWithCustomError(yieldStreamer, ERRORS.AccessControlUnauthorizedAccount)
        .withArgs(stranger.address, OWNER_ROLE);
    });

    it("Is reverted if the new source yield streamer is the same", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // Check for the zero initial address
      await expect(yieldStreamer.setSourceYieldStreamer(ADDRESS_ZERO))
        .to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_SourceYieldStreamerAlreadyConfigured);

      // Check for a non-zero initial address
      await proveTx(yieldStreamer.setSourceYieldStreamer(sourceYieldStreamerAddressStub));
      await expect(yieldStreamer.setSourceYieldStreamer(sourceYieldStreamerAddressStub))
        .to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_SourceYieldStreamerAlreadyConfigured);
    });
  });

  describe("Function 'mapSourceYieldStreamerGroup()'", async () => {
    async function executeAndCheck(
      yieldStreamer: Contract,
      props: { groupKey: string; newGroupId: bigint; oldGroupId: bigint }
    ) {
      const { groupKey, newGroupId, oldGroupId } = props;
      await expect(yieldStreamer.mapSourceYieldStreamerGroup(groupKey, newGroupId))
        .to.emit(yieldStreamer, EVENTS.YieldStreamer_GroupMapped)
        .withArgs(groupKey, newGroupId, oldGroupId);
      // Call via the testable version
      expect(await yieldStreamer.getSourceGroupMapping(groupKey)).to.equal(newGroupId);
    }

    it("Executes as expected", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // The zero group key can be mapped to a non-zero group ID
      await executeAndCheck(
        yieldStreamer,
        { groupKey: DEFAULT_SOURCE_GROUP_KEY, newGroupId: MAX_GROUP_ID, oldGroupId: DEFAULT_GROUP_ID }
      );

      // The zero group key can be mapped to the zero group ID
      await executeAndCheck(
        yieldStreamer,
        { groupKey: DEFAULT_SOURCE_GROUP_KEY, newGroupId: DEFAULT_GROUP_ID, oldGroupId: MAX_GROUP_ID }
      );

      // The non-zero group key can be mapped to the non-zero group IDs
      await executeAndCheck(
        yieldStreamer,
        {
          groupKey: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          newGroupId: MAX_GROUP_ID,
          oldGroupId: DEFAULT_GROUP_ID
        }
      );
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);
      const groupKey = (DEFAULT_SOURCE_GROUP_KEY);

      await expect(connect(yieldStreamer, stranger).mapSourceYieldStreamerGroup(groupKey, MAX_GROUP_ID))
        .to.be.revertedWithCustomError(yieldStreamer, ERRORS.AccessControlUnauthorizedAccount)
        .withArgs(stranger.address, OWNER_ROLE);
    });

    it("Is reverted if source yield streamer group already mapped", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);
      const groupKey = (DEFAULT_SOURCE_GROUP_KEY);

      // Check for the zero initial group ID
      await expect(
        yieldStreamer.mapSourceYieldStreamerGroup(groupKey, DEFAULT_GROUP_ID)
      ).to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_SourceYieldStreamerGroupAlreadyMapped);

      // Check for a non-zero initial group ID
      await proveTx(yieldStreamer.mapSourceYieldStreamerGroup(groupKey, MAX_GROUP_ID));
      await expect(yieldStreamer.mapSourceYieldStreamerGroup(groupKey, MAX_GROUP_ID))
        .to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_SourceYieldStreamerGroupAlreadyMapped);
    });
  });

  describe("Function 'setInitializedFlag()'", async () => {
    async function executeAndCheck(
      yieldStreamer: Contract,
      props: { newFlagState: boolean; oldFlagState: boolean }
    ) {
      const { newFlagState, oldFlagState } = props;
      const userAddress = users[0].address;

      const tx = yieldStreamer.setInitializedFlag(userAddress, newFlagState);
      await proveTx(tx);

      const expectedYieldState: YieldState = { ...defaultYieldState };
      if (newFlagState) {
        expectedYieldState.flags = 1n;
      }
      const actualYieldState = await yieldStreamer.getYieldState(userAddress);
      checkEquality(actualYieldState, expectedYieldState);

      if (newFlagState !== oldFlagState) {
        await expect(tx)
          .to.emit(yieldStreamer, EVENTS.YieldStreamer_InitializedFlagSet)
          .withArgs(userAddress, newFlagState);
      } else {
        await expect(tx).not.to.emit(yieldStreamer, EVENTS.YieldStreamer_InitializedFlagSet);
      }
    }

    it("Executes as expected in different cases", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      checkEquality(await yieldStreamer.getYieldState(users[0].address), defaultYieldState);

      // Check change: 0 => 1
      await executeAndCheck(yieldStreamer, { newFlagState: true, oldFlagState: false });

      // Check change: 1 => 1
      await executeAndCheck(yieldStreamer, { newFlagState: true, oldFlagState: true });

      // Check change: 1 => 0
      await executeAndCheck(yieldStreamer, { newFlagState: false, oldFlagState: true });

      // Check change: 0 => 0
      await executeAndCheck(yieldStreamer, { newFlagState: false, oldFlagState: false });
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      await expect(connect(yieldStreamer, stranger).setInitializedFlag(users[0].address, true))
        .to.be.revertedWithCustomError(yieldStreamer, ERRORS.AccessControlUnauthorizedAccount)
        .withArgs(stranger.address, OWNER_ROLE);
    });
  });

  describe("Function 'initializeAccounts()'", async () => {
    it("Executes as expected", async () => {
      const { yieldStreamer, yieldStreamerV1Mock, tokenMock } = await setUpFixture(deployAndConfigureContracts);
      const accounts = [users[0].address, users[1].address, users[2].address];
      const balances = [maxUintForBits(64), 1n, 123n];
      const groupKey = (DEFAULT_SOURCE_GROUP_KEY);
      const groupId = 123456789;
      const claimPreviewResults: YieldStreamerV1ClaimResult[] = [
        { ...yieldStreamerV1ClaimResult, primaryYield: maxUintForBits(64) - 1n, lastDayPartialYield: 1n },
        { ...yieldStreamerV1ClaimResult, primaryYield: 1n, lastDayPartialYield: 2n },
        { ...yieldStreamerV1ClaimResult }
      ];

      await proveTx(yieldStreamer.mapSourceYieldStreamerGroup(groupKey, groupId));
      for (let i = 0; i < accounts.length; ++i) {
        const actualYieldState = await yieldStreamer.getYieldState(accounts[i]);
        checkEquality(actualYieldState, defaultYieldState, i);
        await proveTx(yieldStreamerV1Mock.setClaimAllPreview(accounts[i], claimPreviewResults[i]));
        await proveTx(tokenMock.mint(accounts[i], balances[i]));
      }

      const tx = yieldStreamer.initializeAccounts(accounts);
      const expectedBlockTimestamp = adjustTimestamp(await getTxTimestamp(tx));

      const expectedYieldStates: YieldState[] = claimPreviewResults.map((res, i) => ({
        flags: 1n,
        streamYield: 0n,
        accruedYield: res.primaryYield + res.lastDayPartialYield,
        lastUpdateTimestamp: expectedBlockTimestamp,
        lastUpdateBalance: balances[i]
      }));

      for (let i = 0; i < accounts.length; ++i) {
        const account = accounts[i];
        const actualYieldState = await yieldStreamer.getYieldState(account);
        checkEquality(actualYieldState, expectedYieldStates[i], i);
        await expect(tx)
          .to.emit(yieldStreamer, EVENTS.YieldStreamer_AccountInitialized)
          .withArgs(
            account,
            groupId,
            balances[i],
            expectedYieldStates[i].accruedYield,
            0 // streamYield
          );
        await expect(tx)
          .to.emit(yieldStreamerV1Mock, EVENTS.YieldStreamerV1Mock_BlocklistCalled)
          .withArgs(accounts[i]);
      }
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);

      await expect(connect(yieldStreamer, stranger).initializeAccounts([users[0].address]))
        .to.be.revertedWithCustomError(yieldStreamer, ERRORS.AccessControlUnauthorizedAccount)
        .withArgs(stranger.address, OWNER_ROLE);
    });

    it("Is reverted if accounts array is empty", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);

      await expect(yieldStreamer.initializeAccounts([]))
        .to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_EmptyArray);
    });

    it("Is reverted if the yield streamer source is not configured", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      await proveTx(yieldStreamer.setSourceYieldStreamer(ADDRESS_ZERO));

      await expect(yieldStreamer.initializeAccounts([users[0].address]))
        .to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_SourceYieldStreamerNotConfigured);
    });

    it("Is reverted if the contract does not have the blocklister role in the source yield streamer", async () => {
      const { yieldStreamer, yieldStreamerV1Mock } = await setUpFixture(deployAndConfigureContracts);
      await proveTx(yieldStreamerV1Mock.setBlocklister(getAddress(yieldStreamer), false));

      await expect(yieldStreamer.initializeAccounts([users[0].address]))
        .to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_SourceYieldStreamerUnauthorizedBlocklister);
    });

    it("Is reverted if an account is already initialized", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const accounts = [users[0].address, users[0].address];
      await proveTx(await yieldStreamer.initializeAccounts([accounts[1]]));

      await expect(yieldStreamer.initializeAccounts(accounts))
        .to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_AccountAlreadyInitialized);
    });

    it("Is reverted if one of provided account addresses is zero", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const accounts = [users[0].address, ADDRESS_ZERO];

      await expect(yieldStreamer.initializeAccounts(accounts))
        .to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_AccountInitializationProhibited);
    });
  });

  describe("Function 'afterTokenTransfer()'", async () => {
    describe("Executes as expected in the case of scenario with multiple balance changes when", async () => {
      it("The balance mainly increases and there is a single yield rate and a cap", async () => {
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

      it("The balance mainly increases and there are multiple yield rates and caps", async () => {
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

      it("The balance mainly decreases and there is a single yield rate and a cap", async () => {
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

      it("The balance mainly decreases and there are multiple yield rates and caps", async () => {
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

    describe("Executes as expected when the account is not initialized and", async () => {
      async function executeAndCheck(props: { balanceChange: bigint }) {
        const { yieldStreamer, tokenMock } = await setUpFixture(deployAndConfigureContracts);
        const startDayTimestamp = await getNearestDayEndAdjustedTimestamp() + 1n;
        const accountAddress = users[0].address;
        const expectedYieldState: YieldState = {
          ...defaultYieldState,
          flags: 0n,
          accruedYield: 1234567n,
          lastUpdateTimestamp: startDayTimestamp,
          lastUpdateBalance: 987654321n
        };
        // Call via the testable version
        await proveTx(yieldStreamer.setYieldState(accountAddress, expectedYieldState));
        await proveTx(tokenMock.mint(accountAddress, expectedYieldState.lastUpdateBalance));
        await proveTx(tokenMock.setHook(getAddress(yieldStreamer)));
        await increaseBlockTimestampTo(normalizeTimestamp(startDayTimestamp + 3n * HOUR));

        let tx: Promise<TransactionResponse>;
        if (props.balanceChange >= 0) {
          tx = tokenMock.mint(accountAddress, props.balanceChange);
        } else {
          tx = tokenMock.burn(accountAddress, -props.balanceChange);
        }

        await expect(tx).not.to.emit(yieldStreamer, EVENTS.YieldStreamer_AccountInitialized);
        await expect(tx).not.to.emit(yieldStreamer, EVENTS.YieldStreamer_YieldAccrued);
      }

      it("The balance increases", async () => {
        await executeAndCheck({ balanceChange: 123n });
      });

      it("The balance increases", async () => {
        await executeAndCheck({ balanceChange: -123n });
      });
    });

    describe("Is reverted if", async () => {
      it("It is called not by a token contract", async () => {
        const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
        const fromAddress = (ADDRESS_ZERO);
        const toAddress = users[0].address;
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

  describe("Function 'beforeTokenTransfer()", async () => {
    it("Executes by any account without any consequences", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);
      const from = (ADDRESS_ZERO);
      const to = (users[0].address);
      const amount = 123456n;
      await expect(connect(yieldStreamer, stranger).beforeTokenTransfer(from, to, amount)).not.to.be.reverted;
    });
  });

  describe("Function 'claimAmountFor()'", async () => {
    // Should handle claims for accounts with zero yielded balance gracefully by reverting appropriately.
    // Should correctly handle claims immediately after yield accrual without delays.
    // Should revert if the _accrueYield function fails during the claim process.
    async function executeAndCheck(props: {
      startDayBalance: bigint;
      accruedYield: bigint;
      claimAmount: bigint;
      relativeClaimTimestamp: bigint;
    }) {
      const { yieldStreamerUnderAdmin, tokenMock } = await setUpFixture(deployAndConfigureContracts);
      const startDayTimestamp = await getNearestDayEndAdjustedTimestamp() + 1n;

      // Set the yield state for the user with claimable yield
      const account = users[0];
      const claimAmount = props.claimAmount;
      const expectedYieldState: YieldState = {
        ...defaultYieldState,
        flags: STATE_FLAG_INITIALIZED,
        streamYield: 0n,
        accruedYield: props.accruedYield,
        lastUpdateTimestamp: startDayTimestamp,
        lastUpdateBalance: props.startDayBalance
      };
      // Compute expected fee and net amount
      const fee = (claimAmount * FEE_RATE) / ROUND_FACTOR;
      const netAmount = claimAmount - fee;

      await proveTx(
        yieldStreamerUnderAdmin.setYieldState(account.address, expectedYieldState) // Call via the testable version
      );
      await tokenMock.setHook(getAddress(yieldStreamerUnderAdmin));
      await increaseBlockTimestampTo(normalizeTimestamp(startDayTimestamp + props.relativeClaimTimestamp));

      // Execute yield claim
      const tx = await yieldStreamerUnderAdmin.claimAmountFor(account.address, claimAmount);
      const expectedTimestamp = adjustTimestamp(await getTxTimestamp(tx));

      // Check that the yield state for the user is reset (accrued yield becomes 0)
      const updatedYieldState = await yieldStreamerUnderAdmin.getYieldState(account.address);
      expectedYieldState.streamYield = calculateStreamYield(expectedYieldState, RATE, expectedTimestamp);
      if (claimAmount > expectedYieldState.accruedYield) {
        expectedYieldState.streamYield -= claimAmount - expectedYieldState.accruedYield;
        expectedYieldState.accruedYield = 0n;
      } else {
        expectedYieldState.accruedYield -= claimAmount;
      }
      expectedYieldState.lastUpdateBalance += claimAmount;
      expectedYieldState.lastUpdateTimestamp = expectedTimestamp;
      checkEquality(updatedYieldState, expectedYieldState);

      // Check balance changes
      await expect(tx).to.changeTokenBalances(
        tokenMock,
        [yieldStreamerUnderAdmin, feeReceiver, account],
        [-claimAmount, fee, netAmount]
      );

      // Check that the expected event was emitted
      await expect(tx)
        .to.emit(yieldStreamerUnderAdmin, EVENTS.YieldStreamer_YieldTransferred)
        .withArgs(users[0].address, netAmount, fee);
    }

    describe("Executes as expected if the last yield state change was exactly at the day start and", async () => {
      it("The claim amount is less than the accrued yield", async () => {
        await executeAndCheck({
          startDayBalance: MIN_CLAIM_AMOUNT * 1000n,
          accruedYield: MIN_CLAIM_AMOUNT * 100n,
          claimAmount: MIN_CLAIM_AMOUNT * 10n,
          relativeClaimTimestamp: 3n * HOUR
        });
      });

      it("There is only the accrued yield non-zero and it matches the min claim amount", async () => {
        await executeAndCheck({
          startDayBalance: 0n,
          accruedYield: MIN_CLAIM_AMOUNT,
          claimAmount: MIN_CLAIM_AMOUNT,
          relativeClaimTimestamp: 0n
        });
      });

      it("The claim amount is greater than the accrued yield", async () => {
        const accruedYield = MIN_CLAIM_AMOUNT * 100n;
        await executeAndCheck({
          startDayBalance: 0n,
          accruedYield,
          claimAmount: accruedYield + accruedYield * RATE * 12n / (RATE_FACTOR * 24n),
          relativeClaimTimestamp: 18n * HOUR
        });
      });

      it("The claim amount almost equals to the accrued yield and stream yield", async () => {
        const accruedYield = MIN_CLAIM_AMOUNT * 100n;
        await executeAndCheck({
          startDayBalance: 0n,
          accruedYield,
          claimAmount: accruedYield + accruedYield * RATE * 12n / (RATE_FACTOR * 24n),
          relativeClaimTimestamp: 12n * HOUR
        });
      });
    });

    it("Is reverted if the caller does not have the admin role", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);

      await expect(connect(yieldStreamer, deployer).claimAmountFor(users[0].address, 0))
        .to.be.revertedWithCustomError(yieldStreamer, ERRORS.AccessControlUnauthorizedAccount)
        .withArgs(deployer.address, ADMIN_ROLE);
      await expect(connect(yieldStreamer, stranger).claimAmountFor(users[0].address, 0))
        .to.be.revertedWithCustomError(yieldStreamer, ERRORS.AccessControlUnauthorizedAccount)
        .withArgs(stranger.address, ADMIN_ROLE);
    });

    it("Is reverted if the amount is less than the minimum claim amount", async () => {
      const { yieldStreamerUnderAdmin } = await setUpFixture(deployAndConfigureContracts);
      const claimAmount = MIN_CLAIM_AMOUNT - 1n;

      await expect(
        yieldStreamerUnderAdmin.claimAmountFor(users[0].address, claimAmount)
      ).to.be.revertedWithCustomError(yieldStreamerUnderAdmin, ERRORS.YieldStreamer_ClaimAmountBelowMinimum);
    });

    it("Is reverted is the amount is not rounded down to the required precision", async () => {
      const { yieldStreamerUnderAdmin } = await setUpFixture(deployAndConfigureContracts);
      const claimAmount = MIN_CLAIM_AMOUNT + 1n;

      await expect(
        yieldStreamerUnderAdmin.claimAmountFor(users[0].address, claimAmount)
      ).to.be.revertedWithCustomError(yieldStreamerUnderAdmin, ERRORS.YieldStreamer_ClaimAmountNonRounded);
    });

    it("Is reverted if the account is not initialized", async () => {
      const { yieldStreamerUnderAdmin } = await setUpFixture(deployAndConfigureContracts);

      await expect(
        yieldStreamerUnderAdmin.claimAmountFor(users[0].address, MIN_CLAIM_AMOUNT)
      ).to.be.revertedWithCustomError(yieldStreamerUnderAdmin, ERRORS.YieldStreamer_AccountNotInitialized);
    });

    it("Is reverted if the claim amount exceeds the total available yield for the account", async () => {
      const { yieldStreamerUnderAdmin } = await setUpFixture(deployAndConfigureContracts);
      const yieldState: YieldState = {
        ...defaultYieldState,
        flags: STATE_FLAG_INITIALIZED,
        accruedYield: MIN_CLAIM_AMOUNT,
        lastUpdateTimestamp: await getLatestBlockAdjustedTimestamp()
      };
      // Call via the testable version
      await proveTx(yieldStreamerUnderAdmin.setYieldState(users[0].address, yieldState));

      await expect(
        yieldStreamerUnderAdmin.claimAmountFor(users[0].address, yieldState.accruedYield + ROUND_FACTOR)
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
      // Call via the testable version
      await proveTx(yieldStreamerUnderAdmin.setYieldState(users[0].address, yieldState));
      await proveTx(
        tokenMock.burn(getAddress(yieldStreamerUnderAdmin), INITIAL_YIELD_STREAMER_BALANCE - MIN_CLAIM_AMOUNT + 1n)
      );

      await expect(
        yieldStreamerUnderAdmin.claimAmountFor(users[0].address, MIN_CLAIM_AMOUNT)
      ).to.be.revertedWithCustomError(tokenMock, ERRORS.ERC20InsufficientBalance);
    });
  });

  describe("Function 'getAccruePreview()'", async () => {
    async function executeAndCheck(expectedYieldState: YieldState) {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      await proveTx(yieldStreamer.setYieldState(users[0].address, expectedYieldState)); // Call via the testable version

      let timestamp = expectedYieldState.lastUpdateTimestamp + 3n * HOUR;
      await increaseBlockTimestampTo(normalizeTimestamp(timestamp));
      const actualAccruePreviewRaw = await yieldStreamer.getAccruePreview(users[0].address);
      timestamp = await getLatestBlockAdjustedTimestamp();

      const additionalYield = calculateStreamYield(expectedYieldState, RATE, timestamp);
      const streamYieldAfter = expectedYieldState.streamYield + additionalYield;
      const yieldBase = expectedYieldState.accruedYield + expectedYieldState.lastUpdateBalance;
      const expectedAccruePreview: AccruePreview = {
        fromTimestamp: expectedYieldState.lastUpdateTimestamp,
        toTimestamp: timestamp,
        balance: expectedYieldState.lastUpdateBalance,
        streamYieldBefore: expectedYieldState.streamYield,
        accruedYieldBefore: expectedYieldState.accruedYield,
        streamYieldAfter: streamYieldAfter,
        accruedYieldAfter: expectedYieldState.accruedYield,
        rates: [{ tiers: [{ rate: RATE, cap: 0n }], effectiveDay: 0n }],
        results: [{
          partialFirstDayYield: 0n,
          fullDaysYield: 0n,
          partialLastDayYield: streamYieldAfter,
          partialFirstDayYieldTiered: yieldBase === 0n ? [] : [0n],
          fullDaysYieldTiered: yieldBase === 0n ? [] : [0n],
          partialLastDayYieldTiered: yieldBase === 0n ? [] : [additionalYield]
        }]
      };

      checkEquality(actualAccruePreviewRaw, expectedAccruePreview, undefined, { ignoreObjects: true });
      expect(actualAccruePreviewRaw.results.length).to.equal(expectedAccruePreview.results.length);
      for (let i = 0; i < expectedAccruePreview.results.length; ++i) {
        const expectedResult = expectedAccruePreview.results[i];
        const actualResult = actualAccruePreviewRaw.results[i];
        checkEquality(actualResult, expectedResult, i, { ignoreObjects: true });
        expect(normalizeYieldResult(actualResult)).to.deep.equal(expectedResult);
      }
      const actualAccruePreview = normalizeAccruePreview(await yieldStreamer.getAccruePreview(users[0].address));
      expect(actualAccruePreview).to.deep.equal(expectedAccruePreview);
    }

    it("Executes as expected for an initialised account in a simple case", async () => {
      const startDayTimestamp = await getNearestDayEndAdjustedTimestamp() + 1n;
      const startTimestamp = startDayTimestamp + 3n * HOUR;

      const yieldState: YieldState = {
        ...defaultYieldState,
        flags: STATE_FLAG_INITIALIZED,
        streamYield: MIN_CLAIM_AMOUNT / 2n,
        accruedYield: MIN_CLAIM_AMOUNT * 10n,
        lastUpdateTimestamp: startTimestamp,
        lastUpdateBalance: MIN_CLAIM_AMOUNT * 100n
      };

      await executeAndCheck(yieldState);
    });

    it("Executes as expected for a uninitialised account", async () => {
      const startDayTimestamp = await getNearestDayEndAdjustedTimestamp() + 1n;
      const startTimestamp = startDayTimestamp + 3n * HOUR;

      const yieldState: YieldState = { ...defaultYieldState, lastUpdateTimestamp: startTimestamp };

      await executeAndCheck(yieldState);
    });

    it("Is reverted if the account is in a group with non-configured rates", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const groupId = 123456;
      await proveTx(yieldStreamer.assignGroup(groupId, [users[0].address], false));

      await expect(yieldStreamer.getAccruePreview(users[0].address))
        .to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_YieldRateArrayIsEmpty);
    });

    // Other test cases are covered in tests for the internal "_getAccruePreview()" function
  });

  describe("Function 'getClaimPreview()'", async () => {
    async function executeAndCheck(expectedYieldState: YieldState) {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      await proveTx(yieldStreamer.setYieldState(users[0].address, expectedYieldState)); // Call via the testable version

      let timestamp = expectedYieldState.lastUpdateTimestamp + 6n * HOUR;
      await increaseBlockTimestampTo(normalizeTimestamp(timestamp));
      timestamp = await getLatestBlockAdjustedTimestamp();
      const actualClaimPreviewRaw = await yieldStreamer.getClaimPreview(users[0].address);

      const additionalYield = calculateStreamYield(expectedYieldState, RATE, timestamp);
      const totalStreamYield = expectedYieldState.streamYield + additionalYield;
      const totalClaimableYield = expectedYieldState.accruedYield + totalStreamYield;

      const expectedClaimPreview: ClaimPreview = {
        yieldExact: totalClaimableYield,
        yieldRounded: roundDown(totalClaimableYield),
        feeExact: 0n,
        feeRounded: 0n,
        timestamp,
        balance: expectedYieldState.lastUpdateBalance,
        rates: [RATE],
        caps: [0n]
      };

      checkEquality(actualClaimPreviewRaw, expectedClaimPreview, undefined, { ignoreObjects: true });
      const actualClaimPreview = normalizeClaimPreview(await yieldStreamer.getClaimPreview(users[0].address));
      expect(actualClaimPreview).to.deep.equal(expectedClaimPreview);
    }

    it("Executes as expected for an initialised account in a simple case", async () => {
      const startDayTimestamp = await getNearestDayEndAdjustedTimestamp() + 1n;
      const startTimestamp = startDayTimestamp + 4n * HOUR;

      const yieldState: YieldState = {
        ...defaultYieldState,
        flags: STATE_FLAG_INITIALIZED,
        streamYield: MIN_CLAIM_AMOUNT / 3n,
        accruedYield: MIN_CLAIM_AMOUNT * 10n,
        lastUpdateTimestamp: startTimestamp,
        lastUpdateBalance: MIN_CLAIM_AMOUNT * 100n
      };

      await executeAndCheck(yieldState);
    });

    it("Executes as expected for a uninitialised account", async () => {
      const startDayTimestamp = await getNearestDayEndAdjustedTimestamp() + 1n;
      const startTimestamp = startDayTimestamp + 4n * HOUR;

      const yieldState: YieldState = { ...defaultYieldState, lastUpdateTimestamp: startTimestamp };

      await executeAndCheck(yieldState);
    });

    it("Is reverted if the account is in a group with non-configured rates", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const groupId = 123456;
      await proveTx(yieldStreamer.assignGroup(groupId, [users[0].address], false));

      await expect(yieldStreamer.getClaimPreview(users[0].address))
        .to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_YieldRateArrayIsEmpty);
    });

    // Other test cases are covered in tests for the internal "_getClaimPreview()" function
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
});
