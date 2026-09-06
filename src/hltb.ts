import { config } from "./config.js";
import {
  countDueGames,
  countHltbGames,
  getMeta,
  markGameLookupFailure,
  markGameLookupSuccess,
  pruneTrackedGames,
  selectDueGames,
  setMeta,
  upsertHltb,
} from "./db.js";
import { isHltbBlocked, matchGame } from "./sources/howLongToBeat.js";

/**
 * Owns the completion time cache, in the same shape as prices.ts: games seen in
 * a request are tracked, and a background cycle resolves the oldest of them a
 * batch at a time.
 *
 * The difference to prices is what "due" means. A matched game barely changes,
 * so it is left alone for months; a game HowLongToBeat did not know is retried
 * sooner, because their database grows. Both are cached - remembering a miss is
 * what stops a library full of multiplayer titles from being searched forever.
 */

const LAST_REFRESH_KEY = "last_hltb_refresh";
const LAST_REFRESH_COUNT_KEY = "last_hltb_refresh_count";

let refreshInFlight: Promise<HltbRefreshResult> | null = null;

export interface HltbRefreshResult {
  /** Games that were due and attempted in this cycle. */
  attempted: number;
  /** Games that got completion times. */
  matched: number;
  /** Games HowLongToBeat searched but does not know. */
  unmatched: number;
  /** Lookups that never completed, so the game stays due. */
  failed: number;
  /** Games still due after this cycle. */
  remaining: number;
  /** True when the cycle stopped early because HowLongToBeat is refusing. */
  blocked: boolean;
  durationMs: number;
}

function matchedDueBefore(): number {
  return Date.now() - config.hltbMaxAgeDays * 24 * 60 * 60 * 1000;
}

function unmatchedDueBefore(): number {
  return Date.now() - config.hltbUnmatchedRetryDays * 24 * 60 * 60 * 1000;
}

/**
 * Resolves up to `budget` due games. Concurrent calls share one run, so the
 * kick from an incoming request cannot pile up on the scheduled cycle.
 */
export function refreshHltb(
  budget = config.hltbBatchSize,
): Promise<HltbRefreshResult> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const started = Date.now();

    if (!config.hltbEnabled) {
      return {
        attempted: 0,
        matched: 0,
        unmatched: 0,
        failed: 0,
        remaining: 0,
        blocked: true,
        durationMs: 0,
      };
    }

    const due = selectDueGames(
      config.maxLookupFailures,
      matchedDueBefore(),
      unmatchedDueBefore(),
      budget,
    );

    let matched = 0;
    let unmatched = 0;
    let failed = 0;

    for (const game of due) {
      // Stop rather than queue behind a ten minute backoff.
      if (isHltbBlocked()) break;

      const lookup = await matchGame(game.appId, game.name);

      if (lookup.status === "failed") {
        failed++;
        // The lookup that trips the rate limit must not be charged to the game
        // it happened to be looking at. Counting it would let repeated blocks
        // push an entirely fine game past MAX_LOOKUP_FAILURES and out of the
        // queue for good.
        if (isHltbBlocked()) break;
        markGameLookupFailure(game.appId);
        continue;
      }

      // Written per game so that an interrupted cycle keeps its progress.
      if (lookup.status === "matched") {
        upsertHltb(
          {
            appId: game.appId,
            hltbId: lookup.match.hltbId,
            hltbName: lookup.match.hltbName,
            mainStory: lookup.match.mainStory,
            mainExtra: lookup.match.mainExtra,
            completionist: lookup.match.completionist,
            matched: true,
          },
          Date.now(),
        );
        matched++;
      } else {
        upsertHltb(
          {
            appId: game.appId,
            hltbId: null,
            hltbName: null,
            mainStory: null,
            mainExtra: null,
            completionist: null,
            matched: false,
          },
          Date.now(),
        );
        unmatched++;
      }

      markGameLookupSuccess(game.appId);
    }

    setMeta(LAST_REFRESH_KEY, String(started));
    setMeta(LAST_REFRESH_COUNT_KEY, String(matched + unmatched));
    pruneTrackedGames(config.trackedRetentionDays * 24 * 60 * 60 * 1000);

    const result: HltbRefreshResult = {
      attempted: due.length,
      matched,
      unmatched,
      failed,
      remaining: countDueGames(
        config.maxLookupFailures,
        matchedDueBefore(),
        unmatchedDueBefore(),
      ),
      blocked: isHltbBlocked(),
      durationMs: Date.now() - started,
    };

    if (result.attempted > 0) {
      console.log(
        `[hltb] resolved ${result.matched}/${result.attempted} games in ` +
          `${Math.round(result.durationMs / 1000)}s ` +
          `(no match: ${result.unmatched}, failed: ${result.failed}, ` +
          `still due: ${result.remaining})`,
      );
    }
    return result;
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

/**
 * Starts a cycle without waiting for it, used when a library request finds
 * games nobody has looked up yet. Safe to call on every request: a run already
 * in flight is reused rather than queued.
 */
export function kickHltbWorker(): void {
  if (!config.hltbEnabled || isHltbBlocked()) return;
  refreshHltb().catch((error) => {
    console.error(`[hltb] refresh failed: ${(error as Error).message}`);
  });
}

export function hltbStatus(): {
  matchedGames: number;
  unmatchedGames: number;
  dueGames: number;
  lastRefresh: number | null;
  lastRefreshItems: number | null;
  blocked: boolean;
  enabled: boolean;
} {
  const lastRefreshRaw = getMeta(LAST_REFRESH_KEY);
  const lastCountRaw = getMeta(LAST_REFRESH_COUNT_KEY);

  return {
    matchedGames: countHltbGames(true),
    unmatchedGames: countHltbGames(false),
    dueGames: countDueGames(
      config.maxLookupFailures,
      matchedDueBefore(),
      unmatchedDueBefore(),
    ),
    lastRefresh: lastRefreshRaw ? Number(lastRefreshRaw) : null,
    lastRefreshItems: lastCountRaw ? Number(lastCountRaw) : null,
    blocked: isHltbBlocked(),
    enabled: config.hltbEnabled,
  };
}

/** Starts the background cycle. A run with nothing due is a no-op. */
export function startHltbWorker(): NodeJS.Timeout {
  const run = () => {
    refreshHltb().catch((error) => {
      console.error(`[hltb] refresh failed: ${(error as Error).message}`);
    });
  };

  run();

  const timer = setInterval(run, config.hltbWorkerIntervalMinutes * 60_000);
  // Do not hold the event loop open purely for the refresh timer.
  timer.unref();
  return timer;
}
