import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { Contract, ContractFactory } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { connect, getAddress, getBlockTimestamp, proveTx } from "../test-utils/eth";
import { maxUintForBits, setUpFixture } from "../test-utils/common";

const HOUR = 60 * 60; // Number of seconds in an hour
const NEGATIVE_TIME_SHIFT = 3 * HOUR; // Negative time shift in seconds (3 hours)
const ZERO_ADDRESS = ethers.ZeroAddress;
const ZERO_HASH = ethers.ZeroHash;

interface Fixture {
  yieldStreamer: Contract;
  yieldStreamerV1: Contract;
  tokenMock: Contract;
}

interface YieldState {
  flags: bigint;
  streamYield: bigint;
  accruedYield: bigint;
  lastUpdateTimestamp: bigint;
  lastUpdateBalance: bigint;
}

interface ClaimResult {
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

const defaultYieldState = {
  flags: 0n,
  streamYield: 0n,
  accruedYield: 0n,
  lastUpdateTimestamp: 0n,
  lastUpdateBalance: 0n
};

const defaultClaimResult: ClaimResult = {
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

function normalizeYieldState(yieldState: YieldState): YieldState {
  return {
    flags: yieldState.flags,
    streamYield: yieldState.streamYield,
    accruedYield: yieldState.accruedYield,
    lastUpdateTimestamp: yieldState.lastUpdateTimestamp,
    lastUpdateBalance: yieldState.lastUpdateBalance
  };
}

describe("Contract 'YieldStreamer', the initialization part", async () => {
  const EVENT_NAME_ACCOUNT_INITIALIZED = "YieldStreamer_AccountInitialized";
  const EVENT_NAME_GROUP_MAPPED = "YieldStreamer_GroupMapped";
  const EVENT_NAME_INITIALIZED_FLAG_SET = "YieldStreamer_InitializedFlagSet";
  const EVENT_NAME_SOURCE_YIELD_STREAMER_CHANGED = "YieldStreamer_SourceYieldStreamerChanged";
  const EVENT_NAME_BLOCKLIST_CALLED = "YieldStreamerV1Mock_BlocklistCalled";

  const REVERT_ERROR_IF_ACCOUNT_ALREADY_INITIALIZED = "YieldStreamer_AccountAlreadyInitialized";
  const REVERT_ERROR_IF_ACCOUNT_INITIALIZATION_PROHIBITED = "YieldStreamer_AccountInitializationProhibited";
  const REVERT_ERROR_IF_EMPTY_ARRAY = "YieldStreamer_EmptyArray";
  const REVERT_ERROR_IF_SOURCE_YIELD_STREAMER_ALREADY_CONFIGURED = "YieldStreamer_SourceYieldStreamerAlreadyConfigured";
  const REVERT_ERROR_IF_SOURCE_YIELD_STREAMER_GROUP_ALREADY_MAPPED =
    "YieldStreamer_SourceYieldStreamerGroupAlreadyMapped";
  const REVERT_ERROR_IF_SOURCE_YIELD_STREAMER_NOT_CONFIGURED = "YieldStreamer_SourceYieldStreamerNotConfigured";
  const REVERT_ERROR_IF_SOURCE_YIELD_STREAMER_UNAUTHORIZED_BLOCKLISTER =
    "YieldStreamer_SourceYieldStreamerUnauthorizedBlocklister";
  const REVERT_ERROR_IF_UNAUTHORIZED_ACCOUNT = "AccessControlUnauthorizedAccount";

  let yieldStreamerFactory: ContractFactory;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;

  // Get the signer representing the test user before the tests run
  before(async () => {
    [/* skip deployer*/, user1, user2] = await ethers.getSigners();

    // Contract factories with the explicitly specified deployer account
    yieldStreamerFactory = await ethers.getContractFactory("YieldStreamer");
  });

  async function deployContracts(): Promise<Fixture> {
    const tokenMockFactory = await ethers.getContractFactory("ERC20TokenMock");
    const tokenMock = await tokenMockFactory.deploy("Mock Token", "MTK");
    await tokenMock.waitForDeployment();

    const yieldStreamerV1Factory = await ethers.getContractFactory("YieldStreamerV1Mock");
    const yieldStreamerV1 = await yieldStreamerV1Factory.deploy();
    await yieldStreamerV1.waitForDeployment();

    const yieldStreamer: Contract = await upgrades.deployProxy(yieldStreamerFactory, [getAddress(tokenMock)]);
    await yieldStreamer.waitForDeployment();

    return { yieldStreamer, yieldStreamerV1, tokenMock };
  }

  async function deployAndConfigureContracts(): Promise<Fixture> {
    const fixture = await deployContracts();
    await proveTx(fixture.yieldStreamer.setSourceYieldStreamer(getAddress(fixture.yieldStreamerV1)));

    return fixture;
  }

  describe("Function 'setSourceYieldStreamer()'", async () => {
    const sourceYieldStreamerAddressStub = "0x0000000000000000000000000000000000000001";

    it("Executes as expected", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // Can be set to non-zero
      await expect(
        yieldStreamer.setSourceYieldStreamer(sourceYieldStreamerAddressStub)
      ).to.emit(
        yieldStreamer,
        EVENT_NAME_SOURCE_YIELD_STREAMER_CHANGED
      ).withArgs(
        ZERO_ADDRESS, // oldSourceYieldStreamer
        sourceYieldStreamerAddressStub // newSourceYieldStreamer
      );
      expect(await yieldStreamer.sourceYieldStreamer()).to.equal(sourceYieldStreamerAddressStub);

      // Can be set to zero
      await expect(
        yieldStreamer.setSourceYieldStreamer(ZERO_ADDRESS)
      ).to.emit(
        yieldStreamer,
        EVENT_NAME_SOURCE_YIELD_STREAMER_CHANGED
      ).withArgs(
        sourceYieldStreamerAddressStub, // oldSourceYieldStreamer
        ZERO_ADDRESS // newSourceYieldStreamer
      );
      expect(await yieldStreamer.sourceYieldStreamer()).to.equal(ZERO_ADDRESS);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      await expect(
        connect(yieldStreamer, user1).setSourceYieldStreamer(sourceYieldStreamerAddressStub)
      ).to.be.revertedWithCustomError(yieldStreamer, REVERT_ERROR_IF_UNAUTHORIZED_ACCOUNT);
    });

    it("Revert if new source yield streamer is the same", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // Check for the zero initial address
      await expect(
        yieldStreamer.setSourceYieldStreamer(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(
        yieldStreamer,
        REVERT_ERROR_IF_SOURCE_YIELD_STREAMER_ALREADY_CONFIGURED
      );

      // Check for a non-zero initial address
      await proveTx(yieldStreamer.setSourceYieldStreamer(sourceYieldStreamerAddressStub));
      await expect(
        yieldStreamer.setSourceYieldStreamer(sourceYieldStreamerAddressStub)
      ).to.be.revertedWithCustomError(
        yieldStreamer,
        REVERT_ERROR_IF_SOURCE_YIELD_STREAMER_ALREADY_CONFIGURED
      );
    });
  });

  describe("Function 'mapSourceYieldStreamerGroup()'", async () => {
    const groupKey = (ZERO_HASH);
    const groupId = maxUintForBits(32);

    it("Executes as expected", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // Some group key can be mapped to a non-zero group ID
      await expect(
        yieldStreamer.mapSourceYieldStreamerGroup(groupKey, groupId)
      ).to.emit(
        yieldStreamer,
        EVENT_NAME_GROUP_MAPPED
      ).withArgs(
        groupKey,
        groupId, // newGroupId
        0 // oldGroupId
      );
      expect(await yieldStreamer.sourceGroupMapping(groupKey)).to.equal(groupId);

      // Some group key can be mapped to the zero group ID
      await expect(
        yieldStreamer.mapSourceYieldStreamerGroup(groupKey, 0)
      ).to.emit(
        yieldStreamer,
        EVENT_NAME_GROUP_MAPPED
      ).withArgs(
        groupKey,
        0, // newGroupId
        groupId // oldGroupId
      );
      expect(await yieldStreamer.sourceGroupMapping(groupKey)).to.equal(0);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      await expect(
        connect(yieldStreamer, user1).mapSourceYieldStreamerGroup(groupKey, groupId)
      ).to.be.revertedWithCustomError(yieldStreamer, REVERT_ERROR_IF_UNAUTHORIZED_ACCOUNT);
    });

    it("Is reverted if source yield streamer group already mapped", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // Check for the zero initial group ID
      await expect(
        yieldStreamer.mapSourceYieldStreamerGroup(groupKey, 0)
      ).to.be.revertedWithCustomError(
        yieldStreamer,
        REVERT_ERROR_IF_SOURCE_YIELD_STREAMER_GROUP_ALREADY_MAPPED
      );

      // Check for a non-zero initial group ID
      await proveTx(yieldStreamer.mapSourceYieldStreamerGroup(groupKey, groupId));
      await expect(
        yieldStreamer.mapSourceYieldStreamerGroup(groupKey, groupId)
      ).to.be.revertedWithCustomError(
        yieldStreamer,
        REVERT_ERROR_IF_SOURCE_YIELD_STREAMER_GROUP_ALREADY_MAPPED
      );
    });
  });

  describe("Function 'initializeAccounts()'", async () => {
    it("Executes as expected", async () => {
      const { yieldStreamer, yieldStreamerV1, tokenMock } = await setUpFixture(deployAndConfigureContracts);
      const accounts = [user1.address, user2.address];
      const balances = [maxUintForBits(64), 1n];
      const groupKey = (ZERO_HASH);
      const groupId = 123;
      const claimPreviewResults: ClaimResult[] = [
        { ...defaultClaimResult, primaryYield: maxUintForBits(64) - 1n, lastDayPartialYield: 1n },
        { ...defaultClaimResult, primaryYield: 1n, lastDayPartialYield: 2n }
      ];

      for (const account of accounts) {
        expect(normalizeYieldState(await yieldStreamer.getYieldState(account))).to.deep.equal(defaultYieldState);
      }

      await proveTx(yieldStreamer.mapSourceYieldStreamerGroup(groupKey, groupId));
      for (let i = 0; i < accounts.length; ++i) {
        await proveTx(yieldStreamerV1.setClaimAllPreview(accounts[i], claimPreviewResults[i]));
        await proveTx(tokenMock.mint(accounts[i], balances[i]));
      }

      const tx = yieldStreamer.initializeAccounts(accounts);
      const txReceipt = await proveTx(tx);

      const expectedBlockTimestamp = (await getBlockTimestamp(txReceipt.blockNumber)) - NEGATIVE_TIME_SHIFT;
      const expectedYieldStates: YieldState[] = claimPreviewResults.map((res, i) => ({
        flags: 1n,
        streamYield: 0n,
        accruedYield: res.primaryYield + res.lastDayPartialYield,
        lastUpdateTimestamp: BigInt(expectedBlockTimestamp),
        lastUpdateBalance: balances[i]
      }));

      for (let i = 0; i < accounts.length; ++i) {
        await expect(tx)
          .to.emit(yieldStreamer, EVENT_NAME_ACCOUNT_INITIALIZED)
          .withArgs(
            accounts[i],
            groupId,
            balances[i],
            expectedYieldStates[i].accruedYield,
            0 // streamYield
          )
          .to.emit(yieldStreamerV1, EVENT_NAME_BLOCKLIST_CALLED);
      }
      for (let i = 0; i < accounts.length; ++i) {
        expect(
          normalizeYieldState(await yieldStreamer.getYieldState(accounts[i]))
        ).to.deep.equal(
          expectedYieldStates[i],
          `Wrong yield state for account[${i}]`
        );
      }
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const accounts = [user1.address, user2.address];

      await expect(
        connect(yieldStreamer, user1).initializeAccounts(accounts)
      ).to.be.revertedWithCustomError(yieldStreamer, REVERT_ERROR_IF_UNAUTHORIZED_ACCOUNT);
    });

    it("Is reverted if accounts array is empty", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);

      await expect(
        yieldStreamer.initializeAccounts([])
      ).to.be.revertedWithCustomError(yieldStreamer, REVERT_ERROR_IF_EMPTY_ARRAY);
    });

    it("Is reverted if the yield streamer source is not configured", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      await proveTx(yieldStreamer.setSourceYieldStreamer(ZERO_ADDRESS));

      await expect(
        yieldStreamer.initializeAccounts([user1.address])
      ).to.be.revertedWithCustomError(
        yieldStreamer,
        REVERT_ERROR_IF_SOURCE_YIELD_STREAMER_NOT_CONFIGURED
      );
    });

