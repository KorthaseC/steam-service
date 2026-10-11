import assert from "node:assert/strict";
import { describe, it } from "node:test";

// See session.test.ts: config.ts reads the environment at import time.
process.env.ADMIN_KEY = "a".repeat(64);
process.env.DATA_DIR = "./data/test";

const {
  chunkAppIds,
  MAX_BATCH,
  parseReviews,
  parseStoreItems,
  parseTagList,
  resolveAssetPath,
  resolveTagNames,
} = await import("./steamStore.js");

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
    const batches = chunkAppIds(
      new Array(600).fill(0).map((_, i) => i + 1),
      5000,
    );
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

    assert.deepEqual(parsed.get(440)?.tagIds, [113, 19]);
    assert.deepEqual(parsed.get(620)?.tagIds, [1664, 4136]);
  });

  // Steam's ordering is the tag agreement order, and it is the whole reason
  // the top six are worth showing. Sorting would destroy the signal.
  it("preserves Steam's ordering", () => {
    const parsed = parseStoreItems({
      response: { store_items: [{ appid: 1, tagids: [900, 2, 500] }] },
    });

    assert.deepEqual(parsed.get(1)?.tagIds, [900, 2, 500]);
  });

  // A tagless app is a real answer, and recording it is what stops the same
  // AppID being refetched on every single library load.
  it("keeps an app that genuinely has no tags", () => {
    const parsed = parseStoreItems({
      response: { store_items: [{ appid: 7, success: 1, tagids: [] }] },
    });

    assert.ok(parsed.has(7));
    assert.deepEqual(parsed.get(7)?.tagIds, []);
  });

  // Protobuf-shaped JSON omits empty repeated fields, so a found app with no
  // tags may arrive without the array at all.
  it("keeps a successful app that omits the tag array", () => {
    const parsed = parseStoreItems({
      response: { store_items: [{ appid: 9, success: 1 }] },
    });

    assert.deepEqual(parsed.get(9), {
      tagIds: [],
      reviews: null,
      capsulePath: null,
    });
  });

  it("skips delisted apps that come back with nothing", () => {
    const parsed = parseStoreItems({
      response: { store_items: [{ appid: 8, success: 2 }] },
    });

    assert.equal(parsed.has(8), false);
  });

  it("falls back to the id field when appid is absent", () => {
    const parsed = parseStoreItems({
      response: { store_items: [{ id: 99, tagids: [1] }] },
    });

    assert.deepEqual(parsed.get(99)?.tagIds, [1]);
  });

  it("drops non numeric tag ids rather than passing them on", () => {
    const parsed = parseStoreItems({
      response: { store_items: [{ appid: 5, tagids: [1, "x", null, 2] }] },
    });

    assert.deepEqual(parsed.get(5)?.tagIds, [1, 2]);
  });

  it("returns nothing for a response of the wrong shape", () => {
    assert.equal(parseStoreItems(null).size, 0);
    assert.equal(parseStoreItems({}).size, 0);
    assert.equal(
      parseStoreItems({ response: { store_items: "nope" } }).size,
      0,
    );
  });

  // The shape observed for a game whose art was re-uploaded: every filename
  // sits below a content hash, which is why the AppID-derived URL 404s.
  it("reads the hashed capsule path and the review summary", () => {
    const parsed = parseStoreItems({
      response: {
        store_items: [
          {
            appid: 2623190,
            success: 1,
            tagids: [122],
            reviews: {
              summary_filtered: {
                review_count: 11290,
                percent_positive: 80,
                review_score: 8,
                review_score_label: "Very Positive",
              },
            },
            assets: {
              asset_url_format: "steam/apps/2623190/${FILENAME}?t=1753715775",
              small_capsule:
                "67e60b0125feb2f0cc6964f0acb785faf1207fbd/capsule_231x87.jpg",
              header: "a7cee9165bb1bfc092c390c5cff215ce0e381dfc/header.jpg",
            },
          },
        ],
      },
    });

    assert.deepEqual(parsed.get(2623190), {
      tagIds: [122],
      reviews: { score: 8, percentPositive: 80, count: 11290 },
      capsulePath:
        "steam/apps/2623190/67e60b0125feb2f0cc6964f0acb785faf1207fbd/capsule_231x87.jpg?t=1753715775",
    });
  });

  it("falls back to the header when there is no small capsule", () => {
    const parsed = parseStoreItems({
      response: {
        store_items: [
          {
            appid: 1580790,
            success: 1,
            assets: {
              asset_url_format: "steam/apps/1580790/${FILENAME}?t=1751503462",
              header: "header.jpg",
            },
          },
        ],
      },
    });

    assert.equal(
      parsed.get(1580790)?.capsulePath,
      "steam/apps/1580790/header.jpg?t=1751503462",
    );
  });
});

