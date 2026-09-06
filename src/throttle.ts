/**
 * A serialised request queue with a circuit breaker, shared by every outbound
 * scraper in this service.
 *
 * Both Steam and HowLongToBeat answer a burst with 429 and then keep refusing
 * for minutes afterwards, so requests are spaced out by a fixed delay and a
 * single 429 pauses the whole queue rather than just the request that saw it.
 * Each remote gets its own instance: a HowLongToBeat block says nothing about
 * whether Steam is reachable.
 */

export interface ThrottledQueue {
  /**
   * Queues a task behind everything already pending. Resolves with undefined
   * when the task throws or the breaker is open, so callers can treat a failed
   * lookup exactly like a missing result.
   */
  run<T>(task: () => Promise<T>): Promise<T | undefined>;
  /** Opens the breaker, typically after a 429. */
  block(): void;
  isBlocked(): boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createThrottledQueue(options: {
  /** Used in log lines so a blocked queue is attributable. */
  label: string;
  /** Pause after every task, whether it succeeded or not. */
  delayMs: number;
  /** How long the breaker stays open once tripped. */
  blockMs: number;
}): ThrottledQueue {
  /** Timestamp until which the remote is not contacted again. */
  let blockedUntil = 0;
  /** Tail of the promise chain that serialises all outgoing requests. */
  let queue: Promise<unknown> = Promise.resolve();

  const isBlocked = (): boolean => Date.now() < blockedUntil;

  return {
    isBlocked,

    block(): void {
      blockedUntil = Date.now() + options.blockMs;
      console.warn(
        `[${options.label}] rate limited, pausing requests for ` +
          `${Math.round(options.blockMs / 60_000)} minute(s)`,
      );
    },

    run<T>(task: () => Promise<T>): Promise<T | undefined> {
      // Nothing to gain from queueing behind a breaker that is already open;
      // returning now also skips the delay a queued task would have burned.
      if (isBlocked()) return Promise.resolve(undefined);

      const queued = queue.then(async (): Promise<T | undefined> => {
        try {
          return await task();
        } catch (error) {
          console.warn(
            `[${options.label}] request failed: ${(error as Error).message}`,
          );
          return undefined;
        } finally {
          // Always pace, so a fast failure cannot turn into a burst of retries.
          await sleep(options.delayMs);
        }
      });

      // Keep the chain alive even if a task rejects.
      queue = queued.catch(() => undefined);
      return queued;
    },
  };
}
