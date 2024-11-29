import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { Contract, ContractFactory } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { connect, getAddress, proveTx } from "../test-utils/eth";
import { maxUintForBits, setUpFixture } from "../test-utils/common";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

const ERRORS = {
  YieldStreamer_EmptyArray: "YieldStreamer_EmptyArray",
  YieldStreamer_ArrayLengthMismatch: "YieldStreamer_ArrayLengthMismatch",
  YieldStreamer_YieldRateInvalidItemIndex: "YieldStreamer_YieldRateInvalidItemIndex",
  YieldStreamer_YieldRateInvalidEffectiveDay: "YieldStreamer_YieldRateInvalidEffectiveDay",
  YieldStreamer_YieldRateAlreadyConfigured: "YieldStreamer_YieldRateAlreadyConfigured",
  YieldStreamer_FeeReceiverAlreadyConfigured: "YieldStreamer_FeeReceiverAlreadyConfigured",
  YieldStreamer_GroupAlreadyAssigned: "YieldStreamer_GroupAlreadyAssigned",
  AccessControlUnauthorizedAccount: "AccessControlUnauthorizedAccount"
};

const EVENTS = {
  YieldStreamer_GroupAssigned: "YieldStreamer_GroupAssigned",
  YieldStreamer_YieldRateAdded: "YieldStreamer_YieldRateAdded",
  YieldStreamer_YieldRateUpdated: "YieldStreamer_YieldRateUpdated",
  YieldStreamer_FeeReceiverChanged: "YieldStreamer_FeeReceiverChanged",
  YieldStreamer_YieldAccrued: "YieldStreamer_YieldAccrued"
};

const ZERO_ADDRESS = ethers.ZeroAddress;
const GROUP_ID = maxUintForBits(32);
const EFFECTIVE_DAY_NON_ZERO = 1;
const INPUT_YIELD_RATES: InputYieldRate[] = [
  {
    effectiveDay: 0n, // ---- min uint16
    tierRates: [0n, 0n], // - min uint48
    tierCaps: [100n, 0n] // - min uint64
  },
  {
    effectiveDay: maxUintForBits(15), // -------------------- middle uint16
    tierRates: [maxUintForBits(47), maxUintForBits(47)], // - middle uint48
    tierCaps: [maxUintForBits(63), maxUintForBits(63)] // --- middle uint64
  },
  {
    effectiveDay: maxUintForBits(16), // -------------------- max uint16
    tierRates: [maxUintForBits(48), maxUintForBits(48)], // - max uint48
    tierCaps: [maxUintForBits(64), maxUintForBits(64)] // --- max uint64
  }
];
const YIELD_RATES: YieldRate[] = INPUT_YIELD_RATES.map(convertYieldRate);

interface RateTier {
  rate: bigint;
  cap: bigint;
}

interface YieldRate {
  tiers: RateTier[];
  effectiveDay: bigint;
}

