import { network } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";

export async function setUpFixture<T>(func: () => Promise<T>): Promise<T> {
  if (network.name === "hardhat") {
    // Use Hardhat's snapshot functionality for faster test execution.
    return loadFixture(func);
  } else {
    // Directly execute the function if not on Hardhat network.
    return func();
  }
}

export function checkEquality<T extends Record<string, unknown>>(
  actualObject: T,
  expectedObject: T,
  index?: number,
  props: {
    ignoreObjects: boolean;
  } = { ignoreObjects: false }
) {
  const indexString = index == null ? "" : ` with index: ${index}`;
  Object.keys(expectedObject).forEach(property => {
    const value = actualObject[property];
    if (typeof value === "undefined" || typeof value === "function") {
      throw Error(`Property "${property}" is not found in the actual object` + indexString);
    }
    if (typeof expectedObject[property] === "object" && props.ignoreObjects) {
      return;
    }
    expect(value).to.eq(
      expectedObject[property],
      `Mismatch in the "${property}" property between the actual object and expected one` + indexString
    );
  });
}

export function maxUintForBits(numberOfBits: number): bigint {
  return 2n ** BigInt(numberOfBits) - 1n;
}
