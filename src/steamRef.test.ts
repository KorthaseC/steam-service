import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSteamRef } from "./steamRef.js";

/**
 * This parser decides what reaches an outbound Steam URL, so the rejection
 * cases matter as much as the happy path.
 */

describe("parseSteamRef", () => {
  it("accepts a bare SteamID64", () => {
    assert.deepEqual(parseSteamRef("76561197960287930"), {
      kind: "steamid64",
      value: "76561197960287930",
    });
  });

  it("trims surrounding whitespace", () => {
    assert.deepEqual(parseSteamRef("  76561197960287930\n"), {
      kind: "steamid64",
      value: "76561197960287930",
    });
  });

  it("reads a profiles URL", () => {
    assert.deepEqual(
      parseSteamRef("https://steamcommunity.com/profiles/76561197960287930"),
      { kind: "steamid64", value: "76561197960287930" },
    );
  });

  it("reads an id URL with a trailing slash and query", () => {
    assert.deepEqual(
      parseSteamRef("https://steamcommunity.com/id/gaben/?snr=1_4_4__12"),
      { kind: "vanity", value: "gaben" },
    );
  });

  it("reads a URL without a scheme", () => {
    assert.deepEqual(parseSteamRef("steamcommunity.com/id/gaben"), {
      kind: "vanity",
      value: "gaben",
    });
  });

  it("ignores a www prefix", () => {
    assert.deepEqual(parseSteamRef("www.steamcommunity.com/id/gaben"), {
      kind: "vanity",
      value: "gaben",
    });
  });

  it("accepts a bare vanity name and lowercases it for the cache key", () => {
    assert.deepEqual(parseSteamRef("GabeN"), {
      kind: "vanity",
      value: "gaben",
    });
  });

  it("accepts the deeper path Steam links to", () => {
    assert.deepEqual(
      parseSteamRef("https://steamcommunity.com/id/gaben/games/?tab=all"),
      { kind: "vanity", value: "gaben" },
    );
  });

  it("rejects a profiles URL whose ID is not a SteamID64", () => {
    assert.equal(parseSteamRef("steamcommunity.com/profiles/12345"), null);
  });

  it("rejects a host that is not steamcommunity.com", () => {
    assert.equal(parseSteamRef("https://evil.example.com/id/gaben"), null);
    // A lookalike host must not pass either.
    assert.equal(
      parseSteamRef("https://steamcommunity.com.evil.test/id/x"),
      null,
    );
  });

  it("rejects path traversal and separators inside a vanity name", () => {
    assert.equal(parseSteamRef("../../admin"), null);
    assert.equal(parseSteamRef("steamcommunity.com/id/../../etc/passwd"), null);
    assert.equal(parseSteamRef("gaben/../other"), null);
  });

  it("rejects a malformed percent escape", () => {
    assert.equal(parseSteamRef("steamcommunity.com/id/%zz"), null);
  });

  it("rejects an encoded slash in a vanity name", () => {
    assert.equal(parseSteamRef("steamcommunity.com/id/a%2Fb"), null);
  });

  it("rejects empty, oversized and non-string input", () => {
    assert.equal(parseSteamRef(""), null);
    assert.equal(parseSteamRef("   "), null);
    assert.equal(parseSteamRef("x".repeat(300)), null);
    assert.equal(parseSteamRef(undefined), null);
    assert.equal(parseSteamRef(42), null);
    assert.equal(parseSteamRef(null), null);
  });

  it("rejects a vanity name with characters Steam does not allow", () => {
    assert.equal(parseSteamRef("gabe n"), null);
    assert.equal(parseSteamRef("gaben!"), null);
    assert.equal(parseSteamRef("a"), null);
  });
});