interface InputYieldRate {
  effectiveDay: bigint;
  tierRates: bigint[];
  tierCaps: bigint[];
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

describe.only("Contract 'YieldStreamerConfiguration' (part of 'YieldStreamer')", async () => {
  let yieldStreamerFactory: ContractFactory;
  let tokenMockFactory: ContractFactory;
  let deployer: HardhatEthersSigner;
  let feeReceiver: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;

  before(async () => {
    [deployer, feeReceiver, user1, user2] = await ethers.getSigners();
    yieldStreamerFactory = await ethers.getContractFactory("YieldStreamer");
    tokenMockFactory = await ethers.getContractFactory("ERC20TokenMock");
  });

  async function deployContracts(): Promise<{ yieldStreamer: Contract; tokenMock: Contract }> {
    const tokenMock: Contract = (await tokenMockFactory.deploy("Mock Token", "MTK")) as Contract;
    await tokenMock.waitForDeployment();

    let yieldStreamer: Contract = (await upgrades.deployProxy(yieldStreamerFactory, [
      getAddress(tokenMock)
    ])) as Contract;
    await yieldStreamer.waitForDeployment();
    yieldStreamer = connect(yieldStreamer, deployer); // Connect explicitly

    return { yieldStreamer, tokenMock };
  }

  async function deployAndConfigureContracts(): Promise<{ yieldStreamer: Contract; tokenMock: Contract }> {
    const { yieldStreamer, tokenMock } = await deployContracts();
    await addYieldRates(yieldStreamer, INPUT_YIELD_RATES, GROUP_ID);
    return { yieldStreamer, tokenMock };
  }

  async function addYieldRates(yieldStreamer: Contract, yieldRates: InputYieldRate[], groupId: bigint) {
    for (const yieldRate of yieldRates) {
      await proveTx(
        yieldStreamer.addYieldRate(groupId, yieldRate.effectiveDay, yieldRate.tierRates, yieldRate.tierCaps)
      );
    }
  }

  async function getGroupsForAccounts(yieldStreamer: Contract, accounts: string[]): Promise<bigint[]> {
    const actualGroups: bigint[] = [];
    for (const account of accounts) {
      actualGroups.push(await yieldStreamer.getAccountGroup(account));
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
      )
        .to.emit(yieldStreamer, EVENTS.YieldStreamer_YieldRateAdded)
        .withArgs(
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
      )
        .to.emit(yieldStreamer, EVENTS.YieldStreamer_YieldRateAdded)
        .withArgs(
          GROUP_ID,
          INPUT_YIELD_RATES[1].effectiveDay,
          INPUT_YIELD_RATES[1].tierRates,
          INPUT_YIELD_RATES[1].tierCaps
        );
      const actualRates2: YieldRate[] = (await yieldStreamer.getGroupYieldRates(GROUP_ID)).map(normalizeYieldRate);
      const expectedRates2 = [YIELD_RATES[0], YIELD_RATES[1]];
      expect(actualRates2).to.deep.equal(expectedRates2);
    });

    it("Reverts if the caller does not have the owner role", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);
      const yieldRate = INPUT_YIELD_RATES[0];

      await expect(
        connect(yieldStreamer, user1).addYieldRate(
          GROUP_ID,
          yieldRate.effectiveDay,
          yieldRate.tierRates,
          yieldRate.tierCaps
        )
      ).revertedWithCustomError(yieldStreamer, ERRORS.AccessControlUnauthorizedAccount);
    });

    it("Reverts if tier rates and tier caps arrays are empty", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);
      const emptyArray: bigint[] = [];

      await expect(yieldStreamer.addYieldRate(GROUP_ID, 0n, emptyArray, emptyArray)).to.be.revertedWithCustomError(
        yieldStreamer,
        ERRORS.YieldStreamer_EmptyArray
      );
    });

    it("Reverts if tier caps and rates arrays have different lengths", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);
      const tierRates = [100n];
      const tierCaps = [200n, 300n];

      await expect(yieldStreamer.addYieldRate(GROUP_ID, 0n, tierRates, tierCaps)).to.be.revertedWithCustomError(
        yieldStreamer,
        ERRORS.YieldStreamer_ArrayLengthMismatch
      );
    });

    it("Reverts if the first added yield rate has a non-zero effective day", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      await expect(
        yieldStreamer.addYieldRate(
          GROUP_ID,
          EFFECTIVE_DAY_NON_ZERO,
          INPUT_YIELD_RATES[0].tierRates,
          INPUT_YIELD_RATES[0].tierCaps
        )
      ).revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_YieldRateInvalidEffectiveDay);
    });

    it("Reverts if the new eff. day is not greater than the eff. day of the previous rate object", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // Add initial yield rates to the group
      await addYieldRates(yieldStreamer, [INPUT_YIELD_RATES[0], INPUT_YIELD_RATES[1]], GROUP_ID);

      // Create new yield rate with same effective day as previous rate
      const newYieldRate: InputYieldRate = { ...INPUT_YIELD_RATES[2] };
      newYieldRate.effectiveDay = INPUT_YIELD_RATES[1].effectiveDay;

      // Attempt to add yield rate - should revert since effective day is not greater
      await expect(
        yieldStreamer.addYieldRate(GROUP_ID, newYieldRate.effectiveDay, newYieldRate.tierRates, newYieldRate.tierCaps)
      ).revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_YieldRateInvalidEffectiveDay);
    });
  });

  describe("Function 'updateYieldRate()'", async () => {
    it("Executes as expected", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);

      // Set up test parameters
      const itemIndex = 1;
      const inputRateUpdated: InputYieldRate = { ...INPUT_YIELD_RATES[itemIndex] };
      inputRateUpdated.effectiveDay = (INPUT_YIELD_RATES[0].effectiveDay + INPUT_YIELD_RATES[1].effectiveDay) / 2n;
      inputRateUpdated.tierRates = INPUT_YIELD_RATES[0].tierRates;
      inputRateUpdated.tierCaps = INPUT_YIELD_RATES[2].tierCaps;

      // Update the yield rate and verify event emission
      await expect(
        yieldStreamer.updateYieldRate(
          GROUP_ID,
          itemIndex,
          inputRateUpdated.effectiveDay,
          inputRateUpdated.tierRates,
          inputRateUpdated.tierCaps
        )
      )
        .to.emit(yieldStreamer, EVENTS.YieldStreamer_YieldRateUpdated)
        .withArgs(
          GROUP_ID,
          itemIndex,
          inputRateUpdated.effectiveDay,
          inputRateUpdated.tierRates,
          inputRateUpdated.tierCaps
        );

      // Verify the rates array was updated correctly
      const actualRates: YieldRate[] = (await yieldStreamer.getGroupYieldRates(GROUP_ID)).map(normalizeYieldRate);
      const storedRateUpdated = convertYieldRate(inputRateUpdated);
      const expectedRates: YieldRate[] = [YIELD_RATES[0], storedRateUpdated, YIELD_RATES[2]];
      expect(actualRates).to.deep.equal(expectedRates);
    });

    it("Reverts if the caller does not have the owner role", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const itemIndex = 1;

      await expect(
        connect(yieldStreamer, user1).updateYieldRate(
          GROUP_ID,
          itemIndex,
          INPUT_YIELD_RATES[itemIndex].effectiveDay,
          INPUT_YIELD_RATES[itemIndex].tierRates,
          INPUT_YIELD_RATES[itemIndex].tierCaps
        )
      ).revertedWithCustomError(yieldStreamer, ERRORS.AccessControlUnauthorizedAccount);
    });

    it("Reverts if updating yield rate in empty group", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);
      const emptyGroupId = 123n;
      const itemIndex = 0;

      await expect(
        yieldStreamer.updateYieldRate(
          emptyGroupId,
          itemIndex,
          INPUT_YIELD_RATES[0].effectiveDay,
          INPUT_YIELD_RATES[0].tierRates,
          INPUT_YIELD_RATES[0].tierCaps
        )
      ).to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_YieldRateInvalidItemIndex);
    });

    it("Reverts if tier rates and tier caps arrays are empty", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const emptyArray: bigint[] = [];
      const itemIndex = 1;

      await expect(
        yieldStreamer.updateYieldRate(GROUP_ID, itemIndex, 0n, emptyArray, emptyArray)
      ).to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_EmptyArray);
    });

    it("Reverts if tier caps and rates arrays have different lengths", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const tierRates = [100n];
      const tierCaps = [200n, 300n];
      const itemIndex = 1;

      await expect(
        yieldStreamer.updateYieldRate(GROUP_ID, itemIndex, 0n, tierRates, tierCaps)
      ).to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_ArrayLengthMismatch);
    });

    it("Reverts if updating the first rate (index 0) with non-zero effective day", async () => {
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
      ).revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_YieldRateInvalidEffectiveDay);
    });

    it("Reverts if the provided item index is greater than the length of the rates array", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const inputRateUpdated: InputYieldRate = INPUT_YIELD_RATES[0];
      const invalidItemIndex = INPUT_YIELD_RATES.length;

      await expect(
        yieldStreamer.updateYieldRate(
          GROUP_ID,
          invalidItemIndex,
          inputRateUpdated.effectiveDay,
          inputRateUpdated.tierRates,
          inputRateUpdated.tierCaps
        )
      ).revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_YieldRateInvalidItemIndex);
    });

    it("Reverts when updating yield rate with an invalid effective day", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      let itemIndex = 0;

      // Reverts when trying to set effective day equal to previous rate
      itemIndex = 1;
      await expect(
        yieldStreamer.updateYieldRate(
          GROUP_ID,
          itemIndex,
          INPUT_YIELD_RATES[itemIndex - 1].effectiveDay,
          INPUT_YIELD_RATES[itemIndex].tierRates,
          INPUT_YIELD_RATES[itemIndex].tierCaps
        )
      ).to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_YieldRateInvalidEffectiveDay);

      // Reverts when trying to set effective day lower than previous rate
      itemIndex = 2;
      await expect(
        yieldStreamer.updateYieldRate(
          GROUP_ID,
          itemIndex,
          INPUT_YIELD_RATES[itemIndex - 1].effectiveDay - 1n,
          INPUT_YIELD_RATES[itemIndex].tierRates,
          INPUT_YIELD_RATES[itemIndex].tierCaps
        )
      ).to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_YieldRateInvalidEffectiveDay);

      // Reverts when trying to set effective day equal to next rate
      itemIndex = 1;
      await expect(
        yieldStreamer.updateYieldRate(
          GROUP_ID,
          itemIndex,
          INPUT_YIELD_RATES[itemIndex + 1].effectiveDay,
          INPUT_YIELD_RATES[itemIndex].tierRates,
          INPUT_YIELD_RATES[itemIndex].tierCaps
        )
      ).to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_YieldRateInvalidEffectiveDay);

      // Reverts when trying to set effective day higher than next rate
      itemIndex = 1;
      await expect(
        yieldStreamer.updateYieldRate(
          GROUP_ID,
          itemIndex,
          INPUT_YIELD_RATES[itemIndex + 1].effectiveDay + 1n,
          INPUT_YIELD_RATES[itemIndex].tierRates,
          INPUT_YIELD_RATES[itemIndex].tierCaps
        )
      ).to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_YieldRateInvalidEffectiveDay);

      // Reverts when trying to set last rate's effective day to previous rate's day
      itemIndex = 1;
      await expect(
        yieldStreamer.updateYieldRate(
          GROUP_ID,
          itemIndex,
          INPUT_YIELD_RATES[itemIndex - 1].effectiveDay,
          INPUT_YIELD_RATES[itemIndex].tierRates,
          INPUT_YIELD_RATES[itemIndex].tierCaps
        )
      ).to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_YieldRateInvalidEffectiveDay);
    });
  });

  describe("Function 'assignMultipleAccountsToGroup()'", async () => {
    it("Executes as expected - empty accounts array", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);
      await addYieldRates(yieldStreamer, [INPUT_YIELD_RATES[0]], GROUP_ID);
      await expect(yieldStreamer.assignMultipleAccountsToGroup(GROUP_ID, [], false)).not.to.be.reverted;
    });

    it("Executes as expected - not empty accounts array", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);
      await addYieldRates(yieldStreamer, [INPUT_YIELD_RATES[0]], 0n);
      await addYieldRates(yieldStreamer, [INPUT_YIELD_RATES[0]], GROUP_ID);

      // Assign one account to the group without yield accrual
      {
        const accounts = [user1.address];
        const forceYieldAccrue = false;
        const tx1 = yieldStreamer.assignMultipleAccountsToGroup(GROUP_ID, accounts, forceYieldAccrue);

        await expect(tx1)
          .to.emit(yieldStreamer, EVENTS.YieldStreamer_GroupAssigned)
          .withArgs(user1.address, GROUP_ID, 0n);
        await expect(tx1).not.to.emit(yieldStreamer, EVENTS.YieldStreamer_YieldAccrued);

        const actualGroups1 = await getGroupsForAccounts(yieldStreamer, accounts);
        expect(actualGroups1).to.deep.equal([GROUP_ID]);
      }

      // Assign two accounts to the new group with yield accrual
      {
        const newGroup = GROUP_ID - 1n;
        const accounts = [user1.address, user2.address];
        const forceYieldAccrue = true;

        const tx2 = yieldStreamer.assignMultipleAccountsToGroup(newGroup, accounts, forceYieldAccrue);

        await expect(tx2)
          .to.emit(yieldStreamer, EVENTS.YieldStreamer_GroupAssigned)
          .withArgs(accounts[0], newGroup, GROUP_ID);
        await expect(tx2)
          .to.emit(yieldStreamer, EVENTS.YieldStreamer_GroupAssigned)
          .withArgs(accounts[1], newGroup, 0n);
        await expect(tx2)
          .to.emit(yieldStreamer, EVENTS.YieldStreamer_YieldAccrued)
          .withArgs(accounts[0], anyValue, anyValue, anyValue, anyValue);
        await expect(tx2)
          .to.emit(yieldStreamer, EVENTS.YieldStreamer_YieldAccrued)
          .withArgs(accounts[1], anyValue, anyValue, anyValue, anyValue);

        const actualGroups2 = await getGroupsForAccounts(yieldStreamer, accounts);
        expect(actualGroups2).to.deep.equal([newGroup, newGroup]);
      }
    });

    it("Reverts if the caller does not have the owner role", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);
      const accounts = [user1.address];
      const forceYieldAccrue = false;

      await proveTx(yieldStreamer.assignMultipleAccountsToGroup(GROUP_ID, accounts, forceYieldAccrue));

      await expect(
        connect(yieldStreamer, user1).assignMultipleAccountsToGroup(GROUP_ID, accounts, forceYieldAccrue)
      ).revertedWithCustomError(yieldStreamer, ERRORS.AccessControlUnauthorizedAccount);
    });

    it("Reverts if the group is already assigned - no duplicates", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const accounts = [user1.address];
      const forceYieldAccrue = false;

      await proveTx(yieldStreamer.assignMultipleAccountsToGroup(GROUP_ID, accounts, forceYieldAccrue));

      await expect(yieldStreamer.assignMultipleAccountsToGroup(GROUP_ID, accounts, forceYieldAccrue))
        .to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_GroupAlreadyAssigned)
        .withArgs(user1.address);
    });

    it("Reverts if the group is already assigned - with duplicates", async () => {
      const { yieldStreamer } = await setUpFixture(deployAndConfigureContracts);
      const accounts = [user1.address, user2.address, user1.address];
      const forceYieldAccrue = false;

      await expect(yieldStreamer.assignMultipleAccountsToGroup(GROUP_ID, accounts, forceYieldAccrue))
        .to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_GroupAlreadyAssigned)
        .withArgs(user1.address);
    });
  });

  describe("Function 'setFeeReceiver()'", async () => {
    it("Executes as expected", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // Initial fee receiver setup
      await expect(yieldStreamer.setFeeReceiver(feeReceiver.address))
        .to.emit(yieldStreamer, EVENTS.YieldStreamer_FeeReceiverChanged)
        .withArgs(feeReceiver.address, ZERO_ADDRESS);

      // Prove that the receiver is set
      expect(await yieldStreamer.feeReceiver()).to.equal(feeReceiver.address);

      // Fee receiver reset
      await expect(yieldStreamer.setFeeReceiver(ZERO_ADDRESS))
        .to.emit(yieldStreamer, EVENTS.YieldStreamer_FeeReceiverChanged)
        .withArgs(ZERO_ADDRESS, feeReceiver.address);

      // Prove that the receiver is reset
      expect(await yieldStreamer.feeReceiver()).to.equal(ZERO_ADDRESS);
    });

    it("Reverts if the caller does not have the owner role", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      await expect(connect(yieldStreamer, user1).setFeeReceiver(feeReceiver.address)).revertedWithCustomError(
        yieldStreamer,
        ERRORS.AccessControlUnauthorizedAccount
      );
    });

    it("Reverts if provided receiver is the same as the current one", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // Prove that the receiver is zero
      expect(await yieldStreamer.feeReceiver()).to.equal(ZERO_ADDRESS);

      // Set the receiver to zero
      await expect(yieldStreamer.setFeeReceiver(ZERO_ADDRESS)).revertedWithCustomError(
        yieldStreamer,
        ERRORS.YieldStreamer_FeeReceiverAlreadyConfigured
      );

      // Set the receiver to the non-zero address
      await proveTx(yieldStreamer.setFeeReceiver(feeReceiver.address));

      // Try to set the receiver to the same non-zero address
      await expect(yieldStreamer.setFeeReceiver(feeReceiver.address)).revertedWithCustomError(
        yieldStreamer,
        ERRORS.YieldStreamer_FeeReceiverAlreadyConfigured
      );
    });
  });

  describe("Function 'getGroupYieldRates()'", async () => {
    it("Executes as expected - empty group", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);
      const emptyGroupId = 123n;

      const actualRates = (await yieldStreamer.getGroupYieldRates(emptyGroupId)).map(normalizeYieldRate);
      expect(actualRates).to.deep.equal([]);
    });

    it("Executes as expected - group with single yield rate", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // Add single yield rate
      await addYieldRates(yieldStreamer, [INPUT_YIELD_RATES[0]], GROUP_ID);

      const actualRates = (await yieldStreamer.getGroupYieldRates(GROUP_ID)).map(normalizeYieldRate);
      const expectedRates = [YIELD_RATES[0]];
      expect(actualRates).to.deep.equal(expectedRates);
    });

    it("Executes as expected - group with multiple yield rates", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // Add multiple yield rates
      await addYieldRates(yieldStreamer, INPUT_YIELD_RATES, GROUP_ID);

      const actualRates = (await yieldStreamer.getGroupYieldRates(GROUP_ID)).map(normalizeYieldRate);
      const expectedRates = YIELD_RATES;
      expect(actualRates).to.deep.equal(expectedRates);
    });

    it("Returns different rates for different groups", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);
      const otherGroupId = GROUP_ID - 1n;

      // Create a new yield rate with effectiveDay = 0 for the second group
      const otherGroupRate = {
        ...INPUT_YIELD_RATES[1],
        effectiveDay: 0n
      };

      // Add different rates to different groups
      await addYieldRates(yieldStreamer, [INPUT_YIELD_RATES[0]], GROUP_ID);
      await addYieldRates(yieldStreamer, [otherGroupRate], otherGroupId);

      const group1Rates = (await yieldStreamer.getGroupYieldRates(GROUP_ID)).map(normalizeYieldRate);
      const group2Rates = (await yieldStreamer.getGroupYieldRates(otherGroupId)).map(normalizeYieldRate);

      expect(group1Rates).to.deep.equal([YIELD_RATES[0]]);
      expect(group2Rates).to.deep.equal([convertYieldRate(otherGroupRate)]);
      expect(group1Rates).to.not.deep.equal(group2Rates);
    });
  });

  describe("Function 'getAccountYieldRates()'", async () => {
    it("Executes as expected - account with no group assigned", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      const actualRates = (await yieldStreamer.getAccountYieldRates(user1.address)).map(normalizeYieldRate);
      expect(actualRates).to.deep.equal([]);
    });

    it("Executes as expected - account with empty group", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);
      const emptyGroupId = 123n;

      // Assign account to empty group
      await proveTx(yieldStreamer.assignMultipleAccountsToGroup(emptyGroupId, [user1.address], false));

      const actualRates = (await yieldStreamer.getAccountYieldRates(user1.address)).map(normalizeYieldRate);
      expect(actualRates).to.deep.equal([]);
    });

    it("Executes as expected - account with single yield rate", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // Add single yield rate to group and assign account
      await addYieldRates(yieldStreamer, [INPUT_YIELD_RATES[0]], GROUP_ID);
      await proveTx(yieldStreamer.assignMultipleAccountsToGroup(GROUP_ID, [user1.address], false));

      const actualRates = (await yieldStreamer.getAccountYieldRates(user1.address)).map(normalizeYieldRate);
      const expectedRates = [YIELD_RATES[0]];
      expect(actualRates).to.deep.equal(expectedRates);
    });

    it("Executes as expected - account with multiple yield rates", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // Add multiple yield rates to group and assign account
      await addYieldRates(yieldStreamer, INPUT_YIELD_RATES, GROUP_ID);
      await proveTx(yieldStreamer.assignMultipleAccountsToGroup(GROUP_ID, [user1.address], false));

      const actualRates = (await yieldStreamer.getAccountYieldRates(user1.address)).map(normalizeYieldRate);
      const expectedRates = YIELD_RATES;
      expect(actualRates).to.deep.equal(expectedRates);
    });

    it("Returns different rates for accounts in different groups", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);
      const otherGroupId = GROUP_ID - 1n;

      // Create a new yield rate with effectiveDay = 0 for the second group
      const otherGroupRate = {
        ...INPUT_YIELD_RATES[1],
        effectiveDay: 0n
      };

      // Add different rates to different groups and assign accounts
      await addYieldRates(yieldStreamer, [INPUT_YIELD_RATES[0]], GROUP_ID);
      await addYieldRates(yieldStreamer, [otherGroupRate], otherGroupId);
      await proveTx(yieldStreamer.assignMultipleAccountsToGroup(GROUP_ID, [user1.address], false));
      await proveTx(yieldStreamer.assignMultipleAccountsToGroup(otherGroupId, [user2.address], false));

      const account1Rates = (await yieldStreamer.getAccountYieldRates(user1.address)).map(normalizeYieldRate);
      const account2Rates = (await yieldStreamer.getAccountYieldRates(user2.address)).map(normalizeYieldRate);

      expect(account1Rates).to.deep.equal([YIELD_RATES[0]]);
      expect(account2Rates).to.deep.equal([convertYieldRate(otherGroupRate)]);
      expect(account1Rates).to.not.deep.equal(account2Rates);
    });
  });

  describe("Function 'getAccountGroup()'", async () => {
    it("Executes as expected - account with no group assigned", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      const actualGroup = await yieldStreamer.getAccountGroup(user1.address);
      expect(actualGroup).to.equal(0n);
    });

    it("Executes as expected - account with group assigned", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // Assign account to group
      await proveTx(yieldStreamer.assignMultipleAccountsToGroup(GROUP_ID, [user1.address], false));

      const actualGroup = await yieldStreamer.getAccountGroup(user1.address);
      expect(actualGroup).to.equal(GROUP_ID);
    });

    it("Returns different groups for different accounts", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);
      const otherGroupId = GROUP_ID - 1n;

      // Assign accounts to different groups
      await proveTx(yieldStreamer.assignMultipleAccountsToGroup(GROUP_ID, [user1.address], false));
      await proveTx(yieldStreamer.assignMultipleAccountsToGroup(otherGroupId, [user2.address], false));

      const account1Group = await yieldStreamer.getAccountGroup(user1.address);
      const account2Group = await yieldStreamer.getAccountGroup(user2.address);

      expect(account1Group).to.equal(GROUP_ID);
      expect(account2Group).to.equal(otherGroupId);
      expect(account1Group).to.not.equal(account2Group);
    });

    it("Returns updated group after reassignment", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);
      const newGroupId = GROUP_ID - 1n;

      // Initial group assignment
      await proveTx(yieldStreamer.assignMultipleAccountsToGroup(GROUP_ID, [user1.address], false));
      const initialGroup = await yieldStreamer.getAccountGroup(user1.address);
      expect(initialGroup).to.equal(GROUP_ID);

      // Reassign to new group
      await proveTx(yieldStreamer.assignMultipleAccountsToGroup(newGroupId, [user1.address], false));
      const updatedGroup = await yieldStreamer.getAccountGroup(user1.address);
      expect(updatedGroup).to.equal(newGroupId);
    });
  });

  describe("Function 'underlyingToken()'", async () => {
    it("Returns the correct token address", async () => {
      const { yieldStreamer, tokenMock } = await setUpFixture(deployContracts);

      const actualToken = await yieldStreamer.underlyingToken();
      expect(actualToken).to.equal(getAddress(tokenMock));
    });

    it("Returns address matching deployment parameter", async () => {
      // Deploy a new token
      const newToken: Contract = (await tokenMockFactory.deploy("New Token", "NTK")) as Contract;
      await newToken.waitForDeployment();

      // Deploy streamer with new token
      const yieldStreamer = (await upgrades.deployProxy(yieldStreamerFactory, [getAddress(newToken)])) as Contract;
      await yieldStreamer.waitForDeployment();

      const actualToken = await yieldStreamer.underlyingToken();
      expect(actualToken).to.equal(getAddress(newToken));
    });
  });

  describe("Function 'feeReceiver()'", async () => {
    it("Returns zero address by default", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      const actualReceiver = await yieldStreamer.feeReceiver();
      expect(actualReceiver).to.equal(ZERO_ADDRESS);
    });

    it("Returns the correct address after setting", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // Set fee receiver
      await proveTx(yieldStreamer.setFeeReceiver(feeReceiver.address));

      const actualReceiver = await yieldStreamer.feeReceiver();
      expect(actualReceiver).to.equal(feeReceiver.address);
    });

    it("Returns updated address after changing fee receiver", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);

      // Set initial fee receiver
      await proveTx(yieldStreamer.setFeeReceiver(feeReceiver.address));
      const initialReceiver = await yieldStreamer.feeReceiver();
      expect(initialReceiver).to.equal(feeReceiver.address);

      // Change to new fee receiver
      await proveTx(yieldStreamer.setFeeReceiver(user1.address));
      const updatedReceiver = await yieldStreamer.feeReceiver();
      expect(updatedReceiver).to.equal(user1.address);
      expect(updatedReceiver).to.not.equal(initialReceiver);
    });
  });

  describe("Function 'ENABLE_YIELD_STATE_AUTO_INITIALIZATION()'", async () => {
    it("Executes as expected", async () => {
      const { yieldStreamer } = await setUpFixture(deployContracts);
      /**
       * At the moment, the ENABLE_YIELD_STATE_AUTO_INITIALIZATION function is expected to return false,
       * otherwise the yield state will be initialized automatically which means more tests need to be added.
       */
      expect(await yieldStreamer.ENABLE_YIELD_STATE_AUTO_INITIALIZATION()).to.equal(false);
    });
  });
});
