/**
 * The links to every editor window, kept in step with the registry.
 *
 * A subscriber dials one URL and stays on it. Which URLs exist is not its
 * business — that is the registry's job, and it changes under us: a window
 * closes, another opens on a different port, the extension restarts. So this
 * layer owns *membership* and the subscriber owns *the wire*.
 *
 * The rule that makes it cheap: reconcile, don't notify. The directory is read
 * again on a timer, links that are no longer wanted are stopped, and links that
 * appeared are started. Nothing has to watch anything, and a missed event costs
 * one rescan rather than a dead feature.
 *
 * Two things keep that timer honest:
 *
 *   - the interval **adapts**: while something is missing it runs every 5s,
 *     because that is when a scan can find a window; once every link is ready,
 *     the only thing a scan can find is a *new* window, so it drops to once a
 *     minute. Same information, a quarter of the wakeups — and faster when it
 *     matters, which is the part that was wrong before.
 *   - a link that leaves `ready` triggers a scan within a second, so a closed
 *     window is dropped immediately instead of being retried until the next
 *     slow tick.
 *
 * When the registry yields nothing, the configured URL is dialled instead. That
 * is the pre-registry extension (and the "user pointed us at a port by hand"
 * case), and it is why this change needs no coordination with an install order.
 *
 * @module dsh-editor-context/link
 */

import { readEndpoints } from './registry.js';
import { createSubscriber } from './subscribe.js';

/** How often membership is re-read once everything is connected. */
export const DEFAULT_SLOW_MS = 60_000;

/** How often membership is re-read while something is missing. */
export const DEFAULT_FAST_MS = 5_000;

/** How long to wait after a link leaves `ready` before re-reading. */
export const DEFAULT_DEBOUNCE_MS = 1_000;

/**
 * Pick the next scan delay.
 *
 * Exported because it is the whole policy, and it is worth testing without
 * waiting a minute for a timer.
 * @param {object} input
 * @param {number} input.ready - links that are subscribed.
 * @param {number} input.total - links held.
 * @param {number} [input.fastMs] - delay while something is missing.
 * @param {number} [input.slowMs] - delay when everything is connected.
 * @returns {number} milliseconds.
 */
export function scanInterval({ ready, total, fastMs = DEFAULT_FAST_MS, slowMs = DEFAULT_SLOW_MS }) {
  return total > 0 && ready === total ? slowMs : fastMs;
}

/**
 * Keep one subscriber per live editor window.
 *
 * @param {object} options
 * @param {string} options.stateDir - published-state directory.
 * @param {string} [options.fallbackUrl] - dialled when the registry is empty.
 * @param {string} [options.token] - shared secret.
 * @param {string} [options.name] - subscriber identity.
 * @param {string} [options.label] - how the editor's picker names this subscriber.
 * @param {boolean} [options.includeText] - whether deliveries carry the selection text.
 * @param {boolean} [options.autoSelection] - whether to receive a continuous feed.
 * @param {(delivery: object) => void} [options.onDelivery] - called per event.
 * @param {(message: string) => void} [options.log] - lifecycle narration.
 * @param {number} [options.fastMs] - scan delay while something is missing.
 * @param {number} [options.slowMs] - scan delay when everything is connected.
 * @param {number} [options.debounceMs] - delay before reacting to a dropped link.
 * @param {number} [options.rescanMs] - one fixed delay, for tests: overrides both.
 * @param {number} [options.retryMs] - forwarded to each subscriber.
 * @param {number} [options.watchdogMs] - forwarded to each subscriber.
 * @param {(dir: string) => Promise<object[]>} [options.discover] - registry reader, for tests.
 * @param {(options: object) => object} [options.connect] - subscriber factory, for tests.
 * @returns {object} the link manager.
 */
