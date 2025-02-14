import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { Contract, ContractFactory } from "ethers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { getAddress, proveTx } from "../test-utils/eth";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const ERRORS = {
  YieldStreamer_TimeRangeInvalid: "YieldStreamer_TimeRangeInvalid",
  YieldStreamer_YieldBalanceInsufficient: "YieldStreamer_YieldBalanceInsufficient",
  YieldStreamer_HookCallerUnauthorized: "YieldStreamer_HookCallerUnauthorized",
  YieldStreamer_ClaimAmountNonRounded: "YieldStreamer_ClaimAmountNonRounded",
  YieldStreamer_ClaimAmountBelowMinimum: "YieldStreamer_ClaimAmountBelowMinimum",
  YieldStreamer_FeeReceiverNotConfigured: "YieldStreamer_FeeReceiverNotConfigured",
  YieldStreamer_ImplementationAddressInvalid: "YieldStreamer_ImplementationAddressInvalid",
  YieldStreamer_AccountNotInitialized: "YieldStreamer_AccountNotInitialized",
  YieldStreamer_YieldRateArrayIsEmpty: "YieldStreamer_YieldRateArrayIsEmpty",
  YieldStreamer_NoYieldRatesInRange: "YieldStreamer_NoYieldRatesInRange",
  YieldStreamer_TimeRangeIsInvalid: "YieldStreamer_TimeRangeIsInvalid",
  ERC20InsufficientBalance: "ERC20InsufficientBalance"
};

const NEGATIVE_TIME_SHIFT = 10800n; // 3 hours
const RATE_FACTOR = 1000000000000n; // 10^12
const ROUND_FACTOR = 10000n; // 10^4
// const DAY = 86400n; // 1 day (in seconds)
// const HOUR = 3600n; // 1 hour (in seconds)
// const INITIAL_DAY_INDEX = 21000n; // 21000 days
// const INITIAL_TIMESTAMP = INITIAL_DAY_INDEX * DAY;
const MIN_CLAIM_AMOUNT = 1000000n;

const ADMIN_ROLE: string = ethers.id("ADMIN_ROLE");

// interface YieldState {
//   flags: bigint;
//   streamYield: bigint;
//   accruedYield: bigint;
//   lastUpdateTimestamp: bigint;
//   lastUpdateBalance: bigint;
// }

// interface RateTier {
//   rate: bigint;
//   cap: bigint;
// }

// interface YieldRate {
//   tiers: RateTier[];
//   effectiveDay: bigint;
// }

// interface YieldResult {
//   partialFirstDayYield: bigint;
//   fullDaysYield: bigint;
//   partialLastDayYield: bigint;
//   partialFirstDayYieldTiered: bigint[];
//   fullDaysYieldTiered: bigint[];
//   partialLastDayYieldTiered: bigint[];
// }

// interface AccruePreview {
//   fromTimestamp: bigint;
//   toTimestamp: bigint;
//   balance: bigint;
//   streamYieldBefore: bigint;
//   accruedYieldBefore: bigint;
//   streamYieldAfter: bigint;
//   accruedYieldAfter: bigint;
//   rates: YieldRate[];
//   results: YieldResult[];
// }

// interface ClaimPreview {
//   yield: bigint;
//   fee: bigint;
//   timestamp: bigint;
//   balance: bigint;
//   rates: bigint[];
//   caps: bigint[];
// }

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

interface Fixture {
  yieldStreamer: Contract;
  yieldStreamerV1Mock: Contract;
  tokenMock: Contract;
}

