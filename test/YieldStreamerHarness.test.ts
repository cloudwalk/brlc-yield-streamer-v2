import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { Contract, ContractFactory } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { connect, getLatestBlockTimestamp, proveTx } from "../test-utils/eth";
import { checkEquality, setUpFixture } from "../test-utils/common";
import { DAY, ERRORS, NEGATIVE_TIME_SHIFT, YieldRate, YieldState } from "../test-utils/specific";

const DEFAULT_ADMIN_ROLE: string = ethers.ZeroHash;
const OWNER_ROLE: string = ethers.id("OWNER_ROLE");
const HARNESS_ADMIN_ROLE: string = ethers.id("HARNESS_ADMIN_ROLE");

interface YieldStreamerHarnessLayout {
  currentBlockTimestamp: bigint;
  usingSpecialBlockTimestamps: boolean;
}

interface Fixture {
  yieldStreamerHarness: Contract;
  yieldStreamerHarnessUnderAdmin: Contract;
  tokenMock: Contract;
}

describe("contract 'YieldStreamerHarness'", async () => {
  let yieldStreamerHarnessFactory: ContractFactory;
  let deployer: HardhatEthersSigner;
  let harnessAdmin: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  // Get the signer representing the test user before the tests run
  before(async () => {
    [deployer, harnessAdmin, stranger] = await ethers.getSigners();

    // Contract factories with the explicitly specified deployer account
    yieldStreamerHarnessFactory = await ethers.getContractFactory("YieldStreamerHarness");
  });

  async function deployContracts(): Promise<Fixture> {
    const tokenMockFactory = await ethers.getContractFactory("ERC20TokenMock");

    const tokenMock = await tokenMockFactory.deploy("Mock Token", "MTK");
    await tokenMock.waitForDeployment();

    const yieldStreamerHarness: Contract = await upgrades.deployProxy(yieldStreamerHarnessFactory, [tokenMock.target]);
    await yieldStreamerHarness.waitForDeployment();
    const yieldStreamerHarnessUnderAdmin = connect(yieldStreamerHarness, harnessAdmin);

    return { yieldStreamerHarness, yieldStreamerHarnessUnderAdmin, tokenMock };
  }

  async function deployAndConfigureContracts(): Promise<Fixture> {
    const fixture = await deployContracts();
    await proveTx(fixture.yieldStreamerHarness.initHarness());
    await proveTx(fixture.yieldStreamerHarness.grantRole(HARNESS_ADMIN_ROLE, harnessAdmin.address));

    return fixture;
  }

  describe("Function 'initHarness()'", async () => {
    it("Executes as expected", async () => {
      const { yieldStreamerHarness } = await setUpFixture(deployContracts);
      expect(await yieldStreamerHarness.getRoleAdmin(HARNESS_ADMIN_ROLE)).to.equal(DEFAULT_ADMIN_ROLE);
      await proveTx(yieldStreamerHarness.initHarness());
      expect(await yieldStreamerHarness.getRoleAdmin(HARNESS_ADMIN_ROLE)).to.equal(OWNER_ROLE);
    });
    it("Is reverted if the caller does not have the owner role", async () => {
      const { yieldStreamerHarness } = await setUpFixture(deployContracts);
      await expect(connect(yieldStreamerHarness, stranger).initHarness())
        .to.be.revertedWithCustomError(yieldStreamerHarness, ERRORS.AccessControlUnauthorizedAccount)
        .withArgs(stranger.address, OWNER_ROLE);
    });
  });

  describe("Function 'deleteYieldRates()'", async () => {
    it("Executes as expected", async () => {
      const { yieldStreamerHarness, yieldStreamerHarnessUnderAdmin } = await setUpFixture(deployAndConfigureContracts);
      const groupId = 1;
      const yieldRate1: YieldRate = { effectiveDay: 0n, tiers: [{ rate: 123n, cap: 0n }] };
      const yieldRate2: YieldRate = { effectiveDay: 1n, tiers: [{ rate: 456n, cap: 0n }] };

      const actualYieldRatesBefore1 = await yieldStreamerHarness.getGroupYieldRates(groupId);
      expect(actualYieldRatesBefore1.length).to.equal(0);

      await proveTx(
        yieldStreamerHarness.addYieldRate(
          groupId,
          yieldRate1.effectiveDay,
          yieldRate1.tiers.map(tier => tier.rate),
          yieldRate1.tiers.map(tier => tier.cap)
        )
      );
      await proveTx(
        yieldStreamerHarness.addYieldRate(
          groupId,
          yieldRate2.effectiveDay,
          yieldRate2.tiers.map(tier => tier.rate),
          yieldRate2.tiers.map(tier => tier.cap)
        )
      );

      const actualYieldRatesBefore2 = await yieldStreamerHarness.getGroupYieldRates(groupId);
      expect(actualYieldRatesBefore2.length).to.equal(2);

      await proveTx(yieldStreamerHarnessUnderAdmin.deleteYieldRates(groupId));
      const actualYieldRatesAfter = await yieldStreamerHarness.getGroupYieldRates(groupId);
      expect(actualYieldRatesAfter.length).to.equal(0);
    });

    it("Is reverted if the caller does not have the harness admin role", async () => {
      const { yieldStreamerHarness } = await setUpFixture(deployContracts);
      const groupId = 1;

      await expect(connect(yieldStreamerHarness, deployer).deleteYieldRates(groupId))
        .to.be.revertedWithCustomError(yieldStreamerHarness, ERRORS.AccessControlUnauthorizedAccount)
        .withArgs(deployer.address, HARNESS_ADMIN_ROLE);
    });
  });

  describe("Function 'setYieldState()'", async () => {
    const expectedYieldState: YieldState = {
      flags: 0xffn,
      streamYield: 2n ** 64n - 1n,
      accruedYield: 2n ** 64n - 1n,
      lastUpdateTimestamp: 2n ** 40n - 1n,
      lastUpdateBalance: 2n ** 64n - 1n
    };
    const accountAddress = "0x0000000000000000000000000000000000000001";

    it("Executes as expected", async () => {
      const { yieldStreamerHarnessUnderAdmin } = await setUpFixture(deployAndConfigureContracts);

      await proveTx(yieldStreamerHarnessUnderAdmin.setYieldState(accountAddress, expectedYieldState));
      const actualYieldState = await yieldStreamerHarnessUnderAdmin.getYieldState(accountAddress);
      checkEquality(actualYieldState, expectedYieldState);
    });

    it("Is reverted if the caller does not have the harness admin role", async () => {
      const { yieldStreamerHarness } = await setUpFixture(deployContracts);

      await expect(connect(yieldStreamerHarness, deployer).setYieldState(accountAddress, expectedYieldState))
        .to.be.revertedWithCustomError(yieldStreamerHarness, ERRORS.AccessControlUnauthorizedAccount)
        .withArgs(deployer.address, HARNESS_ADMIN_ROLE);
    });
  });

  describe("Function 'resetYieldState()'", async () => {
    const accountAddress = "0x0000000000000000000000000000000000000001";

    it("Executes as expected", async () => {
      const { yieldStreamerHarnessUnderAdmin } = await setUpFixture(deployAndConfigureContracts);
      const expectedYieldStateBefore: YieldState = {
        flags: 0xffn,
        streamYield: 2n ** 64n - 1n,
        accruedYield: 2n ** 64n - 1n,
        lastUpdateTimestamp: 2n ** 40n - 1n,
        lastUpdateBalance: 2n ** 64n - 1n
      };
      await proveTx(yieldStreamerHarnessUnderAdmin.setYieldState(accountAddress, expectedYieldStateBefore));
      const actualYieldStateBefore = await yieldStreamerHarnessUnderAdmin.getYieldState(accountAddress);
      checkEquality(actualYieldStateBefore, expectedYieldStateBefore);

      const expectedYieldStateAfter: YieldState = {
        flags: 0n,
        streamYield: 0n,
        accruedYield: 0n,
        lastUpdateTimestamp: 0n,
        lastUpdateBalance: 0n
      };
      await proveTx(yieldStreamerHarnessUnderAdmin.resetYieldState(accountAddress));
      const actualYieldStateAfter = await yieldStreamerHarnessUnderAdmin.getYieldState(accountAddress);
      checkEquality(actualYieldStateAfter, expectedYieldStateAfter);
    });

    it("Is reverted if the caller does not have the harness admin role", async () => {
      const { yieldStreamerHarness } = await setUpFixture(deployContracts);

      await expect(connect(yieldStreamerHarness, deployer).resetYieldState(accountAddress))
        .to.be.revertedWithCustomError(yieldStreamerHarness, ERRORS.AccessControlUnauthorizedAccount)
        .withArgs(deployer.address, HARNESS_ADMIN_ROLE);
    });
  });

  describe("Function 'setBlockTimestamp()'", async () => {
    const day = 123n;
    const time = 456n;

    it("Executes as expected", async () => {
      const { yieldStreamerHarnessUnderAdmin } = await setUpFixture(deployAndConfigureContracts);
      const expectedTimestamp = day * DAY + time;
      const expectedYieldStreamerHarnessLayout: YieldStreamerHarnessLayout = {
        currentBlockTimestamp: 0n,
        usingSpecialBlockTimestamps: false
      };

      const actualYieldStreamerHarnessLayoutBefore = await yieldStreamerHarnessUnderAdmin.getHarnessStorageLayout();
      checkEquality(actualYieldStreamerHarnessLayoutBefore, expectedYieldStreamerHarnessLayout);

      await proveTx(yieldStreamerHarnessUnderAdmin.setBlockTimestamp(day, time));

      expectedYieldStreamerHarnessLayout.currentBlockTimestamp = expectedTimestamp;
      const actualYieldStreamerHarnessLayoutAfter = await yieldStreamerHarnessUnderAdmin.getHarnessStorageLayout();
      checkEquality(actualYieldStreamerHarnessLayoutAfter, expectedYieldStreamerHarnessLayout);
    });

    it("Is reverted if the caller does not have the harness admin role", async () => {
      const { yieldStreamerHarness } = await setUpFixture(deployContracts);

      await expect(connect(yieldStreamerHarness, deployer).setBlockTimestamp(day, time))
        .to.be.revertedWithCustomError(yieldStreamerHarness, ERRORS.AccessControlUnauthorizedAccount)
        .withArgs(deployer.address, HARNESS_ADMIN_ROLE);
    });
  });

  describe("Function 'setUsingSpecialBlockTimestamps()'", async () => {
    it("Executes as expected", async () => {
      const { yieldStreamerHarnessUnderAdmin } = await setUpFixture(deployAndConfigureContracts);
      const expectedYieldStreamerHarnessLayout: YieldStreamerHarnessLayout = {
        currentBlockTimestamp: 0n,
        usingSpecialBlockTimestamps: false
      };

      const actualYieldStreamerHarnessLayoutBefore = await yieldStreamerHarnessUnderAdmin.getHarnessStorageLayout();
      checkEquality(actualYieldStreamerHarnessLayoutBefore, expectedYieldStreamerHarnessLayout);

      await proveTx(yieldStreamerHarnessUnderAdmin.setUsingSpecialBlockTimestamps(true));

      expectedYieldStreamerHarnessLayout.usingSpecialBlockTimestamps = true;
      const actualYieldStreamerHarnessLayoutAfter = await yieldStreamerHarnessUnderAdmin.getHarnessStorageLayout();
      checkEquality(actualYieldStreamerHarnessLayoutAfter, expectedYieldStreamerHarnessLayout);
    });

    it("Is reverted if the caller does not have the harness admin role", async () => {
      const { yieldStreamerHarness } = await setUpFixture(deployContracts);

      await expect(connect(yieldStreamerHarness, deployer).setUsingSpecialBlockTimestamps(true))
        .to.be.revertedWithCustomError(yieldStreamerHarness, ERRORS.AccessControlUnauthorizedAccount)
        .withArgs(deployer.address, HARNESS_ADMIN_ROLE);
    });
  });

  describe("Function 'blockTimestamp()'", async () => {
    it("Executes as expected", async () => {
      const { yieldStreamerHarnessUnderAdmin } = await setUpFixture(deployAndConfigureContracts);
      const day = 123n;
      const time = 456n;

      let expectedBlockTimestamp = BigInt(await getLatestBlockTimestamp()) - NEGATIVE_TIME_SHIFT;
      expect(await yieldStreamerHarnessUnderAdmin.blockTimestamp()).to.equal(expectedBlockTimestamp);

      await proveTx(yieldStreamerHarnessUnderAdmin.setUsingSpecialBlockTimestamps(true));
      expectedBlockTimestamp = 0n;
      expect(await yieldStreamerHarnessUnderAdmin.blockTimestamp()).to.equal(expectedBlockTimestamp);

      await proveTx(yieldStreamerHarnessUnderAdmin.setBlockTimestamp(day, time));
      expectedBlockTimestamp = day * DAY + time - NEGATIVE_TIME_SHIFT;
      expect(await yieldStreamerHarnessUnderAdmin.blockTimestamp()).to.equal(expectedBlockTimestamp);
    });
  });
});