    it("Is reverted if the account is not a blocklister in the yield streamer source", async () => {
      const { yieldStreamer, yieldStreamerV1 } = await setUpFixture(deployAndConfigureContracts);
      await proveTx(yieldStreamerV1.setBlocklisterStatus(false));

      await expect(
        yieldStreamer.initializeAccounts([user1.address])
      ).to.be.revertedWithCustomError(
        yieldStreamer,
        REVERT_ERROR_IF_SOURCE_YIELD_STREAMER_UNAUTHORIZED_BLOCKLISTER
      );
    });

    it("Is reverted if account is already initialized", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const accounts = [user1.address, user2.address];
      await proveTx(await yieldStreamer.initializeAccounts([accounts[1]]));

      await expect(
        yieldStreamer.initializeAccounts(accounts)
      ).to.be.revertedWithCustomError(yieldStreamer, REVERT_ERROR_IF_ACCOUNT_ALREADY_INITIALIZED);
    });

    it("Is reverted if account address is zero", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const accounts = [user1.address, ZERO_ADDRESS];

      await expect(
        yieldStreamer.initializeAccounts(accounts)
      ).to.be.revertedWithCustomError(yieldStreamer, REVERT_ERROR_IF_ACCOUNT_INITIALIZATION_PROHIBITED);
    });
  });

  describe("Function 'setInitializedFlag()'", async () => {
    it("Executes as expected", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);

      expect(normalizeYieldState(await yieldStreamer.getYieldState(user1.address))).to.deep.equal(defaultYieldState);

      // Check change: 0 => 1
      await expect(yieldStreamer.setInitializedFlag(user1.address, true))
        .to.emit(yieldStreamer, EVENT_NAME_INITIALIZED_FLAG_SET)
        .withArgs(user1.address, true);
      const expectedYieldState: YieldState = { ...defaultYieldState, flags: 1n };
      expect(normalizeYieldState(await yieldStreamer.getYieldState(user1.address))).to.deep.equal(expectedYieldState);

      // Check change: 1 => 1
      await expect(yieldStreamer.setInitializedFlag(user1.address, true))
        .not.to.emit(yieldStreamer, EVENT_NAME_INITIALIZED_FLAG_SET);

      // Check change: 1 => 0
      await expect(yieldStreamer.setInitializedFlag(user1.address, false))
        .to.emit(yieldStreamer, EVENT_NAME_INITIALIZED_FLAG_SET)
        .withArgs(user1.address, false);
      expectedYieldState.flags = 0n;
      expect(normalizeYieldState(await yieldStreamer.getYieldState(user1.address))).to.deep.equal(expectedYieldState);

      // Check change: 0 => 0
      await expect(yieldStreamer.setInitializedFlag(user1.address, false))
        .not.to.emit(yieldStreamer, EVENT_NAME_INITIALIZED_FLAG_SET);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);

      await expect(
        connect(yieldStreamer, user1).setInitializedFlag(user1.address, true)
      ).to.be.revertedWithCustomError(yieldStreamer, REVERT_ERROR_IF_UNAUTHORIZED_ACCOUNT);
    });
  });
});
