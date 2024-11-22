import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { Contract, ContractFactory } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { connect, getAddress, proveTx } from "../test-utils/eth";
import { maxUintForBits, setUpFixture } from "../test-utils/common";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

const ZERO_ADDRESS = ethers.ZeroAddress;

interface RateTier {
  rate: bigint;
  cap: bigint;
}

interface YieldRate {
  tiers: RateTier[];
  effectiveDay: bigint;
}

// Interface representing a yield rate change in the contract
interface InputYieldRate {
  effectiveDay: bigint; // Day when the yield rate becomes effective
  tierRates: bigint[]; // Array of yield rate value for each tier (expressed in RATE_FACTOR units)
  tierCaps: bigint[]; // Array of balance cap for each tier
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

function convertYieldRate(inputYieldRate: InputYieldRate): YieldRate {
  const rateTiers: RateTier[] = [];
  for (let i = 0; i < inputYieldRate.tierRates.length; ++i) {
    const rateTier: RateTier = {
      rate: inputYieldRate.tierRates[i],
      cap: inputYieldRate.tierCaps[i]
    };
    rateTiers.push(rateTier);
  }
  return {
    tiers: rateTiers,
    effectiveDay: inputYieldRate.effectiveDay
  };
}

describe("Contract 'YieldStreamer', the configuration part", async () => {
  const EVENT_NAME_GROUP_ASSIGNED = "YieldStreamer_GroupAssigned";
  const EVENT_NAME_YIELD_RATE_ADDED = "YieldStreamer_YieldRateAdded";
  const EVENT_NAME_YIELD_RATE_UPDATED = "YieldStreamer_YieldRateUpdated";
  const EVENT_NAME_FEE_RECEIVER_CHANGED = "YieldStreamer_FeeReceiverChanged";
  const EVENT_NAME_YIELD_ACCRUED = "YieldStreamer_YieldAccrued";

  const REVERT_ERROR_IF_YIELD_RATE_INVALID_ITEM_INDEX = "YieldStreamer_YieldRateInvalidItemIndex";
  const REVERT_ERROR_IF_YIELD_RATE_INVALID_EFFECTIVE_DATE = "YieldStreamer_YieldRateInvalidEffectiveDay";
  const REVERT_ERROR_IF_FEE_RECEIVER_ALREADY_CONFIGURED = "YieldStreamer_FeeReceiverAlreadyConfigured";
  const REVERT_ERROR_IF_GROUP_ALREADY_ASSIGNED = "YieldStreamer_GroupAlreadyAssigned";
  const REVERT_ERROR_IF_UNAUTHORIZED_ACCOUNT = "AccessControlUnauthorizedAccount";

  const GROUP_ID = 4294967295n;
  const EFFECTIVE_DAY_NON_ZERO = 1;
  const INPUT_YIELD_RATES: InputYieldRate[] = [
    {
      effectiveDay: 0n, // min uint16
      tierRates: [0n, 0n], // min uint48
      tierCaps: [100n, 0n] // min uint64
    },
    {
      effectiveDay: maxUintForBits(15), // middle uint16
      tierRates: [maxUintForBits(47), maxUintForBits(47)], // middle uint48
      tierCaps: [maxUintForBits(63), maxUintForBits(63)] // middle uint64
    },
    {
      effectiveDay: maxUintForBits(16), // max uint16
      tierRates: [maxUintForBits(48), maxUintForBits(48)], // max uint48
      tierCaps: [maxUintForBits(64), maxUintForBits(64)] // max uint64
    }
  ];
  const YIELD_RATES: YieldRate[] = INPUT_YIELD_RATES.map(convertYieldRate);

  let yieldStreamerConfigurationFactory: ContractFactory;
  let feeReceiver: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;

  // Get the signer representing the test user before the tests run
  before(async () => {
    [feeReceiver, user1, user2] = await ethers.getSigners();

    // Contract factories with the explicitly specified deployer account
    yieldStreamerConfigurationFactory = await ethers.getContractFactory("YieldStreamer");
  });

  async function deployContracts(): Promise<{ yieldStreamer: Contract }> {
    const tokenMockFactory = await ethers.getContractFactory("ERC20TokenMock");

    const tokenMock = await tokenMockFactory.deploy("Mock Token", "MTK");
    await tokenMock.waitForDeployment();

    const yieldStreamer: Contract = await upgrades.deployProxy(
      yieldStreamerConfigurationFactory,
      [getAddress(tokenMock)]
    );
    await yieldStreamer.waitForDeployment();

    return { yieldStreamer };
  }

  async function addYieldRates(yieldStreamer: Contract, yieldRates: InputYieldRate[], groupId: bigint = GROUP_ID) {
    for (const yieldRate of yieldRates) {
      await proveTx(yieldStreamer.addYieldRate(
        groupId,
        yieldRate.effectiveDay,
        yieldRate.tierRates,
        yieldRate.tierCaps
      ));
    }
  }

  async function deployAndConfigureContracts(): Promise<{ yieldStreamer: Contract }> {
    const { yieldStreamer } = await deployContracts();
    await addYieldRates(yieldStreamer, INPUT_YIELD_RATES);
    return { yieldStreamer };
  }

  async function getGroupsForAccounts(contract: Contract, accountAddresses: string[]): Promise<bigint[]> {
    const actualGroups: bigint[] = [];
    for (const accountAddress of accountAddresses) {
      actualGroups.push(await contract.getAccountGroup(accountAddress));
    }
    return actualGroups;
  }

  describe("Function 'addYieldRate()'", async () => {
    it("Executes as expected", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // Add first yield rate with the zero effective day
      await expect(
        yieldStreamer.addYieldRate(
          GROUP_ID,
          INPUT_YIELD_RATES[0].effectiveDay,
          INPUT_YIELD_RATES[0].tierRates,
          INPUT_YIELD_RATES[0].tierCaps
        )
      ).to.emit(
        yieldStreamer,
        EVENT_NAME_YIELD_RATE_ADDED
      ).withArgs(
        GROUP_ID,
        INPUT_YIELD_RATES[0].effectiveDay,
        INPUT_YIELD_RATES[0].tierRates,
        INPUT_YIELD_RATES[0].tierCaps
      );
      const actualRates1: YieldRate[] = (await yieldStreamer.getGroupYieldRates(GROUP_ID)).map(normalizeYieldRate);
      const expectedRates1: YieldRate[] = [YIELD_RATES[0]];
      expect(actualRates1).to.deep.equal(expectedRates1);

      // Add second yield rate with a non-zero effective day
      await expect(
        yieldStreamer.addYieldRate(
          GROUP_ID,
          INPUT_YIELD_RATES[1].effectiveDay,
          INPUT_YIELD_RATES[1].tierRates,
          INPUT_YIELD_RATES[1].tierCaps
        )
      ).to.emit(
        yieldStreamer,
        EVENT_NAME_YIELD_RATE_ADDED
      ).withArgs(
        GROUP_ID,
        INPUT_YIELD_RATES[1].effectiveDay,
        INPUT_YIELD_RATES[1].tierRates,
        INPUT_YIELD_RATES[1].tierCaps
      );
      const actualRates2: YieldRate[] = (await yieldStreamer.getGroupYieldRates(GROUP_ID)).map(normalizeYieldRate);
      const expectedRates2 = [YIELD_RATES[0], YIELD_RATES[1]];
      expect(actualRates2).to.deep.equal(expectedRates2);
    });

    it("Is reverted if the first added rate object has a non-zero effective day", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      await expect(
        yieldStreamer.addYieldRate(
          GROUP_ID,
          EFFECTIVE_DAY_NON_ZERO,
          INPUT_YIELD_RATES[0].tierRates,
          INPUT_YIELD_RATES[0].tierCaps
        )
      ).revertedWithCustomError(yieldStreamer, REVERT_ERROR_IF_YIELD_RATE_INVALID_EFFECTIVE_DATE);
    });

    it("Is reverted if the new eff. day is not greater than the eff. day of the previous rate object", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);
      await addYieldRates(yieldStreamer, [INPUT_YIELD_RATES[0], INPUT_YIELD_RATES[1]]);
      const newYieldRate: InputYieldRate = { ...INPUT_YIELD_RATES[1] };
      newYieldRate.effectiveDay = INPUT_YIELD_RATES[1].effectiveDay;

      await expect(
        yieldStreamer.addYieldRate(
          GROUP_ID,
          newYieldRate.effectiveDay,
          newYieldRate.tierRates,
          newYieldRate.tierCaps
        )
      ).revertedWithCustomError(yieldStreamer, REVERT_ERROR_IF_YIELD_RATE_INVALID_EFFECTIVE_DATE);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);
      const yieldRate = INPUT_YIELD_RATES[0];

      await expect(
        connect(yieldStreamer, user2).addYieldRate(
          GROUP_ID,
          yieldRate.effectiveDay,
          yieldRate.tierRates,
          yieldRate.tierCaps
        )
      ).revertedWithCustomError(yieldStreamer, REVERT_ERROR_IF_UNAUTHORIZED_ACCOUNT);
    });
  });

  describe("Function 'updateYieldRate()'", async () => {
    it("Executes as expected", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const itemIndex = 1;
      const inputRateUpdated: InputYieldRate = { ...INPUT_YIELD_RATES[itemIndex] };
      inputRateUpdated.effectiveDay = (INPUT_YIELD_RATES[0].effectiveDay + INPUT_YIELD_RATES[1].effectiveDay) / 2n;
      inputRateUpdated.tierRates = INPUT_YIELD_RATES[0].tierRates;
      inputRateUpdated.tierCaps = INPUT_YIELD_RATES[2].tierCaps;

      await expect(
        yieldStreamer.updateYieldRate(
          GROUP_ID,
          itemIndex,
          inputRateUpdated.effectiveDay,
          inputRateUpdated.tierRates,
          inputRateUpdated.tierCaps
        )
      ).to.emit(
        yieldStreamer,
        EVENT_NAME_YIELD_RATE_UPDATED
      ).withArgs(
        GROUP_ID,
        itemIndex,
        inputRateUpdated.effectiveDay,
        inputRateUpdated.tierRates,
        inputRateUpdated.tierCaps
      );
      const actualRates: YieldRate[] = (await yieldStreamer.getGroupYieldRates(GROUP_ID)).map(normalizeYieldRate);
      const storedRateUpdated = convertYieldRate(inputRateUpdated);
      const expectedRates: YieldRate[] = [YIELD_RATES[0], storedRateUpdated, YIELD_RATES[2]];
      expect(actualRates).to.deep.equal(expectedRates);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);
      const itemIndex = 1;
      const inputRateUpdated: InputYieldRate = { ...INPUT_YIELD_RATES[itemIndex] };
      inputRateUpdated.effectiveDay = (INPUT_YIELD_RATES[0].effectiveDay + INPUT_YIELD_RATES[1].effectiveDay) / 2n;
      inputRateUpdated.tierRates = INPUT_YIELD_RATES[0].tierRates;
      inputRateUpdated.tierCaps = INPUT_YIELD_RATES[2].tierCaps;

      await expect(
        connect(yieldStreamer, user2).updateYieldRate(
          GROUP_ID,
          itemIndex,
          inputRateUpdated.effectiveDay,
          inputRateUpdated.tierRates,
          inputRateUpdated.tierCaps
        )
      ).revertedWithCustomError(yieldStreamer, REVERT_ERROR_IF_UNAUTHORIZED_ACCOUNT);
    });

    it("Is reverted if the provided rate object has an invalid effective day", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const inputRateUpdated: InputYieldRate = INPUT_YIELD_RATES[0];
      const itemIndex = 0;

      await expect(
        yieldStreamer.updateYieldRate(
          GROUP_ID,
          itemIndex,
          EFFECTIVE_DAY_NON_ZERO,
          inputRateUpdated.tierRates,
          inputRateUpdated.tierCaps
        )
      ).revertedWithCustomError(yieldStreamer, REVERT_ERROR_IF_YIELD_RATE_INVALID_EFFECTIVE_DATE);
    });

    it("Is reverted if the provided item index is invalid", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const inputRateUpdated: InputYieldRate = INPUT_YIELD_RATES[2];
      const invalidItemIndex = INPUT_YIELD_RATES.length;

      await expect(
        yieldStreamer.updateYieldRate(
          GROUP_ID,
          invalidItemIndex,
          inputRateUpdated.effectiveDay,
          inputRateUpdated.tierRates,
          inputRateUpdated.tierCaps
        )
      ).revertedWithCustomError(yieldStreamer, REVERT_ERROR_IF_YIELD_RATE_INVALID_ITEM_INDEX);
    });

    it("Is reverted if the provided effective day is invalid", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      let itemIndex = 1;

      await expect(
        yieldStreamer.updateYieldRate(
          GROUP_ID,
          itemIndex,
          INPUT_YIELD_RATES[itemIndex - 1].effectiveDay,
          INPUT_YIELD_RATES[itemIndex].tierRates,
          INPUT_YIELD_RATES[itemIndex].tierCaps
        )
      ).to.be.revertedWithCustomError(yieldStreamer, REVERT_ERROR_IF_YIELD_RATE_INVALID_EFFECTIVE_DATE);

      await expect(
        yieldStreamer.updateYieldRate(
          GROUP_ID,
          itemIndex,
          INPUT_YIELD_RATES[itemIndex + 1].effectiveDay,
          INPUT_YIELD_RATES[itemIndex].tierRates,
          INPUT_YIELD_RATES[itemIndex].tierCaps
        )
      ).to.be.revertedWithCustomError(yieldStreamer, REVERT_ERROR_IF_YIELD_RATE_INVALID_EFFECTIVE_DATE);

      itemIndex = 2;
      await expect(
        yieldStreamer.updateYieldRate(
          GROUP_ID,
          itemIndex,
          INPUT_YIELD_RATES[itemIndex - 1].effectiveDay,
          INPUT_YIELD_RATES[itemIndex].tierRates,
          INPUT_YIELD_RATES[itemIndex].tierCaps
        )
      ).to.be.revertedWithCustomError(yieldStreamer, REVERT_ERROR_IF_YIELD_RATE_INVALID_EFFECTIVE_DATE);
    });
  });

  // _assignSingleAccountToGroup - NOT USING at all
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
      const { yieldStreamer } = await setUpFixture(deployContracts);
      await addYieldRates(yieldStreamer, [INPUT_YIELD_RATES[0]], GROUP_ID);
      await addYieldRates(yieldStreamer, [INPUT_YIELD_RATES[0]], 0n);

      let accounts = [user1.address];
      let forceYieldAccrue = false;

      let tx = yieldStreamer.assignGroup(GROUP_ID, accounts, forceYieldAccrue);

      await expect(tx)
        .to.emit(yieldStreamer, EVENT_NAME_GROUP_ASSIGNED)
        .withArgs(user1.address, GROUP_ID, 0n);
      await expect(tx).not.to.emit(yieldStreamer, EVENT_NAME_YIELD_ACCRUED);

      let actualGroups = await getGroupsForAccounts(yieldStreamer, accounts);
      expect(actualGroups).to.deep.equal([GROUP_ID]);

      const newGroup = GROUP_ID - 1n;
      accounts = [user1.address, user2.address];
      forceYieldAccrue = true;

      tx = yieldStreamer.assignGroup(newGroup, accounts, forceYieldAccrue);

      await expect(tx)
        .to.emit(yieldStreamer, EVENT_NAME_GROUP_ASSIGNED)
        .withArgs(accounts[0], newGroup, GROUP_ID);
      await expect(tx)
        .to.emit(yieldStreamer, EVENT_NAME_GROUP_ASSIGNED)
        .withArgs(accounts[1], newGroup, 0n);
      await expect(tx)
        .to.emit(yieldStreamer, EVENT_NAME_YIELD_ACCRUED)
        .withArgs(accounts[0], anyValue, anyValue, anyValue, anyValue);
      await expect(tx)
        .to.emit(yieldStreamer, EVENT_NAME_YIELD_ACCRUED)
        .withArgs(accounts[1], anyValue, anyValue, anyValue, anyValue);

      actualGroups = await getGroupsForAccounts(yieldStreamer, accounts);
      expect(actualGroups).to.deep.equal([newGroup, newGroup]);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);
      const accounts = [user1.address];
      const forceYieldAccrue = false;
      await proveTx(yieldStreamer.assignGroup(GROUP_ID, accounts, forceYieldAccrue));

      await expect(
        connect(yieldStreamer, user2).assignGroup(GROUP_ID, accounts, forceYieldAccrue)
      ).revertedWithCustomError(yieldStreamer, REVERT_ERROR_IF_UNAUTHORIZED_ACCOUNT);
    });

    it("Is reverted if group already assigned", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const accounts = [user1.address];
      const forceYieldAccrue = false;
      await proveTx(yieldStreamer.assignGroup(GROUP_ID, accounts, forceYieldAccrue));

      await expect(yieldStreamer.assignGroup(GROUP_ID, accounts, forceYieldAccrue))
        .to.be.revertedWithCustomError(yieldStreamer, REVERT_ERROR_IF_GROUP_ALREADY_ASSIGNED)
        .withArgs(user1.address);
    });
  });

  describe("Function 'setFeeReceiver()'", async () => {
    it("Executes as expected", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // Initial fee receiver setup
      await expect(yieldStreamer.setFeeReceiver(feeReceiver.address))
        .to.emit(yieldStreamer, EVENT_NAME_FEE_RECEIVER_CHANGED)
        .withArgs(feeReceiver.address, ZERO_ADDRESS);

      expect(await yieldStreamer.feeReceiver()).to.equal(feeReceiver.address);

      // Fee receiver reset
      await expect(yieldStreamer.setFeeReceiver(ZERO_ADDRESS))
        .to.emit(yieldStreamer, EVENT_NAME_FEE_RECEIVER_CHANGED)
        .withArgs(ZERO_ADDRESS, feeReceiver.address);

      expect(await yieldStreamer.feeReceiver()).to.equal(ZERO_ADDRESS);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      await expect(
        connect(yieldStreamer, user2).setFeeReceiver(feeReceiver.address)
      ).revertedWithCustomError(yieldStreamer, REVERT_ERROR_IF_UNAUTHORIZED_ACCOUNT);
    });

    it("Is revert if provided receiver is the same as the current one", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // If the current receiver address is zero
      await expect(yieldStreamer.setFeeReceiver(ZERO_ADDRESS)).revertedWithCustomError(
        yieldStreamer,
        REVERT_ERROR_IF_FEE_RECEIVER_ALREADY_CONFIGURED
      );

      // If the current receiver address is non-zero
      await proveTx(yieldStreamer.setFeeReceiver(feeReceiver.address));
      await expect(yieldStreamer.setFeeReceiver(feeReceiver.address)).revertedWithCustomError(
        yieldStreamer,
        REVERT_ERROR_IF_FEE_RECEIVER_ALREADY_CONFIGURED
      );
    });
  });
});
