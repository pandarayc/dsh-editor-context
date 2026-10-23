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
 * @param {(next: string, previous: string) => void} [options.onStateChange] - lifecycle hook.
 * @returns {object} the subscriber.
 */
export function createSubscriber({ url, token, name, label, includeText, autoSelection, onDelivery, log, createSocket, retryMs, watchdogMs, onStateChange, }: {
    url: string;
    token?: string;
    name?: string;
    label?: string;
    includeText?: boolean;
    autoSelection?: boolean;
    onDelivery?: (delivery: object) => void;
    log?: (message: string) => void;
    createSocket?: (url: string) => object;
    retryMs?: number;
    watchdogMs?: number;
    onStateChange?: (next: string, previous: string) => void;
}): object;
