/**
 * Build a queue.
 *
 * @param {object} [options]
 * @param {number} [options.maxAgeMs] - drop entries older than this; negative disables the check.
 * @param {() => number} [options.now] - clock, for tests.
 * @returns {object} the queue.
 */
export function createDeliveryQueue({ maxAgeMs, now }?: {
    maxAgeMs?: number;
    now?: () => number;
}): object;
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
export const DEFAULT_REQUEST_PATH: "/editor-context/next";
/** How long a long poll parks before answering "nothing yet". */
export const DEFAULT_HOLD_MS: 25000;
