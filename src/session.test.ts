import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * config.ts reads the environment at import time and refuses to load without an
 * admin key, so the environment is set up before the dynamic import below.
 * DATA_DIR points at a scratch directory because importing config creates it.
 */
process.env.ADMIN_KEY = "a".repeat(64);
process.env.SESSION_SECRET = "s".repeat(64);
process.env.ACCESS_CODES = "code-for-testing:tester";
process.env.DATA_DIR = "./data/test";

const { signSession, verifySession, parseCookies, sessionCookie } =
  await import("./session.js");

const MINUTE = 60_000;

describe("signSession / verifySession", () => {
  it("round trips a label", () => {
    const cookie = signSession("tester", 30 * MINUTE);
    assert.deepEqual(verifySession(cookie), { label: "tester" });
  });

  it("survives a label containing the separators used internally", () => {
    const cookie = signSession("a.b\nc:d", 30 * MINUTE);
    assert.deepEqual(verifySession(cookie), { label: "a.b\nc:d" });
  });

  it("rejects an expired cookie", () => {
    assert.equal(verifySession(signSession("tester", -1)), undefined);
  });

  it("rejects a tampered payload", () => {
    const cookie = signSession("tester", 30 * MINUTE);
    const [payload, signature] = cookie.split(".");
    assert.ok(payload && signature);

    // Re-encode a different label but keep the original signature.
    const forged = Buffer.from("admin\n" + (Date.now() + MINUTE)).toString(
      "base64url",
    );
    assert.equal(verifySession(`${forged}.${signature}`), undefined);
  });

  it("rejects a tampered signature", () => {
    const cookie = signSession("tester", 30 * MINUTE);
    const [payload] = cookie.split(".");
    assert.ok(payload);
    assert.equal(
      verifySession(`${payload}.${Buffer.from("nope").toString("base64url")}`),
      undefined,
    );
  });

  it("rejects malformed shapes", () => {
    assert.equal(verifySession(undefined), undefined);
    assert.equal(verifySession(""), undefined);
    assert.equal(verifySession("no-separator"), undefined);
    assert.equal(verifySession(".onlysignature"), undefined);
    assert.equal(verifySession("onlypayload."), undefined);
  });

  it("rejects a cookie signed with a different secret", () => {
    // A cookie minted elsewhere: same shape, signature from another key.
    const payload = Buffer.from(`tester\n${Date.now() + MINUTE}`).toString(
      "base64url",
    );
    const foreign = Buffer.from("x".repeat(32)).toString("base64url");
    assert.equal(verifySession(`${payload}.${foreign}`), undefined);
  });
});

describe("parseCookies", () => {
  it("parses a normal header", () => {
    const cookies = parseCookies("a=1; b=2");
    assert.equal(cookies.get("a"), "1");
    assert.equal(cookies.get("b"), "2");
  });

  it("keeps the first occurrence of a duplicate name", () => {
    assert.equal(parseCookies("a=1; a=2").get("a"), "1");
  });

  it("keeps values containing an equals sign intact", () => {
    assert.equal(parseCookies("a=x=y=z").get("a"), "x=y=z");
  });

  it("handles an absent or empty header", () => {
    assert.equal(parseCookies(undefined).size, 0);
    assert.equal(parseCookies("").size, 0);
    assert.equal(parseCookies("; ;").size, 0);
  });
});

describe("sessionCookie", () => {
  it("marks the cookie HttpOnly and scopes it to the API", () => {
    const header = sessionCookie("value", 60);
    assert.match(header, /^sxo_session=value;/);
    assert.match(header, /HttpOnly/);
    assert.match(header, /Path=\/api/);
    assert.match(header, /SameSite=Lax/);
    assert.match(header, /Max-Age=60/);
  });
});
