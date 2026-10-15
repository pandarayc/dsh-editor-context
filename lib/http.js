/**
 * Read-only position endpoint for the browser-side composer source.
 *
 * The browser cannot read `~/.editor-context/windows/`, so the client half of
 * this plugin asks the host over same-origin HTTP. The payload is the same
 * reading the `/ide` command already uses, minus the prose: an address, an
 * editor name, and the selection, or a 404 when there is nothing current.
 *
 * Nothing secret crosses: the bytes returned are already a world-readable file
 * the user's own editor wrote, and the route serves addresses only — never file
 * contents.
 *
 * @module dsh-editor-context/http
 */

/** Default route path. */
export const DEFAULT_HTTP_PATH = '/editor-context/position';

/**
 * Project one reading into the wire shape the client half consumes.
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
    appName: position.appName,
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
      const position = await readPosition(stateDir, maxAgeMs);
      // An excluded path publishes `context: ''`; a 404 keeps the exclusion
      // rule from leaking the very path it is meant to hide.
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
