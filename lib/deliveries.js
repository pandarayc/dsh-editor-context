/**
 * The delivery queue: events pushed in over the socket, held until a browser
 * asks for them.
 *
 * Two hops, two different problems. Extension → host is a WebSocket push
 * (`lib/subscribe.js`), because a socket is the only transport that needs no
 * polling on either side. Host → browser cannot be a socket: the browser's half
 * of this plugin is a cordis plugin with no server of its own, so it asks with a
 * long poll and this queue is what parks that request until there is something
 * to answer it with.
 *
 * Nothing here touches the filesystem. Until 0.5.0 the queue was fed by watching
 * the editor's `requests/` directory; the socket made that whole path — the
 * watcher, the scan, the debounce, the sequence derived from mtimes —
 * unnecessary.
 *
 * @module dsh-editor-context/deliveries
 */

/** Route path of the long poll. */
export const DEFAULT_REQUEST_PATH = '/editor-context/next';

/** How long a long poll parks before answering "nothing yet". */
export const DEFAULT_HOLD_MS = 25_000;

/** How many delivered entries to retain for a consumer that is catching up. */
const MAX_ENTRIES = 64;

/**
 * Build a queue.
 *
 * @param {object} [options]
 * @param {number} [options.maxAgeMs] - drop entries older than this; negative disables the check.
 * @param {() => number} [options.now] - clock, for tests.
 * @returns {object} the queue.
 */
export function createDeliveryQueue({ maxAgeMs = 3_600_000, now = Date.now } = {}) {
  /** Delivered entries, ascending by `seq`. */
  let entries = [];
  const waiters = new Set();
  let seq = 0;

  const isFresh = (at) => maxAgeMs < 0 || now() - at <= maxAgeMs;

  /** Forget entries that have aged out, keeping the queue bounded. */
  function expire() {
    entries = entries.filter((entry) => isFresh(entry.at)).slice(-MAX_ENTRIES);
  }

  /**
   * The next undelivered entry a reader at `since` should receive.
   * @param {number} since - the last `seq` the reader has seen.
   * @returns {undefined | object} the entry.
   */
  function take(since) {
    expire();
    return entries.find((entry) => entry.seq > since && isFresh(entry.at));
  }

  /** Hand every waiting reader whatever it is now entitled to. */
  function wake() {
    for (const waiter of [...waiters]) {
      const entry = take(waiter.since);
      if (entry !== undefined) waiter.settle(entry);
    }
  }

  return {
    /** Highest sequence number handed out so far. */
    get latest() {
      return seq;
    },

    /** How many entries are currently held. */
    get size() {
      expire();
      return entries.length;
    },

    /**
     * Accept one delivery from the transport.
     * @param {object} delivery - the `delivery` field of a socket frame.
     * @returns {number} the sequence number assigned.
     */
    push(delivery) {
      seq += 1;
      entries.push({ seq, at: now(), delivery });
      expire();
      wake();
      return seq;
    },

    /**
     * The next delivery after `since`, or `undefined` on timeout or abort.
     * @param {number} since - the last `seq` the caller has seen.
     * @param {object} [options]
     * @param {AbortSignal} [options.signal] - caller went away.
     * @param {number} [options.timeoutMs] - how long to hold the promise open.
     * @returns {Promise<undefined | object>} the entry.
     */
    waitFor(since, { signal, timeoutMs = DEFAULT_HOLD_MS } = {}) {
      const ready = take(since);
      if (ready !== undefined) return Promise.resolve(ready);
      if (signal?.aborted === true) return Promise.resolve(undefined);
      return new Promise((resolve) => {
        let timer;
        const waiter = {
          since,
          settle(value) {
            clearTimeout(timer);
            waiters.delete(waiter);
            signal?.removeEventListener('abort', onAbort);
            resolve(value);
          },
        };
        const onAbort = () => waiter.settle(undefined);
        timer = setTimeout(() => waiter.settle(undefined), timeoutMs);
        signal?.addEventListener('abort', onAbort, { once: true });
        waiters.add(waiter);
      });
    },

    /** Release every parked reader; used when the plugin unloads. */
    stop() {
      for (const waiter of [...waiters]) waiter.settle(undefined);
    },
  };
}
