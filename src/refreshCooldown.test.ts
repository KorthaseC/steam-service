import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RefreshCooldown } from "./refreshCooldown.js";

/**
 * The cooldown is what stands between a refresh button and the Web API key's
 * daily quota, so both directions matter: it must refuse inside the window and
 * must not keep refusing after it.
 */

function clock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("RefreshCooldown", () => {
  it("allows the first claim for a key", () => {
    const time = clock();
    const cooldown = new RefreshCooldown(() => 60_000, time.now);

    assert.equal(cooldown.claim("a"), true);
  });

  it("refuses a second claim inside the window", () => {
    const time = clock();
    const cooldown = new RefreshCooldown(() => 60_000, time.now);

    cooldown.claim("a");
    time.advance(59_999);

    assert.equal(cooldown.claim("a"), false);
  });

  it("allows a claim again once the window has passed", () => {
    const time = clock();
    const cooldown = new RefreshCooldown(() => 60_000, time.now);

    cooldown.claim("a");
    time.advance(60_000);

    assert.equal(cooldown.claim("a"), true);
  });

  // A refused claim must not extend the window, or somebody pressing the
  // button repeatedly would lock themselves out indefinitely.
  it("does not restart the window on a refused claim", () => {
    const time = clock();
    const cooldown = new RefreshCooldown(() => 60_000, time.now);

    cooldown.claim("a");
    time.advance(30_000);
    cooldown.claim("a");
    time.advance(30_000);

    assert.equal(cooldown.claim("a"), true);
  });

  it("keeps keys independent", () => {
    const time = clock();
    const cooldown = new RefreshCooldown(() => 60_000, time.now);

    cooldown.claim("a");

    assert.equal(cooldown.claim("b"), true);
  });

  it("reports when the next claim becomes available", () => {
    const time = clock(5_000);
    const cooldown = new RefreshCooldown(() => 60_000, time.now);

    assert.equal(cooldown.availableAt("a"), 5_000);

    cooldown.claim("a");
    time.advance(10_000);

    assert.equal(cooldown.availableAt("a"), 65_000);
  });

  it("drops expired entries instead of growing forever", () => {
    const time = clock();
    const cooldown = new RefreshCooldown(() => 60_000, time.now);

    cooldown.claim("a");
    cooldown.claim("b");
    time.advance(60_000);
    cooldown.claim("c");

    assert.equal(cooldown.size, 1);
  });

  it("allows every claim when the cooldown is zero", () => {
    const time = clock();
    const cooldown = new RefreshCooldown(() => 0, time.now);

    assert.equal(cooldown.claim("a"), true);
    assert.equal(cooldown.claim("a"), true);
  });
});
