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
export function scanInterval({ ready, total, fastMs, slowMs }: {
    ready: number;
    total: number;
    fastMs?: number;
    slowMs?: number;
}): number;
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
export function createLink({ stateDir, fallbackUrl, token, name, label, includeText, autoSelection, onDelivery, log, fastMs, slowMs, debounceMs, rescanMs, retryMs, watchdogMs, discover, connect, }: {
    stateDir: string;
    fallbackUrl?: string;
    token?: string;
    name?: string;
    label?: string;
    includeText?: boolean;
    autoSelection?: boolean;
    onDelivery?: (delivery: object) => void;
    log?: (message: string) => void;
    fastMs?: number;
    slowMs?: number;
    debounceMs?: number;
    rescanMs?: number;
    retryMs?: number;
    watchdogMs?: number;
    discover?: (dir: string) => Promise<object[]>;
    connect?: (options: object) => object;
}): object;
/** How often membership is re-read once everything is connected. */
export const DEFAULT_SLOW_MS: 60000;
/** How often membership is re-read while something is missing. */
export const DEFAULT_FAST_MS: 5000;
/** How long to wait after a link leaves `ready` before re-reading. */
export const DEFAULT_DEBOUNCE_MS: 1000;
