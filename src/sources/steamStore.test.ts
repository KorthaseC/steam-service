import assert from "node:assert/strict";
import { describe, it } from "node:test";

// See session.test.ts: config.ts reads the environment at import time.
process.env.ADMIN_KEY = "a".repeat(64);
process.env.DATA_DIR = "./data/test";

const { chunkAppIds, MAX_BATCH, parseStoreItems, parseTagList, resolveTagNames } =
  await import("./steamStore.js");

/**
 * The store endpoint is undocumented, so the parsing here is written to
 * survive a response that changes shape rather than to trust one. These cases
 * are the ones actually observed against the live API.
 */

describe("chunkAppIds", () => {
  it("splits into batches of the requested size", () => {
    const batches = chunkAppIds([1, 2, 3, 4, 5], 2);
    assert.deepEqual(batches, [[1, 2], [3, 4], [5]]);
  });

  it("returns nothing for an empty library", () => {
    assert.deepEqual(chunkAppIds([], 200), []);
  });

  // The request is a JSON blob in a query parameter, so an oversized batch is
  // a 414 rather than a truncated answer. Clamping here keeps a careless
  // STORE_TAG_BATCH_SIZE from breaking every lookup.
  it("clamps a batch size above the measured URL limit", () => {
    const batches = chunkAppIds(new Array(600).fill(0).map((_, i) => i + 1), 5000);
    assert.equal(batches[0]?.length, MAX_BATCH);
  });

  it("never produces a zero length batch", () => {
    const batches = chunkAppIds([1, 2, 3], 0);
    assert.deepEqual(batches, [[1], [2], [3]]);
  });
});

describe("parseStoreItems", () => {
  it("reads tag ids keyed by appid", () => {
    const parsed = parseStoreItems({
      response: {
        store_items: [
          { appid: 440, success: 1, tagids: [113, 19] },
          { appid: 620, success: 1, tagids: [1664, 4136] },
        ],
      },
    });

    assert.deepEqual(parsed.get(440), [113, 19]);
    assert.deepEqual(parsed.get(620), [1664, 4136]);
  });

  // Steam's ordering is the tag agreement order, and it is the whole reason
  // the top six are worth showing. Sorting would destroy the signal.
  it("preserves Steam's ordering", () => {
    const parsed = parseStoreItems({
      response: { store_items: [{ appid: 1, tagids: [900, 2, 500] }] },
    });

    assert.deepEqual(parsed.get(1), [900, 2, 500]);
  });

  // A tagless app is a real answer, and recording it is what stops the same
  // AppID being refetched on every single library load.
  it("keeps an app that genuinely has no tags", () => {
    const parsed = parseStoreItems({
      response: { store_items: [{ appid: 7, success: 1, tagids: [] }] },
    });

    assert.ok(parsed.has(7));
    assert.deepEqual(parsed.get(7), []);
  });

  it("skips delisted apps that come back without a tag array", () => {
    const parsed = parseStoreItems({
      response: { store_items: [{ appid: 8, success: 2 }] },
    });

    assert.equal(parsed.has(8), false);
  });

  it("falls back to the id field when appid is absent", () => {
    const parsed = parseStoreItems({
      response: { store_items: [{ id: 99, tagids: [1] }] },
    });

    assert.deepEqual(parsed.get(99), [1]);
  });

  it("drops non numeric tag ids rather than passing them on", () => {
    const parsed = parseStoreItems({
      response: { store_items: [{ appid: 5, tagids: [1, "x", null, 2] }] },
    });

    assert.deepEqual(parsed.get(5), [1, 2]);
  });

  it("returns nothing for a response of the wrong shape", () => {
    assert.equal(parseStoreItems(null).size, 0);
    assert.equal(parseStoreItems({}).size, 0);
    assert.equal(parseStoreItems({ response: { store_items: "nope" } }).size, 0);
  });
});

describe("parseTagList", () => {
  it("reads ids, names and the version hash", () => {
    const list = parseTagList({
      response: {
        version_hash: "62644198",
        tags: [
          { tagid: 19, name: "Action" },
          { tagid: 9, name: "Strategie" },
        ],
      },
    });

    assert.equal(list.versionHash, "62644198");
    assert.equal(list.names.get(19), "Action");
    assert.equal(list.names.get(9), "Strategie");
  });

  it("ignores entries with no usable name", () => {
    const list = parseTagList({
      response: { tags: [{ tagid: 1, name: "  " }, { tagid: 2 }, { name: "x" }] },
    });

    assert.equal(list.names.size, 0);
  });

  it("survives a response of the wrong shape", () => {
    assert.equal(parseTagList(undefined).names.size, 0);
    assert.equal(parseTagList({ response: {} }).versionHash, "");
  });
});

describe("resolveTagNames", () => {
  const names = new Map([
    [19, "Action"],
    [9, "Strategie"],
  ]);

  it("resolves in the stored order", () => {
    assert.deepEqual(resolveTagNames([9, 19], names), ["Strategie", "Action"]);
  });

  // A tag created after the vocabulary was cached has no name yet. Showing one
  // tag fewer beats showing "#4521" to a reader.
  it("drops ids the vocabulary does not know", () => {
    assert.deepEqual(resolveTagNames([19, 4521], names), ["Action"]);
  });

  it("handles an empty list", () => {
    assert.deepEqual(resolveTagNames([], names), []);
  });
});
