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
export function positionPayload(position: any): {
    absolutePath: any;
    workspacePath: any;
    selection: {
        startLine: any;
        endLine: any;
        isEmpty: boolean;
    };
    updatedAt: any;
};
/**
 * Build the `webServer.register` route for the position endpoint.
 * @param options.readPosition - injected reader, so this stays unit-testable.
 * @param options.stateDir - published-state directory.
 * @param options.maxAgeMs - staleness budget, forwarded to the reader.
 * @param options.path - route path; defaults to {@link DEFAULT_HTTP_PATH}.
 * @returns a route descriptor for `ctx.webServer.register`.
 */
export function createPositionRoute({ readPosition, stateDir, maxAgeMs, path }: {
    readPosition: any;
    stateDir: any;
    maxAgeMs: any;
    path?: string;
}): {
    kind: string;
    path: string;
    handler: (req: any, res: any) => Promise<void>;
};
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
export function deliveryPayload(delivery: any): {
    absolutePath: any;
    workspacePath: any;
    selection: any;
    address: any;
    text: any;
    textTruncated: boolean;
    updatedAt: any;
};
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
export function createRequestRoute({ queue, holdMs, path }: {
    queue: any;
    holdMs?: number;
    path?: string;
}): {
    kind: string;
    path: string;
    handler: (req: any, res: any) => Promise<void>;
};
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
export function createEditorsRoute({ status, path }: {
    status: any;
    path?: string;
}): {
    kind: string;
    path: string;
    handler: (req: any, res: any) => Promise<void>;
};
/** Default route path. */
export const DEFAULT_HTTP_PATH: "/editor-context/position";
/** Default route path for the connected-editor list. */
export const DEFAULT_EDITORS_PATH: "/editor-context/editors";
/** How long a long poll parks before answering "nothing yet". */
export const DEFAULT_REQUEST_HOLD_MS: 25000;
