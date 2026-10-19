/**
 * The links to every editor window, kept in step with the registry.
 *
 * A subscriber dials one URL and stays on it. Which URLs exist is not its
 * business — that is the registry's job, and it changes under us: a window
 * closes, another opens on a different port, the extension restarts. So this
 * layer owns *membership* and the subscriber owns *the wire*.
 *
 * The rule that makes it cheap: reconcile, don't notify. Every `rescanMs` the
 * directory is read again, links that are no longer wanted are stopped, and
 * links that appeared are started. Nothing has to watch anything, and a missed
 * event costs one rescan rather than a dead feature.
 *
 * When the registry yields nothing, the configured URL is dialled instead. That
 * is the pre-registry extension (and the "user pointed us at a port by hand"
 * case), and it is why this change needs no coordination with an install order.
 *
 * @module dsh-editor-context/link
 */

import { readEndpoints } from './registry.js';
import { createSubscriber } from './subscribe.js';

/** How often membership is re-read. Cheap: a small directory, once every 15s. */
export const DEFAULT_RESCAN_MS = 15_000;

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
 * @param {number} [options.rescanMs] - membership refresh interval.
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
  rescanMs = DEFAULT_RESCAN_MS,
  retryMs,
  watchdogMs,
  discover = (dir) => readEndpoints(dir),
  connect = createSubscriber,
}) {
  /** @type {Map<string, object>} url → subscriber */
  const links = new Map();
  let timer;
  let started = false;
  let scanning = false;

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
      ...(retryMs === undefined ? {} : { retryMs }),
      ...(watchdogMs === undefined ? {} : { watchdogMs }),
    });
    links.set(url, subscriber);
    subscriber.start();
    return subscriber;
  }

  async function reconcile() {
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

  function schedule() {
    if (!started) return;
    timer = setTimeout(() => {
      void tick();
    }, rescanMs);
    timer.unref?.();
  }

  async function tick() {
    if (!started) return;
    if (scanning) {
      schedule();
      return;
    }
    scanning = true;
    try {
      await reconcile();
    } finally {
      scanning = false;
      schedule();
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
      for (const subscriber of links.values()) subscriber.stop();
      links.clear();
    },
    /** Re-read membership now, rather than at the next tick. */
    refresh() {
      return reconcile();
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
      return { subscribed: connections.some((link) => link.subscribed), connections };
    },
  };
}
