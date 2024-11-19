import { expect } from "chai";
import { ethers, network, upgrades } from "hardhat";
import { Contract, ContractFactory } from "ethers";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { getLatestBlockTimestamp, proveTx } from "../test-utils/eth";

// Constants for rate calculations and time units
const RATE_FACTOR = BigInt(1000000000000); // Factor used in yield rate calculations (10^12)
const HOUR = 60 * 60; // Number of seconds in an hour
const NEGATIVE_TIME_SHIFT = 3 * HOUR; // Negative time shift in seconds (3 hours)

// Interface representing a yield rate change in the contract
interface YieldTieredRate {
  effectiveDay: number; // Day when the yield rate becomes effective
  tierRates: bigint[]; // Array of yield rate value for each tier (expressed in RATE_FACTOR units)
  tierCaps: bigint[]; // Array of balance cap for each tier
}

async function setUpFixture<T>(func: () => Promise<T>): Promise<T> {
  if (network.name === "hardhat") {
    // Use Hardhat's snapshot functionality for faster test execution
    return loadFixture(func);
  } else {
    // Directly execute the function if not on Hardhat network
    return func();
  }
}

describe("YieldStreamerConfiguration", function () {
  const EVENT_NAME_GROUP_ASSIGNED = "YieldStreamer_GroupAssigned";
  const EVENT_NAME_YIELD_RATE_ADDED = "YieldStreamer_YieldRateAdded";
  const EVENT_NAME_YIELD_RATE_UPDATED = "YieldStreamer_YieldRateUpdated";
  const EVENT_NAME_FEE_RECEIVER_CHANGED = "YieldStreamer_FeeReceiverChanged";
  const EVENT_NAME_YIELD_ACCRUED = "YieldStreamer_YieldAccrued";

  const REVERT_ERROR_IF_YIELD_RATE_INVALID_ITEM_INDEX = "YieldStreamer_YieldRateInvalidItemIndex";
  const REVERT_ERROR_IF_YIELD_RATE_INVALID_EFFECTIVE_DATE = "YieldStreamer_YieldRateInvalidEffectiveDay";
  // const REVERT_ERROR_IF_YIELD_RATE_ALREADY_CONFIGURED = "YieldStreamer_YieldRateAlreadyConfigured";
  const REVERT_ERROR_IF_FEE_RECEIVER_ALREADY_CONFIGURED = "YieldStreamer_FeeReceiverAlreadyConfigured";
  const REVERT_ERROR_IF_GROUP_ALREADY_ASSIGNED = "YieldStreamer_GroupAlreadyAssigned";

  const DEFAULT_GROUP_ID = ethers.ZeroHash;
  const TEST_GROUP_ID = 1;
  const DEFAULT_ITEM_INDEX = 0;
  const INCORRECT_ITEM_INDEX = 3;
  const INCORRECT_EFFECTIVE_DAY_1 = 1;
  const YIELD_RATES: YieldTieredRate[] = [
    {
      effectiveDay: 0,
      tierRates: [(RATE_FACTOR * BigInt(40000)) / BigInt(100000), (RATE_FACTOR * BigInt(40000)) / BigInt(100000)],
      tierCaps: [BigInt(100), BigInt(0)]
    },
    {
      effectiveDay: 1,
      tierRates: [(RATE_FACTOR * BigInt(40000)) / BigInt(100000), (RATE_FACTOR * BigInt(40000)) / BigInt(100000)],
      tierCaps: [BigInt(100), BigInt(0)]
    },
    {
      effectiveDay: 2,
      tierRates: [(RATE_FACTOR * BigInt(40000)) / BigInt(100000), (RATE_FACTOR * BigInt(40000)) / BigInt(100000)],
      tierCaps: [BigInt(100), BigInt(0)]
    }
  ];

  let yieldStreamerConfigurationFactory: ContractFactory;
  let feeReceiver: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;

  // Get the signer representing the test user before the tests run
  before(async function () {
    [feeReceiver, user1, user2] = await ethers.getSigners();

    // Contract factories with the explicitly specified deployer account
    yieldStreamerConfigurationFactory = await ethers.getContractFactory("YieldStreamer");
  });

  async function deployContracts(): Promise<{ yieldStreamer: Contract }> {
    const tokenMockFactory = await ethers.getContractFactory("ERC20TokenMock");

    const tokenMock = await tokenMockFactory.deploy("Mock Token", "MTK");
    await tokenMock.waitForDeployment();

    const yieldStreamer: Contract = await upgrades.deployProxy(yieldStreamerConfigurationFactory, [tokenMock.target]);
    await yieldStreamer.waitForDeployment();

    return { yieldStreamer };
  }

  async function deployAndConfigureContracts(): Promise<{ yieldStreamer: Contract }> {
    const { yieldStreamer } = await deployContracts();

    for (const rate of YIELD_RATES) {
      await proveTx(
        yieldStreamer.addYieldRate(
          DEFAULT_GROUP_ID,
          rate.effectiveDay,
          rate.tierRates,
          rate.tierCaps
        )
      );
    }

    return { yieldStreamer };
  }

  describe("Function 'addYieldRate()'", async () => {
    it("Executes as expected", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      await expect(
        yieldStreamer.addYieldRate(
          DEFAULT_GROUP_ID,
          YIELD_RATES[0].effectiveDay,
          YIELD_RATES[0].tierRates,
          YIELD_RATES[0].tierCaps
        )
      )
        .to.emit(yieldStreamer, EVENT_NAME_YIELD_RATE_ADDED)
        .withArgs(DEFAULT_GROUP_ID, YIELD_RATES[0].effectiveDay, YIELD_RATES[0].tierRates, YIELD_RATES[0].tierCaps);
    });

    it("Is reverted if the first yield rate has the invalid effective day", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      await expect(
        yieldStreamer.addYieldRate(
          DEFAULT_GROUP_ID,
          INCORRECT_EFFECTIVE_DAY_1,
          YIELD_RATES[0].tierRates,
          YIELD_RATES[0].tierCaps
        )
      ).revertedWithCustomError(yieldStreamer, REVERT_ERROR_IF_YIELD_RATE_INVALID_EFFECTIVE_DATE);
    });

    it("Is reverted if the provided yield rate has effective day less than in the previous yield rate", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const yieldRate = YIELD_RATES[2];
      yieldRate.effectiveDay = yieldRate.effectiveDay - INCORRECT_EFFECTIVE_DAY_1;

      await expect(
        yieldStreamer.addYieldRate(
          DEFAULT_GROUP_ID,
          yieldRate.effectiveDay,
          yieldRate.tierRates,
          yieldRate.tierCaps
        )
      ).revertedWithCustomError(yieldStreamer, REVERT_ERROR_IF_YIELD_RATE_INVALID_EFFECTIVE_DATE);
    });
  });

  describe("Function 'updateYieldRate()'", async () => {
    it("Executes as expected", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const yieldRateUpdated: YieldTieredRate = YIELD_RATES[0];

      await expect(
        yieldStreamer.updateYieldRate(
          DEFAULT_GROUP_ID,
          DEFAULT_ITEM_INDEX,
          yieldRateUpdated.effectiveDay,
          yieldRateUpdated.tierRates,
          yieldRateUpdated.tierCaps
        )
      )
        .to.emit(yieldStreamer, EVENT_NAME_YIELD_RATE_UPDATED)
        .withArgs(
          DEFAULT_GROUP_ID,
          DEFAULT_ITEM_INDEX,
          yieldRateUpdated.effectiveDay,
          yieldRateUpdated.tierRates,
          yieldRateUpdated.tierCaps
        );
    });

    it("Executes as expected if only one yield rate presents", async () => {
      const { yieldStreamer } = await deployContracts(); // using setUpFixture(deployContracts) broke next tests
      const yieldRateUpdated: YieldTieredRate = YIELD_RATES[0];

      await proveTx(
        yieldStreamer.addYieldRate(
          DEFAULT_GROUP_ID,
          yieldRateUpdated.effectiveDay,
          yieldRateUpdated.tierRates,
          yieldRateUpdated.tierCaps
        )
      );

      await expect(
        yieldStreamer.updateYieldRate(
          DEFAULT_GROUP_ID,
          DEFAULT_ITEM_INDEX,
          yieldRateUpdated.effectiveDay,
          yieldRateUpdated.tierRates,
          yieldRateUpdated.tierCaps
        )
      )
        .to.emit(yieldStreamer, EVENT_NAME_YIELD_RATE_UPDATED)
        .withArgs(
          DEFAULT_GROUP_ID,
          DEFAULT_ITEM_INDEX,
          yieldRateUpdated.effectiveDay,
          yieldRateUpdated.tierRates,
          yieldRateUpdated.tierCaps
        );
    });

    it("Is reverted if the yield rate has invalid effective day", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const yieldRateUpdated: YieldTieredRate = YIELD_RATES[0];

      await expect(
        yieldStreamer.updateYieldRate(
          DEFAULT_GROUP_ID,
          DEFAULT_ITEM_INDEX,
          INCORRECT_EFFECTIVE_DAY_1,
          yieldRateUpdated.tierRates,
          yieldRateUpdated.tierCaps
        )
      ).revertedWithCustomError(yieldStreamer, REVERT_ERROR_IF_YIELD_RATE_INVALID_EFFECTIVE_DATE);
    });

    it("Is reverted if the provided item index is incorrect", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const yieldRateUpdated: YieldTieredRate = YIELD_RATES[2];

      await expect(
        yieldStreamer.updateYieldRate(
          DEFAULT_GROUP_ID,
          INCORRECT_ITEM_INDEX,
          yieldRateUpdated.effectiveDay,
          yieldRateUpdated.tierRates,
          yieldRateUpdated.tierCaps
        )
      ).revertedWithCustomError(yieldStreamer, REVERT_ERROR_IF_YIELD_RATE_INVALID_ITEM_INDEX);
    });

    it("Is reverted if the provided effective day is invalid", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);

      await expect(
        yieldStreamer.updateYieldRate(
          DEFAULT_GROUP_ID,
          1,
          YIELD_RATES[1].effectiveDay - INCORRECT_EFFECTIVE_DAY_1,
          YIELD_RATES[1].tierRates,
          YIELD_RATES[1].tierCaps
        )
      ).to.be.revertedWithCustomError(yieldStreamer, REVERT_ERROR_IF_YIELD_RATE_INVALID_EFFECTIVE_DATE);

      await expect(
        yieldStreamer.updateYieldRate(
          DEFAULT_GROUP_ID,
          1,
          YIELD_RATES[1].effectiveDay + INCORRECT_EFFECTIVE_DAY_1,
          YIELD_RATES[1].tierRates,
          YIELD_RATES[1].tierCaps
        )
      ).to.be.revertedWithCustomError(yieldStreamer, REVERT_ERROR_IF_YIELD_RATE_INVALID_EFFECTIVE_DATE);

      await expect(
        yieldStreamer.updateYieldRate(
          DEFAULT_GROUP_ID,
          2,
          YIELD_RATES[2].effectiveDay - INCORRECT_EFFECTIVE_DAY_1,
          YIELD_RATES[2].tierRates,
          YIELD_RATES[2].tierCaps
        )
      ).to.be.revertedWithCustomError(yieldStreamer, REVERT_ERROR_IF_YIELD_RATE_INVALID_EFFECTIVE_DATE);
    });
  });

  //_assignSingleAccountToGroup - NOT USING at all
  //
  // describe("Function '_assignSingleAccountToGroup() ----- '", async () => {
  //   it("Executes as expected", async () => {
  //     const { yieldStreamer } = await setUpFixture(deployContracts);
  //     await expect(yieldStreamer.assignSingleAccountToGroup(1, user1.address))
  //       .to.emit(yieldStreamer, EVENT_NAME_GROUP_ASSIGNED)
  //       .withArgs(user1.address, 1, 0);
  //   });
  //
  //   it("Executes as expected if account has the same group ID", async () => {
  //     const { yieldStreamer } = await setUpFixture(deployContracts);
  //     await proveTx(yieldStreamer.assignSingleAccountToGroup(1, user1.address));
  //     await expect(yieldStreamer.assignSingleAccountToGroup(1, user1.address)).to.not.emit(
  //       yieldStreamer,
  //       EVENT_NAME_GROUP_ASSIGNED
  //     );
  //   });
  // });

  describe("Function 'assignGroup()'", async () => {
    it("Executes as expected", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const accounts = [user1.address];
      let forceYieldAccrue = true;

      await expect(yieldStreamer.assignGroup(TEST_GROUP_ID, accounts, forceYieldAccrue))
        .to.emit(yieldStreamer, EVENT_NAME_GROUP_ASSIGNED)
        .withArgs(user1.address, TEST_GROUP_ID, DEFAULT_GROUP_ID);

      const accountsNotAccrue = [user2.address];
      forceYieldAccrue = false;

      await expect(
        yieldStreamer.assignGroup(TEST_GROUP_ID, accountsNotAccrue, forceYieldAccrue)
      )
        .and.to.emit(yieldStreamer, EVENT_NAME_GROUP_ASSIGNED)
        .withArgs(user2.address, TEST_GROUP_ID, DEFAULT_GROUP_ID)
        .to.not.emit(yieldStreamer, EVENT_NAME_YIELD_ACCRUED);
    });

    it("Is reverted if group already assigned", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const accounts = [user1.address];
      const forceYieldAccrue = true;
      await proveTx(yieldStreamer.assignGroup(TEST_GROUP_ID, accounts, forceYieldAccrue));

      await expect(yieldStreamer.assignGroup(TEST_GROUP_ID, accounts, forceYieldAccrue))
        .to.be.revertedWithCustomError(yieldStreamer, REVERT_ERROR_IF_GROUP_ALREADY_ASSIGNED)
        .withArgs(user1.address);
    });
  });

  describe("Function 'setFeeReceiver - _setFeeReceiver ()'", async () => {
    it("Executes as expected", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      await expect(yieldStreamer.setFeeReceiver(feeReceiver))
        .to.emit(yieldStreamer, EVENT_NAME_FEE_RECEIVER_CHANGED)
        .withArgs(feeReceiver, ethers.ZeroAddress);
    });

    it("Is revert if provided receiver is the same as current", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);
      await proveTx(yieldStreamer.setFeeReceiver(feeReceiver));

      await expect(yieldStreamer.setFeeReceiver(feeReceiver)).revertedWithCustomError(
        yieldStreamer,
        REVERT_ERROR_IF_FEE_RECEIVER_ALREADY_CONFIGURED
      );
    });
  });
  describe("Function 'blockTimestamp'", async () => {
    it("Executes as expected", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);
      const currentBlockTimestamp = await getLatestBlockTimestamp();

      expect(await yieldStreamer.blockTimestamp()).to.equal(
        currentBlockTimestamp - NEGATIVE_TIME_SHIFT
      );
    });
  });
});
