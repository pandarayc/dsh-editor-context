/**
 * @param {string} stateDir - published-state directory.
 * @returns the directory holding endpoint announcements.
 */
export function endpointsDir(stateDir: string): any;
/**
 * Whether a process id is running.
 *
 * `EPERM` counts as alive: it means the process exists under another user, which
 * is not the same as gone.
 * @param {number} pid - process id.
 * @returns whether it is running.
 */
export function processAlive(pid: number): boolean;
/**
 * Parse one announcement, or `undefined` when it is not usable.
 * @param {unknown} raw - parsed JSON.
 * @returns the endpoint, without the fields nobody needs.
 */
export function parseEndpoint(raw: unknown): {
    url: any;
    pid: number;
    port: number;
    appName: any;
    workspaceFolders: any;
    requiresToken: boolean;
    updatedAt: number;
};
/**
 * Read the announcements that are still believable.
 * @param {string} stateDir - published-state directory.
 * @param {object} [options]
 * @param {number} [options.now] - clock, for tests.
 * @param {number} [options.maxAgeMs] - freshness budget.
 * @param {(pid: number) => boolean} [options.isAlive] - liveness probe.
 * @returns {Promise<object[]>} usable endpoints, newest first, one per URL.
 */
export function readEndpoints(stateDir: string, { now, maxAgeMs, isAlive }?: {
    now?: number;
    maxAgeMs?: number;
    isAlive?: (pid: number) => boolean;
}): Promise<object[]>;
/** How long an announcement is trusted without a heartbeat refresh. */
export const DEFAULT_MAX_AGE_MS: number;
