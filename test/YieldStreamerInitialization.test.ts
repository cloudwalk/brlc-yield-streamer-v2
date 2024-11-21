import { expect } from "chai";
import { ethers, network, upgrades } from "hardhat";
import { Contract, ContractFactory } from "ethers";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { connect, getAddress, proveTx } from "../test-utils/eth";
import { setUpFixture } from "../test-utils/common";

interface Fixture {
  yieldStreamerInitialization: Contract;
  yieldStreamerV1: Contract;
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
    yieldStreamerInitializationFactory = await ethers.getContractFactory("YieldStreamer");
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
      const { yieldStreamerInitialization } = await setUpFixture(deployAndConfigureContracts);
      const accounts = [user1.address, user2.address];

      await expect(
        yieldStreamerInitialization.initializeAccounts(accounts)
      )
        .to.emit(yieldStreamerInitialization, EVENT_NAME_ACCOUNT_INITIALIZED);
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
        yieldStreamerInitialization.initializeAccounts([ethers.ZeroAddress])
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
      const { yieldStreamerInitialization } = await setUpFixture(deployContracts);

      await expect(
        yieldStreamerInitialization.mapSourceYieldStreamerGroup(ethers.ZeroHash, 1)
      )
        .to.emit(yieldStreamerInitialization, EVENT_NAME_GROUP_MAPPED);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { yieldStreamerInitialization } = await setUpFixture(deployAndConfigureContracts);

      await expect(
        connect(yieldStreamerInitialization, user2).mapSourceYieldStreamerGroup(ethers.ZeroHash, 1)
      ).revertedWithCustomError(yieldStreamerInitialization, REVERT_ERROR_IF_UNAUTHORIZED_ACCOUNT);
    });

    it("Is reverted if source yield streamer group already mapped", async () => {
      const { yieldStreamerInitialization } = await setUpFixture(deployContracts);
      await proveTx(yieldStreamerInitialization.mapSourceYieldStreamerGroup(ethers.ZeroHash, 1));
      await expect(
        yieldStreamerInitialization.mapSourceYieldStreamerGroup(ethers.ZeroHash, 1)
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

      await expect(
        yieldStreamerInitialization.setInitializedFlag(user1.address, true)
      )
        .to.emit(yieldStreamerInitialization, EVENT_NAME_INITIALIZED_FLAG_SET)
        .withArgs(user1.address, true);

      await expect(
        yieldStreamerInitialization.setInitializedFlag(user1.address, false)
      )
        .to.emit(yieldStreamerInitialization, EVENT_NAME_INITIALIZED_FLAG_SET)
        .withArgs(user1.address, false);

      await expect(
        yieldStreamerInitialization.setInitializedFlag(user1.address, false)
      )
        .to.not.emit(yieldStreamerInitialization, EVENT_NAME_INITIALIZED_FLAG_SET);
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
