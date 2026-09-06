import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { parseCookies, verifySession } from "./session.js";

/**
 * Two access levels:
 *   guest - may value a public inventory and read Steam libraries
 *   admin - additionally may use the portfolio and price lookup endpoints
 *
 * Keys are compared in constant time so that response timing does not leak how
 * many leading characters of a guessed key were correct.
 *
 * Guest access has two sources. Machine clients such as the Google Sheet send a
 * bearer key; the browser frontend sends a signed session cookie it received in
 * exchange for an access code. Admin access is bearer only on purpose, so that
 * a session cookie can never reach an administrative endpoint even if the
 * cookie handling above it were wrong.
 */

export type AccessLevel = "guest" | "admin";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: { level: AccessLevel; label: string };
    }
  }
}

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) {
    // Still burn a comparison so that length differences are not observable.
    crypto.timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return crypto.timingSafeEqual(bufferA, bufferB);
}

/**
 * Reads the key from the Authorization header, falling back to a query
 * parameter. The query fallback exists only for clients that cannot send
 * headers, such as the IMPORTDATA function in Google Sheets.
 */
function extractKey(req: Request): string | undefined {
  const header = req.get("authorization");
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match?.[1]) return match[1].trim();
  }
  const queryKey = req.query.key;
  if (typeof queryKey === "string" && queryKey.length > 0) return queryKey;
  return undefined;
}

function resolve(
  key: string,
): { level: AccessLevel; label: string } | undefined {
  if (safeEqual(key, config.adminKey)) {
    return { level: "admin", label: "admin" };
  }
  for (const [guestKey, label] of config.guestKeys) {
    if (safeEqual(key, guestKey)) {
      return { level: "guest", label };
    }
  }
  return undefined;
}

/**
 * Reads a session cookie. The label is prefixed so that a session and a bearer
 * key named the same thing cannot share a rate limit bucket or a log line.
 */
export function resolveSessionAuth(
  req: Request,
): { level: AccessLevel; label: string } | undefined {
  const raw = parseCookies(req.get("cookie")).get(config.cookieName);
  const session = verifySession(raw);
  if (!session) return undefined;
  return { level: "guest", label: `session:${session.label}` };
}

/** True when a cookie was sent at all, valid or not. */
function hasSessionCookie(req: Request): boolean {
  return parseCookies(req.get("cookie")).has(config.cookieName);
}

/**
 * Requires any valid key or a valid session. The admin key satisfies this too.
 *
 * A bearer key takes precedence, so a machine client with an unrelated cookie
 * still authenticates as itself.
 */
export function requireGuest(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const key = extractKey(req);
  if (key) {
    const auth = resolve(key);
    if (!auth) {
      res.status(403).json({ error: "invalid_api_key" });
      return;
    }
    req.auth = auth;
    next();
    return;
  }

  const session = resolveSessionAuth(req);
  if (session) {
    req.auth = session;
    next();
    return;
  }

  // A cookie that does not verify is reported separately from no cookie at all,
  // so the frontend can tell "your session ended" from "you were never signed
  // in". Both mean the same thing to the user: sign in again.
  if (hasSessionCookie(req)) {
    res.status(403).json({ error: "invalid_session" });
    return;
  }
  res.status(401).json({ error: "missing_api_key" });
}

/**
 * Checks a typed access code against the configured list, in constant time and
 * against every entry, so neither timing nor early exit reveals which code was
 * close. Returns the label to put into the session cookie.
 */
export function resolveAccessCode(code: string): string | undefined {
  let label: string | undefined;
  for (const [candidate, candidateLabel] of config.accessCodes) {
    if (safeEqual(code, candidate)) label = candidateLabel;
  }
  return label;
}

/** Requires the admin key specifically. */
export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const key = extractKey(req);
  if (!key) {
    res.status(401).json({ error: "missing_api_key" });
    return;
  }
  const auth = resolve(key);
  if (!auth || auth.level !== "admin") {
    res.status(403).json({ error: "admin_key_required" });
    return;
  }
  req.auth = auth;
  next();
}

/** Strips leading zeros from an IPv6 group so that 0db8 and db8 bucket alike. */
function normaliseGroup(group: string): string {
  return group.toLowerCase().replace(/^0+(?=.)/, "");
}

/**
 * Reduces an IPv6 address to its /64 prefix. Residential and hosting customers
 * routinely get a /64 or larger, so bucketing on the exact address would let a
 * single client walk through addresses and never hit the limit. IPv4 addresses
 * are used as they are.
 */
function ipv6Prefix(address: string): string {
  const [head = "", tail = ""] = address.split("::");
  const headGroups = head.split(":").filter((group) => group !== "");
  const tailGroups = tail.split(":").filter((group) => group !== "");

  const groups = address.includes("::")
    ? [
        ...headGroups,
        ...new Array<string>(
          Math.max(8 - headGroups.length - tailGroups.length, 0),
        ).fill("0"),
        ...tailGroups,
      ]
    : headGroups;

  return `${groups.slice(0, 4).map(normaliseGroup).join(":")}::`;
}

/**
 * Normalises a client address into a rate limit bucket. Handles the bracketed
 * and zone suffixed forms a proxy may produce, and treats an IPv4 mapped
 * address as the IPv4 client it actually is.
 */
export function clientIpKey(ip: string | undefined): string {
  if (!ip) return "ip:unknown";

  const bracketed = ip.startsWith("[") ? ip.slice(1, ip.indexOf("]")) : ip;
  const address = bracketed.split("%")[0] ?? bracketed;

  if (!address.includes(":")) return `ip:${address}`;

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped?.[1]) return `ip:${mapped[1]}`;

  return `ip:${ipv6Prefix(address)}`;
}

/**
 * Rate limit bucket identifier. Keying on the API key means one person cannot
 * exhaust everybody else's budget by sharing an IP, while unauthenticated
 * traffic still falls back to the client address.
 */
export function rateLimitKey(req: Request): string {
  if (req.auth) return `key:${req.auth.label}`;
  return clientIpKey(req.ip);
}