export function createLink({
  stateDir,
  fallbackUrl = '',
  token = '',
  name = 'dsh',
  label = 'DSH',
  includeText = true,
  autoSelection = false,
  onDelivery = () => undefined,
  log = () => undefined,
  fastMs = DEFAULT_FAST_MS,
  slowMs = DEFAULT_SLOW_MS,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  rescanMs,
  retryMs,
  watchdogMs,
  discover = (dir) => readEndpoints(dir),
  connect = createSubscriber,
}) {
  const fast = rescanMs ?? fastMs;
  const slow = rescanMs ?? slowMs;

  /** @type {Map<string, object>} url → subscriber */
  const links = new Map();
  let timer;
  let dueAt;
  let started = false;
  let scanning = false;
  let scans = 0;

  function nextDelay() {
    let ready = 0;
    for (const subscriber of links.values()) if (subscriber.subscribed) ready += 1;
    return scanInterval({ ready, total: links.size, fastMs: fast, slowMs: slow });
  }

  function schedule(delay) {
    if (!started) return;
    if (timer !== undefined) clearTimeout(timer);
    dueAt = Date.now() + delay;
    timer = setTimeout(() => {
      timer = undefined;
      dueAt = undefined;
      void tick();
    }, delay);
    timer.unref?.();
  }

  /**
   * Scan soon, but not sooner than the debounce.
   *
   * Called when a link leaves `ready`: at that moment the window may have
   * vanished, and the registry is the only thing that can say so. Waiting for
   * the next slow tick would mean up to a minute of pointless redials.
   */
  function armRescan() {
    if (!started) return;
    const due = Date.now() + debounceMs;
    if (dueAt !== undefined && dueAt <= due) return;
    schedule(debounceMs);
  }

  function build(url) {
    const subscriber = connect({
      url,
      token,
      name,
      label,
      includeText,
      autoSelection,
      onDelivery,
      log,
      onStateChange: (next, previous) => {
        if (previous === 'ready' && next !== 'ready') armRescan();
      },
      ...(retryMs === undefined ? {} : { retryMs }),
      ...(watchdogMs === undefined ? {} : { watchdogMs }),
    });
    links.set(url, subscriber);
    subscriber.start();
    return subscriber;
  }

  async function reconcile() {
    scans += 1;
    let endpoints = [];
    try {
      endpoints = await discover(stateDir);
    } catch (error) {
      log(`could not read the endpoint registry: ${String(error && error.message ? error.message : error)}`);
    }
    const wanted = new Map();
    for (const endpoint of endpoints) wanted.set(endpoint.url, endpoint);
    if (wanted.size === 0 && fallbackUrl !== '') wanted.set(fallbackUrl, { url: fallbackUrl });

    for (const [url, subscriber] of [...links]) {
      if (wanted.has(url)) continue;
      subscriber.stop();
      links.delete(url);
      log(`editor window gone: ${url}`);
    }
    for (const [url, endpoint] of wanted) {
      if (links.has(url)) continue;
      build(url);
      // The fallback has no identity to report; saying "undefined (pid undefined)"
      // in the log is the kind of line that makes a working system look broken.
      const who =
        typeof endpoint.appName === 'string' && endpoint.appName !== ''
          ? `${endpoint.appName} (pid ${String(endpoint.pid)})`
          : 'configured endpoint';
      log(`found ${who} at ${url}`);
    }
    return [...wanted.values()];
  }

  async function tick() {
    if (!started) return;
    if (scanning) {
      schedule(nextDelay());
      return;
    }
    scanning = true;
    try {
      await reconcile();
    } finally {
      scanning = false;
      schedule(nextDelay());
    }
  }

  return {
    /** Start dialling every window the registry knows about. Safe to call twice. */
    start() {
      if (started) return;
      started = true;
      void tick();
    },
    /** Stop every subscriber and every scan. */
    stop() {
      started = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      dueAt = undefined;
      for (const subscriber of links.values()) subscriber.stop();
      links.clear();
    },
    /** Re-read membership now, rather than at the next tick. */
    async refresh() {
      const found = await reconcile();
      schedule(nextDelay());
      return found;
    },
    /**
     * What the plugin currently knows, for the status route.
     * @returns {{subscribed: boolean, connections: object[]}}
     */
    status() {
      const connections = [...links.entries()].map(([url, subscriber]) => ({
        url,
        state: subscriber.state,
        subscribed: subscriber.subscribed,
        attempts: subscriber.attempts,
        peer: subscriber.peer ?? null,
      }));
      return {
        subscribed: connections.some((link) => link.subscribed),
        // The cadence is the part that is invisible from outside, and the part
        // that decides how many times this process wakes up.
        scan: { intervalMs: nextDelay(), scans },
        connections,
      };
    },
  };
}