describe("Contract 'YieldStreamerPrimary'", async () => {
  let yieldStreamerFactory: ContractFactory;
  let yieldStreamerV1MockFactory: ContractFactory;
  let tokenMockFactory: ContractFactory;

  let admin: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  before(async () => {
    [, admin, user] = await ethers.getSigners();
    yieldStreamerFactory = await ethers.getContractFactory("YieldStreamer");
    yieldStreamerV1MockFactory = await ethers.getContractFactory("YieldStreamerV1Mock");
    tokenMockFactory = await ethers.getContractFactory("ERC20TokenMock");
  });

  async function deployContracts(): Promise<{
    yieldStreamer: Contract;
    yieldStreamerV1Mock: Contract;
    tokenMock: Contract;
  }> {
    const tokenMock: Contract = (await tokenMockFactory.deploy("Mock Token", "MTK")) as Contract;
    await tokenMock.waitForDeployment();

    const yieldStreamerV1Mock: Contract = (await yieldStreamerV1MockFactory.deploy()) as Contract;
    await yieldStreamerV1Mock.waitForDeployment();

    const yieldStreamer: Contract = (await upgrades.deployProxy(yieldStreamerFactory, [
      getAddress(tokenMock)
    ])) as Contract;
    await yieldStreamer.waitForDeployment();

    await yieldStreamer.setSourceYieldStreamer(getAddress(yieldStreamerV1Mock));
    await yieldStreamerV1Mock.setBlocklister(getAddress(yieldStreamer), true);
    await yieldStreamer.grantRole(ADMIN_ROLE, admin.address);

    return { yieldStreamer, yieldStreamerV1Mock, tokenMock };
  }

  async function deployAndConfigureAllContracts(
    initializeAccounts: boolean,
    mintContractBalance: boolean
  ): Promise<Fixture> {
    const { yieldStreamer, yieldStreamerV1Mock, tokenMock } = await deployContracts();
    const contractBalance = mintContractBalance ? 100000000n : 0n;
    const defaultRate = RATE_FACTOR / 100n;
    const claimResult: ClaimResult = {
      nextClaimDay: 0n,
      nextClaimDebit: 0n,
      firstYieldDay: 0n,
      prevClaimDebit: 0n,
      primaryYield: 10000000n,
      streamYield: 0n,
      lastDayPartialYield: 1999999n,
      shortfall: 0n,
      fee: 0n,
      yield: 0n
    };

    await proveTx(yieldStreamerV1Mock.setClaimAllPreview(user.address, claimResult));
    await proveTx(yieldStreamer.addYieldRate(0, 0, [defaultRate], [0n]));

    if (initializeAccounts) {
      await proveTx(yieldStreamer.initializeAccounts([user.address]));
    }

    if (contractBalance > 0n) {
      await proveTx(tokenMock.mint(getAddress(yieldStreamer), contractBalance));
    }

    return { yieldStreamer, yieldStreamerV1Mock, tokenMock };
  }

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

    it("Reverts if the claim amount exceeds the total available yield for the account", async () => {
      const { yieldStreamer } = await deployAndConfigureAllContracts(true, true);

      // get the claim preview
      const claimPreview = await yieldStreamer.getClaimPreview(user.address);

      await expect(
        (yieldStreamer.connect(admin) as Contract).claimAmountFor(
          user.address,
          claimPreview.yieldRounded + ROUND_FACTOR
        )
      ).to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_YieldBalanceInsufficient);
    });

    it("Reverts if the underlying token transfer fails due to insufficient balance in the contract", async () => {
      const { yieldStreamer, tokenMock } = await deployAndConfigureAllContracts(true, false);

      await expect(
        (yieldStreamer.connect(admin) as Contract).claimAmountFor(user.address, MIN_CLAIM_AMOUNT)
      ).to.be.revertedWithCustomError(tokenMock, ERRORS.ERC20InsufficientBalance);
    });

    it("should revert if the account is not initialized", async () => {
      const { yieldStreamer } = await deployAndConfigureAllContracts(false, true);
      // TODO: Setup everything besides the account initialization.
      await expect(
        (yieldStreamer.connect(admin) as Contract).claimAmountFor(user.address, MIN_CLAIM_AMOUNT)
      ).to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_AccountNotInitialized);
    });

    it("should revert if the amount is less than the minimum claim amount", async () => {
      const { yieldStreamer } = await deployAndConfigureAllContracts(true, true);
      const claimAmount = MIN_CLAIM_AMOUNT - 1n;

      await expect(
        (yieldStreamer.connect(admin) as Contract).claimAmountFor(user.address, claimAmount)
      ).to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_ClaimAmountBelowMinimum);
    });

    it("should revert when the claim amount is not rounded down to the required precision", async () => {
      const { yieldStreamer } = await deployAndConfigureAllContracts(true, true);
      const claimAmount = MIN_CLAIM_AMOUNT + 1n;

      await expect(
        (yieldStreamer.connect(admin) as Contract).claimAmountFor(user.address, claimAmount)
      ).to.be.revertedWithCustomError(yieldStreamer, ERRORS.YieldStreamer_ClaimAmountNonRounded);
    });
  });

  describe("Function 'getYieldState()'", async () => {
    // TODO: Implement this.
  });

  describe("Function 'getClaimPreview()'", async () => {
    // TODO: Implement this.
  });

  describe("Function 'getAccruePreview()'", async () => {
    // TODO: Implement this.
  });

  describe("Function 'getGroupYieldRates()'", async () => {
    // TODO: Implement this.
  });

  describe("Function 'getAccountGroup()'", async () => {
    // TODO: Implement this.
  });

  describe("Function 'underlyingToken()'", async () => {
    // TODO: Implement this.
  });

  describe("Function 'feeReceiver()'", async () => {
    // TODO: Implement this.
  });

  describe("Function 'blockTimestamp()'", async () => {
    it("Executes as expected", async () => {
      const { yieldStreamer } = await deployAndConfigureAllContracts(false, false);
      const latest = await time.latest();
      const expected = BigInt(latest) - NEGATIVE_TIME_SHIFT;
      const blockTimestamp = await yieldStreamer.blockTimestamp();
      await expect(blockTimestamp).to.equal(expected);
    });
  });

  describe("Function 'proveYieldStreamer()'", async () => {
    it("Executes as expected", async () => {
      const { yieldStreamer } = await deployAndConfigureAllContracts(false, false);
      await expect(yieldStreamer.proveYieldStreamer()).to.not.be.reverted;
    });
  });
});
