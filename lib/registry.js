/**
 * The editor endpoint registry: which windows are publishing, and where.
 *
 * The extension used to serve a single fixed port, which meant the second window
 * of a project had no socket at all and nothing said so. Since 0.5.0 each window
 * binds its preferred port or an ephemeral one, then announces the result in
 * `<stateDir>/endpoints/<pid>.json`. This module turns that directory into a
 * list of things worth dialling.
 *
 * The filter is deliberately conservative — both halves are needed:
 *
 *   - the pid must be alive, because a crashed window cannot withdraw its file;
 *   - the announcement must be recent, because pids are reused and liveness
 *     alone can point at an unrelated process.
 *
 * A file that cannot be parsed, or that names a URL this plugin has no business
 * dialling, is skipped. One broken announcement must not cost us the others.
 *
 * @module dsh-editor-context/registry
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** How long an announcement is trusted without a heartbeat refresh. */
export const DEFAULT_MAX_AGE_MS = 10 * 60_000;

/**
 * Hosts an announcement may name.
 *
 * The extension only ever binds loopback. Accepting anything else here would turn
 * a writable file in `$HOME` into a request to send selections to a remote
 * endpoint, which is not a trade worth making for a convenience nobody asked for.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * @param {string} stateDir - published-state directory.
 * @returns the directory holding endpoint announcements.
 */
export function endpointsDir(stateDir) {
  return join(stateDir, 'endpoints');
}

/**
 * Whether a process id is running.
 *
 * `EPERM` counts as alive: it means the process exists under another user, which
 * is not the same as gone.
 * @param {number} pid - process id.
 * @returns whether it is running.
 */
export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Parse one announcement, or `undefined` when it is not usable.
 * @param {unknown} raw - parsed JSON.
 * @returns the endpoint, without the fields nobody needs.
 */
export function parseEndpoint(raw) {
  if (raw === null || typeof raw !== 'object') return undefined;
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  const pid = Number(raw.pid);
  const updatedAt = Date.parse(typeof raw.updatedAt === 'string' ? raw.updatedAt : '');
  if (url === '' || !Number.isInteger(pid) || pid <= 0 || !Number.isFinite(updatedAt)) return undefined;
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return undefined;
  }
  if (parsedUrl.protocol !== 'ws:') return undefined;
  if (!LOOPBACK.has(parsedUrl.hostname)) return undefined;
  return {
    url,
    pid,
    port: Number(raw.port) || Number(parsedUrl.port) || 0,
    appName: typeof raw.appName === 'string' ? raw.appName : '',
    workspaceFolders: Array.isArray(raw.workspaceFolders)
      ? raw.workspaceFolders.filter((folder) => typeof folder === 'string')
      : [],
    requiresToken: raw.requiresToken === true,
    updatedAt,
  };
}

/**
 * Read the announcements that are still believable.
 * @param {string} stateDir - published-state directory.
 * @param {object} [options]
 * @param {number} [options.now] - clock, for tests.
 * @param {number} [options.maxAgeMs] - freshness budget.
 * @param {(pid: number) => boolean} [options.isAlive] - liveness probe.
 * @returns {Promise<object[]>} usable endpoints, newest first, one per URL.
 */
export async function readEndpoints(stateDir, { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS, isAlive = processAlive } = {}) {
  let names;
  try {
    names = await readdir(endpointsDir(stateDir));
  } catch {
    return [];
  }
  const found = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    let raw;
    try {
      raw = JSON.parse(await readFile(join(endpointsDir(stateDir), name), 'utf8'));
    } catch {
      continue;
    }
    const endpoint = parseEndpoint(raw);
    if (endpoint === undefined) continue;
    if (now - endpoint.updatedAt > maxAgeMs) continue;
    if (!isAlive(endpoint.pid)) continue;
    found.push(endpoint);
  }
  // Two files can name the same URL (a window that restarted on the same pid);
  // the newest wins, and the order is stable so a log line does not reshuffle.
  const byUrl = new Map();
  for (const endpoint of found) {
    const seen = byUrl.get(endpoint.url);
    if (seen === undefined || seen.updatedAt < endpoint.updatedAt) byUrl.set(endpoint.url, endpoint);
  }
  return [...byUrl.values()].sort((a, b) => a.url.localeCompare(b.url));
}