describe("parseReviews", () => {
  it("prefers the filtered summary, which is what the store page shows", () => {
    const reviews = parseReviews({
      summary_filtered: {
        review_count: 100,
        percent_positive: 90,
        review_score: 8,
      },
      summary_unfiltered: {
        review_count: 200,
        percent_positive: 40,
        review_score: 5,
      },
    });

    assert.deepEqual(reviews, { score: 8, percentPositive: 90, count: 100 });
  });

  it("falls back to the unfiltered summary", () => {
    const reviews = parseReviews({
      summary_unfiltered: {
        review_count: 200,
        percent_positive: 40,
        review_score: 5,
      },
    });

    assert.deepEqual(reviews, { score: 5, percentPositive: 40, count: 200 });
  });

  // Too few reviews for a verdict is score 0, which the frontend words
  // differently from a game nobody has reviewed at all.
  it("keeps a summary with too few reviews for a verdict", () => {
    const reviews = parseReviews({
      summary_filtered: { review_count: 4, review_score: 0 },
    });

    assert.deepEqual(reviews, { score: 0, percentPositive: null, count: 4 });
  });

  it("clamps values of the wrong type or range instead of passing them on", () => {
    const reviews = parseReviews({
      summary_filtered: {
        review_count: -3,
        percent_positive: 250,
        review_score: 12,
      },
    });

    assert.deepEqual(reviews, { score: 0, percentPositive: null, count: 0 });
  });

  it("returns null when there is no summary at all", () => {
    assert.equal(parseReviews(undefined), null);
    assert.equal(parseReviews({}), null);
    assert.equal(parseReviews({ summary_filtered: "nope" }), null);
  });
});

describe("resolveAssetPath", () => {
  const format = "steam/apps/620/${FILENAME}?t=123";

  it("fills the filename into the format", () => {
    assert.equal(
      resolveAssetPath(format, "capsule_231x87.jpg"),
      "steam/apps/620/capsule_231x87.jpg?t=123",
    );
  });

  it("keeps a hash directory in front of the filename", () => {
    assert.equal(
      resolveAssetPath(format, "abc123/capsule_231x87.jpg"),
      "steam/apps/620/abc123/capsule_231x87.jpg?t=123",
    );
  });

  it("accepts a format without a query", () => {
    assert.equal(
      resolveAssetPath("steam/apps/620/${FILENAME}", "header.jpg"),
      "steam/apps/620/header.jpg",
    );
  });

  // The result lands in an <img src>. Anything that could point it somewhere
  // other than a relative image path on the asset host is refused.
  it("refuses traversal, schemes and non-image filenames", () => {
    assert.equal(resolveAssetPath(format, "../../evil.jpg"), null);
    assert.equal(resolveAssetPath(format, "capsule.svg"), null);
    assert.equal(resolveAssetPath(format, "a b.jpg"), null);
    assert.equal(
      resolveAssetPath("https://evil.example/${FILENAME}", "x.jpg"),
      null,
    );
    assert.equal(
      resolveAssetPath("/steam/apps/620/${FILENAME}", "x.jpg"),
      null,
    );
    assert.equal(
      resolveAssetPath("steam/apps/620/${FILENAME}?t=1#x", "x.jpg"),
      null,
    );
  });

  it("refuses a format without exactly one placeholder", () => {
    assert.equal(resolveAssetPath("steam/apps/620/header.jpg", "x.jpg"), null);
    assert.equal(
      resolveAssetPath("steam/${FILENAME}/${FILENAME}", "x.jpg"),
      null,
    );
  });

  it("refuses values that are not strings", () => {
    assert.equal(resolveAssetPath(undefined, "x.jpg"), null);
    assert.equal(resolveAssetPath(format, 42), null);
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
      response: {
        tags: [{ tagid: 1, name: "  " }, { tagid: 2 }, { name: "x" }],
      },
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
