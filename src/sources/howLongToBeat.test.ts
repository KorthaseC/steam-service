import assert from "node:assert/strict";
import { describe, it } from "node:test";

// See session.test.ts: config.ts reads the environment at import time.
process.env.ADMIN_KEY = "a".repeat(64);
process.env.DATA_DIR = "./data/test";

const { normaliseTitle, stripEdition } = await import("./howLongToBeat.js");

/**
 * Title matching is where a wrong answer is silent: a mismatched game shows
 * plausible but wrong completion times. These cases are the ones that actually
 * occur in a Steam library.
 */

describe("normaliseTitle", () => {
  it("drops trademark symbols Steam puts in titles", () => {
    assert.equal(normaliseTitle("PAYDAY™ 2"), "payday 2");
    assert.equal(
      normaliseTitle("Sid Meier's Civilization® VI"),
      "sid meier s civilization vi",
    );
  });

  it("folds accents", () => {
    assert.equal(normaliseTitle("Pokémon"), "pokemon");
  });

  it("spells out an ampersand so both writings meet", () => {
    assert.equal(
      normaliseTitle("Command & Conquer"),
      normaliseTitle("Command and Conquer"),
    );
  });

  it("collapses punctuation and whitespace", () => {
    assert.equal(normaliseTitle("  Half-Life:  Alyx  "), "half life alyx");
  });

  it("keeps genuinely different titles apart", () => {
    assert.notEqual(normaliseTitle("Portal"), normaliseTitle("Portal 2"));
    assert.notEqual(normaliseTitle("Fallout 3"), normaliseTitle("Fallout 4"));
  });
});

describe("stripEdition", () => {
  it("removes edition wording Steam adds and HowLongToBeat omits", () => {
    assert.equal(
      stripEdition(
        normaliseTitle("The Witcher 3: Wild Hunt - Game of the Year Edition"),
      ),
      "the witcher 3 wild hunt",
    );
    assert.equal(
      stripEdition(normaliseTitle("Skyrim Special Edition")),
      "skyrim",
    );
    assert.equal(
      stripEdition(normaliseTitle("BioShock Remastered")),
      "bioshock",
    );
  });

  it("leaves a title without edition wording untouched", () => {
    const plain = normaliseTitle("Hollow Knight");
    assert.equal(stripEdition(plain), plain);
  });

  it("still separates different games after stripping", () => {
    assert.notEqual(
      stripEdition(normaliseTitle("Mass Effect 2")),
      stripEdition(normaliseTitle("Mass Effect 3")),
    );
  });
});
