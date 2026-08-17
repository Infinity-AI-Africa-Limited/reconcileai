import { afterEach, describe, expect, it } from "vitest";
import {
  resetShoplineRequestSlotsForTest,
  SHOPLINE_REQUEST_INTERVAL_MS,
  waitForShoplineRequestSlot,
} from "./connectors/shopline/rateLimiter";

describe("Shopline per-store request pacing", () => {
  afterEach(() => resetShoplineRequestSlotsForTest());

  it("spaces a store's requests at the documented four-per-second interval", async () => {
    let now = 10_000;
    const waits: number[] = [];
    const sleep = async (milliseconds: number) => {
      waits.push(milliseconds);
      now += milliseconds;
    };

    await waitForShoplineRequestSlot("reconcileai-dev", () => now, sleep);
    await waitForShoplineRequestSlot("reconcileai-dev", () => now, sleep);
    await waitForShoplineRequestSlot("reconcileai-dev", () => now, sleep);

    expect(waits).toEqual([
      SHOPLINE_REQUEST_INTERVAL_MS,
      SHOPLINE_REQUEST_INTERVAL_MS,
    ]);
  });

  it("keeps independent stores independent", async () => {
    const waits: number[] = [];
    const clock = () => 20_000;
    const sleep = async (milliseconds: number) => {
      waits.push(milliseconds);
    };

    await waitForShoplineRequestSlot("store-a", clock, sleep);
    await waitForShoplineRequestSlot("store-b", clock, sleep);

    expect(waits).toEqual([]);
  });
});
