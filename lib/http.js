/**
 * Read-only endpoints for the browser-side composer source.
 *
 * The browser cannot read `~/.editor-context/`, so the client half of this
 * plugin asks the host over same-origin HTTP. Two routes, both read-only:
 *
 *   GET /editor-context/position   the current address, or 404
 *   GET /editor-context/next       long poll: the next delivery pushed over the
 *                                  socket from the editor, or 204 on timeout
 *
 * Neither ever returns file contents.
 *
 * @module dsh-editor-context/http
 */

import { DEFAULT_REQUEST_PATH } from './deliveries.js';

/** Default route path. */
export const DEFAULT_HTTP_PATH = '/editor-context/position';

/** Default route path for the connected-editor list. */
export const DEFAULT_EDITORS_PATH = '/editor-context/editors';

/** How long a long poll parks before answering "nothing yet". */
export const DEFAULT_REQUEST_HOLD_MS = 25_000;

/**
 * Project one reading into the wire shape the client half consumes.
 *
 * The editor's name is deliberately not carried: the payload addresses a path,
 * and which application that path is open in changes nothing about how it is
 * read.
 *
 * @param position - a reading from `readPosition`.
 * @returns the JSON-serializable payload.
 */
export function positionPayload(position) {
  const selection = position.selection;
  return {
    absolutePath: position.activeFile !== '' ? position.activeFile : position.relativePath,
    // Relative to the *editor's* workspace root, which is generally not the
    // agent's working directory. Carried for display; never used to address.
    workspacePath: position.relativePath,
    selection:
      selection === null || selection === undefined
        ? null
        : { startLine: selection.startLine, endLine: selection.endLine, isEmpty: selection.isEmpty === true },
    updatedAt: position.updatedAt,
  };
}

/**
 * Build the `webServer.register` route for the position endpoint.
 * @param options.readPosition - injected reader, so this stays unit-testable.
 * @param options.stateDir - published-state directory.
 * @param options.maxAgeMs - staleness budget, forwarded to the reader.
 * @param options.path - route path; defaults to {@link DEFAULT_HTTP_PATH}.
 * @returns a route descriptor for `ctx.webServer.register`.
 */
export function createPositionRoute({ readPosition, stateDir, maxAgeMs, path = DEFAULT_HTTP_PATH }) {
  return {
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' });
        res.end();
        return;
      }
      // `?pid=` asks for one window rather than the most recently touched one:
      // with two editors open, "newest" is a guess about which one the user meant.
      const asked = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('pid');
      const pid = asked === null ? undefined : Number(asked);
      const position = await readPosition(stateDir, maxAgeMs, Number.isInteger(pid) && pid > 0 ? pid : undefined);
      // `context: ''` is the one "do not publish" signal on the wire: an exclude
      // glob rejected the path, or no file is open. A bare 404 keeps the first
      // case from leaking the very path it is meant to hide.
      if (position === undefined || position.context === '') {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      const body = JSON.stringify({ ok: true, ...positionPayload(position) });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        // A position is live state; a cached one is a wrong one.
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    },
  };
}

/**
 * Project one delivery from the editor into the shape the browser half reads.
 *
 * The editor sends the delivery whole; the browser wants an address, a range and
 * the text, so this narrows rather than reshapes. `text` is carried through
 * because a delivery is a snapshot: the file may have moved on by the time the
 * user sends, and the point of shipping the text is that the original survives
 * that.
 * @param delivery - the `delivery` field of a socket frame.
 * @returns the JSON-serializable payload.
 */
export function deliveryPayload(delivery) {
  return {
    absolutePath: delivery.activeFile !== '' ? delivery.activeFile : delivery.relativePath,
    workspacePath: delivery.relativePath,
    selection: delivery.selection ?? null,
    address: typeof delivery.address === 'string' ? delivery.address : '',
    text: typeof delivery.text === 'string' ? delivery.text : '',
    textTruncated: delivery.textTruncated === true,
    updatedAt: delivery.updatedAt !== '' ? delivery.updatedAt : delivery.at,
  };
}

/**
 * Build the long-poll route that delivers positions the user clicked in the
 * editor.
 *
 * There is no interval here on purpose. The caller asks "anything after `seq`?"
 * and the promise parks until the queue's file watcher wakes it, so an idle
 * conversation costs one open response rather than one request per second.
 *
 * @param options.queue - a queue from `createDeliveryQueue`.
 * @param [options.holdMs] - how long to park before answering "nothing yet".
 * @param [options.path] - route path; defaults to the queue's own.
 * @returns a route descriptor for `ctx.webServer.register`.
 */
export function createRequestRoute({ queue, holdMs = DEFAULT_REQUEST_HOLD_MS, path = DEFAULT_REQUEST_PATH }) {
  return {
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' });
        res.end();
        return;
      }
      const raw = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('since');
      const parsed = Number(raw);
      const asked = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
      /**
       * A reader that has seen nothing starts **now**, not at the beginning.
       *
       * The queue is a push, not a mailbox: replaying it means a page reload or a
       * host restart injects a click from minutes ago into a draft the user is
       * typing in. `since=0` is the client's "I have no cursor yet", and a cursor
       * ahead of the queue means the host restarted under it — both mean "start
       * from the current head", and both are indistinguishable from a stall to
       * the user.
       */
      const since = asked === 0 || asked > queue.latest ? queue.latest : asked;

      // A closed tab must release the parked promise, or the waiter set grows
      // for as long as the process lives.
      const gone = new AbortController();
      req.on('close', () => gone.abort());

      const entry = await queue.waitFor(since, { signal: gone.signal, timeoutMs: holdMs });
      if (entry === undefined) {
        // "Nothing yet, ask again" — the client re-issues immediately.
        res.writeHead(204, { 'cache-control': 'no-store' });
        res.end();
        return;
      }
      const body = JSON.stringify({ ok: true, seq: entry.seq, ...deliveryPayload(entry.delivery) });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
    },
  };
}

/**
 * Build the route that answers "which editor windows are linked".
 *
 * Named `editors`, not `status`: `status` describes a whole process, and this
 * describes one thing — the windows this plugin is talking to. The interesting
 * failure here is silence (a plugin with no socket looks exactly like a user who
 * has not pressed anything), and a name nobody can guess is part of that failure.
 *
 * @param options.status - returns `{subscribed, connections}`.
 * @param options.path - route path; defaults to {@link DEFAULT_EDITORS_PATH}.
 * @returns a route descriptor for `ctx.webServer.register`.
 */
export function createEditorsRoute({ status, path = DEFAULT_EDITORS_PATH }) {
  return {
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' });
        res.end();
        return;
      }
      let body;
      try {
        body = JSON.stringify({ ok: true, ...status() });
      } catch {
        // A status route must never be the reason something else fails.
        body = JSON.stringify({ ok: false });
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        // Live state: a cached answer is a wrong answer.
        'cache-control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    },
  };
}
