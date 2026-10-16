/**
 * The socket subscriber: the host half's connection to the editor extension.
 *
 * The extension runs the WebSocket **server** and this is the **client**, which
 * is also why this file has no dependency: Node ships a WebSocket client and no
 * server, so the half that needs a library is the one shipping in a VSIX.
 *
 * A connection is only useful after a `subscribe` frame, so this does not report
 * "connected" until the publisher has acknowledged with `subscribed` — otherwise
 * a token that is about to be rejected would look like a working link.
 *
 * @module dsh-editor-context/subscribe
 */

/** Backoff floor; a publisher that is not running yet is a normal state. */
const DEFAULT_RETRY_MS = 3_000;

/** Backoff ceiling. An editor can be closed for hours and must not be hammered. */
const MAX_RETRY_MS = 30_000;

/**
 * Connect to a publisher and hand it every delivery.
 *
 * @param {object} options
 * @param {string} options.url - `ws://host:port/path`.
 * @param {string} [options.token] - shared secret, when the publisher wants one.
 * @param {string} [options.name] - subscriber identity, used as a send target.
 * @param {string} [options.label] - how the editor's picker names this subscriber.
 * @param {boolean} [options.includeText] - whether deliveries should carry the selection text.
 * @param {boolean} [options.autoSelection] - whether to receive a continuous feed.
 * @param {(delivery: object) => void} [options.onDelivery] - called per event.
 * @param {(message: string) => void} [options.log] - lifecycle narration.
 * @param {(url: string) => object} [options.createSocket] - socket factory, for tests.
 * @param {number} [options.retryMs] - first retry delay.
 * @returns {object} the subscriber.
 */
export function createSubscriber({
  url,
  token = '',
  name = 'dsh',
  label = 'DSH',
  includeText = true,
  autoSelection = false,
  onDelivery = () => undefined,
  log = () => undefined,
  createSocket = (target) => new WebSocket(target),
  retryMs = DEFAULT_RETRY_MS,
}) {
  let socket;
  let stopped = true;
  let retry;
  let delay = retryMs;
  let acknowledged = false;
  let attempts = 0;

  function scheduleRetry() {
    acknowledged = false;
    socket = undefined;
    if (stopped) return;
    retry = setTimeout(() => {
      retry = undefined;
      void open();
    }, delay);
    // A closed editor must not be able to keep a process alive on its own.
    retry.unref?.();
    delay = Math.min(delay * 2, MAX_RETRY_MS);
  }

  function handleFrame(raw) {
    let frame;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      log('publisher sent a frame that is not JSON');
      return;
    }
    if (frame === null || typeof frame !== 'object') return;

    if (frame.type === 'hello') {
      const request = { type: 'subscribe', name, label, includeText, autoSelection };
      // Sent when the publisher asks for it or when we have one to offer: a
      // publisher with no token configured ignores the field either way.
      if (frame.requiresToken === true || token !== '') request.token = token;
      try {
        socket?.send(JSON.stringify(request));
      } catch {
        // The close handler will schedule the retry.
      }
      return;
    }
    if (frame.type === 'subscribed') {
      acknowledged = true;
      delay = retryMs;
      log(`subscribed as "${String(frame.name)}" (text: ${String(frame.includeText)}, continuous: ${String(frame.autoSelection)})`);
      return;
    }
    if (frame.type === 'delivery' && frame.delivery !== null && typeof frame.delivery === 'object') {
      onDelivery(frame.delivery);
      return;
    }
    if (frame.type === 'error') {
      // Refusals are not retried harder: a bad token will be just as bad in
      // thirty seconds, and saying so once is more useful than saying it often.
      log(`publisher refused: ${String(frame.message)}`);
    }
  }

  async function open() {
    if (stopped) return;
    attempts += 1;
    let candidate;
    try {
      candidate = createSocket(url);
    } catch (error) {
      log(`could not dial ${url}: ${String(error && error.message ? error.message : error)}`);
      scheduleRetry();
      return;
    }
    socket = candidate;
    candidate.addEventListener('open', () => {
      log(`connected to ${url}`);
    });
    candidate.addEventListener('message', (event) => {
      handleFrame(event?.data);
    });
    candidate.addEventListener('error', () => {
      // Node's WebSocket always follows an error with a close, which is where the
      // retry is scheduled; logging here would double every failure.
    });
    candidate.addEventListener('close', () => {
      if (socket !== candidate) return;
      if (!acknowledged && !stopped) log(`disconnected before subscribing; retrying in ${String(delay)}ms`);
      scheduleRetry();
    });
  }

  return {
    /** Start dialling, and keep dialling. Safe to call twice. */
    start() {
      if (!stopped) return;
      stopped = false;
      attempts = 0;
      delay = retryMs;
      void open();
    },
    /** Stop dialling and close the socket. */
    stop() {
      stopped = true;
      if (retry !== undefined) clearTimeout(retry);
      retry = undefined;
      acknowledged = false;
      const current = socket;
      socket = undefined;
      try {
        current?.close();
      } catch {
        // Closing a socket that never opened is not an error worth reporting.
      }
    },
    /** Whether the publisher has acknowledged this subscriber. */
    get subscribed() {
      return acknowledged;
    },
    /** How many dial attempts have been made since `start`. */
    get attempts() {
      return attempts;
    },
  };
}
