import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { Contract, ContractFactory } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { connect, getAddress, getBlockTimestamp, proveTx } from "../test-utils/eth";
import { setUpFixture } from "../test-utils/common";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

const HOUR = 60 * 60; // Number of seconds in an hour
const NEGATIVE_TIME_SHIFT = 3 * HOUR; // Negative time shift in seconds (3 hours)
const ZERO_ADDRESS = ethers.ZeroAddress;
const ZERO_HASH = ethers.ZeroHash;

interface Fixture {
  yieldStreamerInitialization: Contract;
  yieldStreamerV1: Contract;
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

describe("Contract 'YieldStreamer', the initialization part", function () {
  const EVENT_NAME_ACCOUNT_INITIALIZED = "YieldStreamer_AccountInitialized";
  const EVENT_NAME_SOURCE_YIELD_STREAMER_CHANGED = "YieldStreamer_SourceYieldStreamerChanged";
  const EVENT_NAME_GROUP_MAPPED = "YieldStreamer_GroupMapped";
  const EVENT_NAME_INITIALIZED_FLAG_SET = "YieldStreamer_InitializedFlagSet";

  const REVERT_ERROR_IF_EMPTY_ARRAY = "YieldStreamer_EmptyArray";
  const REVERT_ERROR_IF_ACCOUNT_ALREADY_INITIALIZED = "YieldStreamer_AccountAlreadyInitialized";
  const REVERT_ERROR_IF_ACCOUNT_INITIALIZATION_PROHIBITED = "YieldStreamer_AccountInitializationProhibited";
  const REVERT_ERROR_IF_SOURCE_YIELD_STREAMER_NOT_CONFIGURED = "YieldStreamer_SourceYieldStreamerNotConfigured";
  const REVERT_ERROR_IF_SOURCE_YIELD_STREAMER_ALREADY_CONFIGURED = "YieldStreamer_SourceYieldStreamerAlreadyConfigured";
  const REVERT_ERROR_IF_SOURCE_YIELD_STREAMER_GROUP_ALREADY_MAPPED = "YieldStreamer_SourceYieldStreamerGroupAlreadyMapped";
  const REVERT_ERROR_IF_SOURCE_YIELD_STREAMER_UNAUTHORIZED_BLOCKLISTER = "YieldStreamer_SourceYieldStreamerUnauthorizedBlocklister";
  const REVERT_ERROR_IF_UNAUTHORIZED_ACCOUNT = "AccessControlUnauthorizedAccount";

  let yieldStreamerInitializationFactory: ContractFactory;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;

  // Get the signer representing the test user before the tests run
  before(async () => {
    [user1, user2] = await ethers.getSigners();

    // Contract factories with the explicitly specified deployer account
    yieldStreamerInitializationFactory = await ethers.getContractFactory("YieldStreamerMock");
  });

  async function deployContracts(): Promise<Fixture> {
    const tokenMockFactory = await ethers.getContractFactory("ERC20TokenMock");

    const tokenMock = await tokenMockFactory.deploy("Mock Token", "MTK");
    await tokenMock.waitForDeployment();

    const yieldStreamerV1Factory = await ethers.getContractFactory("YieldStreamerV1Mock");
    const yieldStreamerV1 = await yieldStreamerV1Factory.deploy();
    await yieldStreamerV1.waitForDeployment();

    const yieldStreamerInitialization: Contract = await upgrades.deployProxy(
      yieldStreamerInitializationFactory,
      [getAddress(tokenMock)]
    );

    await yieldStreamerInitialization.waitForDeployment();

    return { yieldStreamerInitialization, yieldStreamerV1 };
  }

  async function deployAndConfigureContracts(): Promise<Fixture> {
    const { yieldStreamerInitialization, yieldStreamerV1 } = await deployContracts();
    await proveTx(yieldStreamerInitialization.setSourceYieldStreamer(yieldStreamerV1));

    return { yieldStreamerInitialization, yieldStreamerV1 };
  }

  describe("Function 'initializeAccounts()'", async () => {
    it("Executes as expected", async () => {
      const { yieldStreamerInitialization, yieldStreamerV1 } = await setUpFixture(deployAndConfigureContracts);
      const accounts = [user1.address, user2.address];

      const claimPreviewResult: ClaimResult = {
        nextClaimDay: 1n,
        nextClaimDebit: 2n,
        firstYieldDay: 3n,
        prevClaimDebit: 4n,
        primaryYield: 5n,
        streamYield: 6n,
        lastDayPartialYield: 7n,
        shortfall: 8n,
        fee: 9n,
        yield: 10n
      };

      const expectedBlockTimestamp = (await getBlockTimestamp("latest")) - NEGATIVE_TIME_SHIFT;
      const expectedYieldState =
        [
          1n,
          0n,
          claimPreviewResult.primaryYield + claimPreviewResult.lastDayPartialYield,
          expectedBlockTimestamp,
          0n
        ];

      expect(await yieldStreamerInitialization.getYieldState(user1.address))
        .to.be.deep.equal([0n, 0n, 0n, 0n, 0n]);
      expect(await yieldStreamerInitialization.getYieldState(user2.address))
        .to.be.deep.equal([0n, 0n, 0n, 0n, 0n]);

      await proveTx(yieldStreamerV1.setClaimAllPreview(user1.address, claimPreviewResult));
      await proveTx(yieldStreamerV1.setClaimAllPreview(user2.address, claimPreviewResult));

      await expect(
        yieldStreamerInitialization.initializeAccounts(accounts)
      )
        .to.emit(yieldStreamerInitialization, EVENT_NAME_ACCOUNT_INITIALIZED)
        .withArgs(user1.address, anyValue, anyValue, anyValue, anyValue)
        .to.emit(yieldStreamerInitialization, EVENT_NAME_ACCOUNT_INITIALIZED)
        .withArgs(user2.address, anyValue, anyValue, anyValue, anyValue);

      expect(await yieldStreamerInitialization.getYieldState(user1.address)).to.be.deep.equal(expectedYieldState);
      expect(yieldStreamerInitialization.getYieldState(user2.address)).to.be.deep.equal(expectedYieldState);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { yieldStreamerInitialization } = await setUpFixture(deployAndConfigureContracts);
      const accounts = [user1.address, user2.address];


      await expect(
        connect(yieldStreamerInitialization, user2).initializeAccounts(accounts)
      ).revertedWithCustomError(yieldStreamerInitialization, REVERT_ERROR_IF_UNAUTHORIZED_ACCOUNT);
    });

    it("Is reverted if accounts array is empty", async () => {
      const { yieldStreamerInitialization } = await setUpFixture(deployAndConfigureContracts);

      await expect(
        yieldStreamerInitialization.initializeAccounts([])
      )
        .to.be.revertedWithCustomError(yieldStreamerInitialization, REVERT_ERROR_IF_EMPTY_ARRAY);
    });

    it("Is reverted if the yield streamer source is not configured", async () => {
      const { yieldStreamerInitialization } = await setUpFixture(deployContracts);

      await expect(
        yieldStreamerInitialization.initializeAccounts([user1.address])
      )
        .to.be.revertedWithCustomError(
          yieldStreamerInitialization,
          REVERT_ERROR_IF_SOURCE_YIELD_STREAMER_NOT_CONFIGURED
        );
    });

    it("Is reverted if the account is not a blocklister in the yield streamer source", async () => {
      const { yieldStreamerInitialization, yieldStreamerV1 } = await setUpFixture(deployAndConfigureContracts);
      yieldStreamerV1.setBlocklisterStatus(false);

      await expect(
        yieldStreamerInitialization.initializeAccounts([user1.address])
      )
        .to.be.revertedWithCustomError(
          yieldStreamerInitialization,
          REVERT_ERROR_IF_SOURCE_YIELD_STREAMER_UNAUTHORIZED_BLOCKLISTER
        );
    });

    it("Reverted if account is already initialized", async () => {
      const { yieldStreamerInitialization } = await setUpFixture(deployAndConfigureContracts);
      const accounts = [user1.address];
      await proveTx(await yieldStreamerInitialization.initializeAccounts(accounts));

      await expect(
        yieldStreamerInitialization.initializeAccounts(accounts)
      )
        .to.be.revertedWithCustomError(yieldStreamerInitialization, REVERT_ERROR_IF_ACCOUNT_ALREADY_INITIALIZED);
    });

    it("Reverted if account address is zero", async () => {
      const { yieldStreamerInitialization } = await setUpFixture(deployAndConfigureContracts);

      await expect(
        yieldStreamerInitialization.initializeAccounts([ZERO_ADDRESS])
      )
        .to.be.revertedWithCustomError(yieldStreamerInitialization, REVERT_ERROR_IF_ACCOUNT_INITIALIZATION_PROHIBITED);
    });
  });

  describe("Function 'setSourceYieldStreamer()'", async () => {
    it("Executes as expected", async () => {
      const { yieldStreamerInitialization } = await setUpFixture(deployContracts);

      await expect(
        yieldStreamerInitialization.setSourceYieldStreamer(user1.address)
      )
        .to.emit(yieldStreamerInitialization, EVENT_NAME_SOURCE_YIELD_STREAMER_CHANGED);

      expect(await yieldStreamerInitialization.sourceYieldStreamer()).to.be.equal(user1.address);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { yieldStreamerInitialization } = await setUpFixture(deployAndConfigureContracts);

      await expect(
        connect(yieldStreamerInitialization, user2).setSourceYieldStreamer(user1.address)
      ).revertedWithCustomError(yieldStreamerInitialization, REVERT_ERROR_IF_UNAUTHORIZED_ACCOUNT);
    });

    it("Revert if new source yield streamer is the same", async () => {
      const { yieldStreamerInitialization } = await setUpFixture(deployContracts);
      await proveTx(yieldStreamerInitialization.setSourceYieldStreamer(user1.address));

      await expect(
        yieldStreamerInitialization.setSourceYieldStreamer(user1.address)
      )
        .to.be.revertedWithCustomError(
          yieldStreamerInitialization,
          REVERT_ERROR_IF_SOURCE_YIELD_STREAMER_ALREADY_CONFIGURED
        );
    });
  });

  describe("Function 'mapSourceYieldStreamerGroup()'", async () => {
    it("Executes as expected", async () => {
      const { yieldStreamerInitialization } = await setUpFixture(deployAndConfigureContracts);
      const GROUP_ID = 4294967295n;

      await expect(
        yieldStreamerInitialization.mapSourceYieldStreamerGroup(ZERO_HASH, GROUP_ID)
      )
        .to.emit(yieldStreamerInitialization, EVENT_NAME_GROUP_MAPPED);

      expect(await yieldStreamerInitialization.getGroupId(ZERO_HASH)).to.be.equal(GROUP_ID);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { yieldStreamerInitialization } = await setUpFixture(deployAndConfigureContracts);

      await expect(
        connect(yieldStreamerInitialization, user2).mapSourceYieldStreamerGroup(ZERO_HASH, 1)
      ).revertedWithCustomError(yieldStreamerInitialization, REVERT_ERROR_IF_UNAUTHORIZED_ACCOUNT);
    });

    it("Is reverted if source yield streamer group already mapped", async () => {
      const { yieldStreamerInitialization } = await setUpFixture(deployContracts);
      await proveTx(yieldStreamerInitialization.mapSourceYieldStreamerGroup(ZERO_HASH, 1));
      await expect(
        yieldStreamerInitialization.mapSourceYieldStreamerGroup(ZERO_HASH, 1)
      )
        .to.be.revertedWithCustomError(
          yieldStreamerInitialization,
          REVERT_ERROR_IF_SOURCE_YIELD_STREAMER_GROUP_ALREADY_MAPPED
        );
    });
  });

  describe("Function 'setInitializedFlag()'", async () => {
    it("Executes as expected", async () => {
      const { yieldStreamerInitialization } = await setUpFixture(deployContracts);

      expect(await yieldStreamerInitialization.getYieldState(user1.address))
        .to.be.deep.equal([0n, 0n, 0n, 0n, 0n]);

      await expect(
        yieldStreamerInitialization.setInitializedFlag(user1.address, true)
      )
        .to.emit(yieldStreamerInitialization, EVENT_NAME_INITIALIZED_FLAG_SET)
        .withArgs(user1.address, true);

      expect(await yieldStreamerInitialization.getYieldState(user1.address))
        .to.be.deep.equal([1n, 0n, 0n, 0n, 0n]);

      await expect(
        yieldStreamerInitialization.setInitializedFlag(user1.address, false)
      )
        .to.emit(yieldStreamerInitialization, EVENT_NAME_INITIALIZED_FLAG_SET)
        .withArgs(user1.address, false);

      expect(await yieldStreamerInitialization.getYieldState(user1.address))
        .to.be.deep.equal([0n, 0n, 0n, 0n, 0n]);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { yieldStreamerInitialization } = await setUpFixture(deployAndConfigureContracts);

      await expect(
        connect(yieldStreamerInitialization, user2).setInitializedFlag(user1.address, true)
      ).revertedWithCustomError(yieldStreamerInitialization, REVERT_ERROR_IF_UNAUTHORIZED_ACCOUNT);
    });
  });

  describe("Function 'sourceYieldStreamer()'", async () => {
    it("Executes as expected", async () => {
      const { yieldStreamerInitialization } = await setUpFixture(deployContracts);

      expect(
        yieldStreamerInitialization.sourceYieldStreamer()
      )
        .to.exist;
    });
  });
});
