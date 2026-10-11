/**
 * Rations an expensive action per key: at most one per cooldown window.
 *
 * Used for forced library refreshes, which bypass the profile and library
 * caches and therefore cost Web API calls every time. Kept in memory rather
 * than in SQLite: losing the state on a restart only allows one refresh early,
 * which is harmless, and it keeps a button press from becoming a database
 * write.
 *
 * Separate from `steamLibrary.ts` so it can be tested without a database,
 * a configuration or a network - the clock is injected for the same reason.
 */
export class RefreshCooldown {
  /** Key to the moment its last claim went through. */
  private readonly lastClaim = new Map<string, number>();

  constructor(
    /** Read on every call, so a changed value applies without a new instance. */
    private readonly cooldownMs: () => number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Earliest moment the next claim for this key succeeds. Equal to or before
   * the current time when a claim would succeed right now.
   */
  availableAt(key: string): number {
    const last = this.lastClaim.get(key);
    return last === undefined ? this.now() : last + this.cooldownMs();
  }

  /**
   * Returns true and records the claim when the key is outside its cooldown,
   * false otherwise.
   *
   * Callers claim before doing the expensive work, not after it succeeds, so
   * two simultaneous requests cannot both get through, and a failed attempt
   * still counts - it spent the calls all the same.
   *
   * Expired entries are dropped on every claim, which keeps the map as small
   * as the number of keys claimed within one window.
   */
  claim(key: string): boolean {
    const now = this.now();
    const cooldownMs = this.cooldownMs();

    for (const [id, at] of this.lastClaim) {
      if (now - at >= cooldownMs) this.lastClaim.delete(id);
    }

    if (this.lastClaim.has(key)) return false;

    this.lastClaim.set(key, now);
    return true;
  }

  /** Number of keys currently inside their cooldown window, for tests. */
  get size(): number {
    return this.lastClaim.size;
  }
}
