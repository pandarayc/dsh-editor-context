/**
 * Tests for the endpoint registry.
 *
 * The registry is a directory of small JSON files written by another process, so
 * everything worth testing is about *rejection*: a file that is stale, a pid that
 * is gone, a URL this plugin has no business dialling. The happy path is one
 * assertion; the rest is the filter.
 *
 *   node --test test/registry.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { endpointsDir, parseEndpoint, processAlive, readEndpoints } from '../lib/registry.js';

const roots = [];

async function freshDir() {
  const dir = await mkdtemp(join(tmpdir(), 'editor-context-registry-'));
  roots.push(dir);
  return dir;
}

/** A believable announcement. */
function announcement(overrides = {}) {
  return {
    version: 1,
    pid: 4242,
    port: 51234,
    url: 'ws://127.0.0.1:51234/editor-context',
    protocol: 'editor-context/1',
    appName: 'Cursor',
    extensionVersion: '0.5.0',
    workspaceFolders: ['/w'],
    requiresToken: false,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Write one announcement under `<dir>/endpoints/<name>`. */
async function announce(dir, name, payload) {
  await mkdir(endpointsDir(dir), { recursive: true });
  await writeFile(join(endpointsDir(dir), name), typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
}

test('a fresh, live announcement is returned', async () => {
  const dir = await freshDir();
  await announce(dir, '4242.json', announcement());
  const found = await readEndpoints(dir, { isAlive: () => true });
  assert.equal(found.length, 1);
  assert.equal(found[0].url, 'ws://127.0.0.1:51234/editor-context');
  assert.equal(found[0].appName, 'Cursor');
  assert.equal(found[0].pid, 4242);
});

test('a missing directory is an empty registry, not an error', async () => {
  const dir = await freshDir();
  assert.deepEqual(await readEndpoints(dir), []);
});

test('a dead pid, a stale heartbeat and a malformed file are all skipped', async () => {
  const dir = await freshDir();
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  await announce(dir, '1.json', announcement({ pid: 1, url: 'ws://127.0.0.1:5001/editor-context' }));
  await announce(dir, '2.json', announcement({ pid: 2, url: 'ws://127.0.0.1:5002/editor-context', updatedAt: hourAgo }));
  await announce(dir, '3.json', '{ not json');
  await announce(dir, '4.json', announcement({ pid: 4, url: 'ws://127.0.0.1:5004/editor-context' }));

  const found = await readEndpoints(dir, { isAlive: (pid) => pid === 1 || pid === 4 });
  assert.deepEqual(
    found.map((endpoint) => endpoint.pid),
    [1, 4],
    'liveness and freshness are both required; broken files are not worth reporting',
  );
});

test('a non-loopback or non-WebSocket URL is refused', async () => {
  const dir = await freshDir();
  await announce(dir, '1.json', announcement({ pid: 1, url: 'ws://example.com:5001/editor-context' }));
  await announce(dir, '2.json', announcement({ pid: 2, url: 'http://127.0.0.1:5002/editor-context' }));
  await announce(dir, '3.json', announcement({ pid: 3, url: 'ws://127.0.0.1:5003/editor-context' }));
  const found = await readEndpoints(dir, { isAlive: () => true });
  assert.deepEqual(found.map((endpoint) => endpoint.pid), [3], 'a writable file must not be able to redirect a socket');
});

test('two files naming one URL collapse to the newest', async () => {
  const dir = await freshDir();
  const older = new Date(Date.now() - 60_000).toISOString();
  await announce(dir, '1.json', announcement({ pid: 1, updatedAt: older }));
  await announce(dir, '2.json', announcement({ pid: 2 }));
  const found = await readEndpoints(dir, { isAlive: () => true });
  assert.equal(found.length, 1);
  assert.equal(found[0].pid, 2);
});

test('parseEndpoint keeps the port even when the URL omits it', () => {
  const parsed = parseEndpoint(announcement({ url: 'ws://127.0.0.1/editor-context', port: 7788 }));
  assert.equal(parsed.port, 7788);
  assert.equal(parseEndpoint({ pid: 1 }), undefined, 'a URL is not optional');
  assert.equal(parseEndpoint(null), undefined);
});

test('processAlive is true for this process and false for one that is not running', () => {
  assert.equal(processAlive(process.pid), true);
  // pid 0 and a very large pid are both invalid; kill() must not throw out.
  assert.equal(processAlive(2 ** 22 + 7), false);
});

after(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});
