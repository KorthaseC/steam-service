import crypto from "node:crypto";
import { config } from "./config.js";

/**
 * Signed session cookies for the browser frontend.
 *
 * The frontend cannot use the bearer keys: anything it holds is readable by
 * script on the page, so a stolen key would be permanent. Instead the user
 * trades an access code for a cookie that is HttpOnly (no script can read it)
 * and carries its own expiry inside the signature.
 *
 * The cookie is self contained, so there is no session table and nothing to
 * clean up. The flip side is that a cookie cannot be revoked individually -
 * rotating SESSION_SECRET invalidates every session at once, which is the
 * intended lever for "log everybody out".
 *
 * Written by hand rather than with a JWT library because the whole payload is
 * one label and one timestamp, and this file stays smaller than the dependency
 * would be. Same reasoning as the constant time key compare in auth.ts.
 */

/** Separates payload from signature. Never appears in base64url output. */
const SEPARATOR = ".";

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function sign(payload: string): Buffer {
  return crypto
    .createHmac("sha256", config.sessionSecret)
    .update(payload)
    .digest();
}

/**
 * Builds a cookie value for the given access code label. The signature covers
 * the encoded payload including the expiry, so neither the label nor the
 * lifetime can be edited without invalidating it.
 */
export function signSession(label: string, ttlMs: number): string {
  const expiresAt = Date.now() + ttlMs;
  // The label is encoded, so a separator inside it cannot break parsing.
  const payload = base64url(`${label}\n${expiresAt}`);
  return `${payload}${SEPARATOR}${base64url(sign(payload))}`;
}

/**
 * Verifies a cookie and returns its label, or undefined when it is malformed,
 * forged or expired. Every failure looks the same to the caller on purpose.
 */
export function verifySession(
  raw: string | undefined,
): { label: string } | undefined {
  if (!raw || !config.sessionSecret) return undefined;

  const index = raw.indexOf(SEPARATOR);
  if (index <= 0 || index === raw.length - 1) return undefined;

  const payload = raw.slice(0, index);
  const provided = Buffer.from(raw.slice(index + 1), "base64url");
  const expected = sign(payload);

  // Length differs only for a hand made cookie, but timingSafeEqual throws on
  // mismatched lengths, so it has to be checked before the comparison.
  if (provided.length !== expected.length) return undefined;
  if (!crypto.timingSafeEqual(provided, expected)) return undefined;

  const decoded = Buffer.from(payload, "base64url").toString("utf8");
  const newline = decoded.lastIndexOf("\n");
  if (newline <= 0) return undefined;

  const label = decoded.slice(0, newline);
  const expiresAt = Number(decoded.slice(newline + 1));
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) return undefined;

  return { label };
}

/**
 * Minimal Cookie header parser. Only the first occurrence of a name wins,
 * matching how browsers themselves resolve duplicates.
 */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;

  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (!name || cookies.has(name)) continue;
    cookies.set(name, part.slice(index + 1).trim());
  }
  return cookies;
}

/**
 * Serialises the Set-Cookie header. Path is scoped to /api so the cookie is
 * never attached to requests for the static frontend assets, and SameSite=Lax
 * is enough because frontend and API share one origin.
 */
export function sessionCookie(value: string, maxAgeSeconds: number): string {
  const attributes = [
    `${config.cookieName}=${value}`,
    "Path=/api",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (config.cookieSecure) attributes.push("Secure");
  return attributes.join("; ");
}
