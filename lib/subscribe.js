/**
 * The socket subscriber: one connection to one editor window.
 *
 * The extension runs the WebSocket **server** and this is the **client**, which
 * is also why this file has no dependency: Node ships a WebSocket client and no
 * server, so the half that needs a library is the one shipping in a VSIX.
 *
 * A connection is only useful after a `subscribe` frame, so this does not report
 * "connected" until the publisher has acknowledged with `subscribed` — otherwise
 * a token that is about to be rejected would look like a working link.
 *
 * Failures come in three kinds, and they are *not* interchangeable:
 *
 *   - the editor is not there (refused, window closed) — retry quietly, because
 *     a closed editor is the normal state for most of the day;
 *   - the link dropped after working — retry from the short delay;
 *   - the editor said no (bad token, wrong protocol) — stop. Retrying a refusal
 *     forever is noise that hides the one thing the user has to change.
 *
 * @module dsh-editor-context/subscribe
 */

/** Backoff floor; a publisher that is not running yet is a normal state. */
const DEFAULT_RETRY_MS = 3_000;

/** Backoff ceiling. An editor can be closed for hours and must not be hammered. */
const MAX_RETRY_MS = 30_000;

/** The protocol this client speaks. */
const PROTOCOL = 'editor-context/1';

/**
 * How long a subscribed socket may go without a frame before it is presumed
 * half-open. The extension pings every 30s, so silence for a minute and a half
 * means something that will never correct itself.
 */
