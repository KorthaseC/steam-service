import { config } from "./config.js";

/**
 * Request headers for every call to steamcommunity.com.
 *
 * Steam rejects unfamiliar clients with 429 regardless of request volume: a
 * custom or empty user agent is refused outright, and a browser user agent is
 * only accepted when the rest of the browser headers are present too. Sending
 * the browser string on its own is the worst of both worlds and was the reason
 * this service looked permanently rate limited.
 *
 * Accept-Encoding is deliberately absent. Node sets and handles it itself, and
 * overriding it risks receiving a compressed body that never gets unpacked.
 */
export function steamHeaders(referer?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": config.steamUserAgent,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
    "sec-ch-ua": config.steamSecChUa,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Linux"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };

  if (referer) headers.Referer = referer;
  return headers;
}