const DEFAULT_WATCHDOG_MS = 90_000;

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
 * @param {number} [options.watchdogMs] - silence budget once open.
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
  watchdogMs = DEFAULT_WATCHDOG_MS,
}) {
  let socket;
  let stopped = true;
  let retry;
  let delay = retryMs;
  let acknowledged = false;
  let attempts = 0;
  let state = 'idle';
  let peer;
  /** Set when the publisher refused us. Retrying cannot fix a wrong token. */
  let halted = false;
  let watchdog;
  /** Ends the current attempt exactly once; see the note in `open()`. */
  let abandon = () => undefined;

  function clearWatchdog() {
    if (watchdog !== undefined) clearTimeout(watchdog);
    watchdog = undefined;
  }

  /** Any frame is proof of life; silence is what the watchdog is for. */
  function touch() {
    clearWatchdog();
    if (stopped) return;
    watchdog = setTimeout(() => {
      log(`no frame for ${String(watchdogMs)}ms; reconnecting`);
      // A half-open socket may never emit close on its own, so the retry cannot
      // wait for the transport to notice. `abandon` is the attempt's own guarded
      // teardown, so this schedules exactly one retry even if close does fire.
      abandon();
    }, watchdogMs);
    watchdog.unref?.();
  }

  function scheduleRetry() {
    clearWatchdog();
    abandon = () => undefined;
    acknowledged = false;
    if (state !== 'refused') state = 'absent';
    socket = undefined;
    if (stopped || halted) return;
    retry = setTimeout(() => {
      retry = undefined;
      void open();
    }, delay);
    // A closed editor must not be able to keep a process alive on its own.
    retry.unref?.();
    delay = Math.min(delay * 2, MAX_RETRY_MS);
  }

  /** Stop trying: the publisher answered in a way that repeating cannot change. */
  function halt(reason) {
    halted = true;
    state = 'refused';
    clearWatchdog();
    if (retry !== undefined) clearTimeout(retry);
    retry = undefined;
    try {
      socket?.close();
    } catch {
      // Already gone.
    }
    log(reason);
  }

  function handleFrame(raw) {
    touch();
    let frame;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      log('publisher sent a frame that is not JSON');
      return;
    }
    if (frame === null || typeof frame !== 'object') return;

    if (frame.type === 'hello') {
      // An older publisher may omit the protocol; only a *different* one is a
      // reason to stand down.
      if (typeof frame.protocol === 'string' && frame.protocol !== PROTOCOL) {
        halt(`publisher speaks ${frame.protocol}, this client speaks ${PROTOCOL}`);
        return;
      }
      peer = {
        pid: Number(frame.pid) || 0,
        appName: typeof frame.appName === 'string' ? frame.appName : '',
        workspaceFolders: Array.isArray(frame.workspaceFolders)
          ? frame.workspaceFolders.filter((folder) => typeof folder === 'string')
          : [],
        requiresToken: frame.requiresToken === true,
      };
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
      state = 'ready';
      delay = retryMs;
      log(`subscribed as "${String(frame.name)}" (text: ${String(frame.includeText)}, continuous: ${String(frame.autoSelection)})`);
      return;
    }
    if (frame.type === 'delivery' && frame.delivery !== null && typeof frame.delivery === 'object') {
      onDelivery(frame.delivery);
      return;
    }
    if (frame.type === 'error') {
      const message = String(frame.message);
      // A refusal is not a transient failure: a bad token will be just as bad in
      // thirty seconds, and saying so once is more useful than saying it often.
      if (/token/i.test(message)) {
        halt(`publisher refused: ${message}`);
        return;
      }
      log(`publisher refused: ${message}`);
    }
  }

  async function open() {
    if (stopped || halted) return;
    attempts += 1;
    state = 'connecting';
    // An async function called with `void` turns any unexpected throw into an
    // unhandled rejection, and an unhandled rejection here means the retry chain
    // dies silently: the subscriber stops existing and nothing says so. Every
    // path out of this function therefore schedules the next attempt.
    let candidate;
    try {
      log(`dialling ${url} (attempt ${String(attempts)})`);
      candidate = createSocket(url);
    } catch (error) {
      log(`could not dial ${url}: ${String(error && error.message ? error.message : error)}`);
      scheduleRetry();
      return;
    }

    let opened = false;
    let settled = false;
    /**
     * End this attempt exactly once and schedule the next.
     *
     * Node's built-in WebSocket does **not** emit `close` when the connection is
     * never established: a refused dial emits `error` and then leaves the socket
     * in `CONNECTING` forever. Trusting `close` to be the single retry trigger is
     * what made the chain die on the first `ECONNREFUSED` — the subscriber was
     * still "running", still logging nothing, and never dialling again.
     */
    const settle = () => {
      if (settled) return;
      settled = true;
      if (socket !== candidate) return;
      if (!acknowledged && !stopped) log(`disconnected before subscribing; retrying in ${String(delay)}ms`);
      // Abandon the half-open socket: left alone it stays CONNECTING, holding a
      // pending handshake that nothing will ever resolve.
      try {
        candidate.close();
      } catch {
        // Already closed, or never opened. Not worth reporting.
      }
      scheduleRetry();
    };
    abandon = settle;

    try {
      socket = candidate;
      candidate.addEventListener('open', () => {
        opened = true;
        state = 'connecting';
        log(`connected to ${url}`);
        touch();
      });
      candidate.addEventListener('message', (event) => {
        handleFrame(event?.data);
      });
      candidate.addEventListener('error', () => {
        // Only pre-open failures are settled here; a socket that did open reports
        // its death through `close` with a code, which is the more useful signal.
        if (!opened) settle();
      });
      candidate.addEventListener('close', () => {
        settle();
      });
    } catch (error) {
      log(`subscriber failed after dialling: ${String(error && error.message ? error.message : error)}`);
      scheduleRetry();
    }
  }

  return {
    /** Start dialling, and keep dialling. Safe to call twice. */
    start() {
      if (!stopped) return;
      log(`starting subscriber for ${url}`);
      stopped = false;
      halted = false;
      state = 'idle';
      attempts = 0;
      delay = retryMs;
      void open();
    },
    /** Stop dialling and close the socket. */
    stop() {
      stopped = true;
      clearWatchdog();
      if (retry !== undefined) clearTimeout(retry);
      retry = undefined;
      acknowledged = false;
      state = 'idle';
      const current = socket;
      socket = undefined;
      try {
        current?.close();
      } catch {
        // Closing a socket that never opened is not an error worth reporting.
      }
    },
    /** Allow a refused endpoint to be tried again, e.g. after it reappears. */
    reset() {
      if (!halted) return;
      halted = false;
      attempts = 0;
      delay = retryMs;
      state = 'idle';
      if (!stopped) void open();
    },
    /** Whether the publisher has acknowledged this subscriber. */
    get subscribed() {
      return acknowledged;
    },
    /** How many dial attempts have been made since `start`. */
    get attempts() {
      return attempts;
    },
    /** `idle` | `connecting` | `ready` | `refused` | `absent`. */
    get state() {
      return state;
    },
    /** What the publisher said about itself, once it has introduced itself. */
    get peer() {
      return peer;
    },
    /** The endpoint this subscriber dials. */
    get url() {
      return url;
    },
  };
}
