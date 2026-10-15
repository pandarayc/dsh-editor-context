/**
 * Tests for the host-side position route.
 *
 *   node --test test/http.test.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_HTTP_PATH, createPositionRoute, positionPayload } from '../lib/http.js';

const SELECTION = {
  sig: 'a|sel|11-14',
  context: '[编辑器位置] …',
  relativePath: 'src/auth.ts',
  activeFile: '/w/src/auth.ts',
  appName: 'Cursor',
  selection: { startLine: 11, endLine: 14, isEmpty: false },
  updatedAt: '2026-10-15T00:00:00.000Z',
};

/** A minimal node:http response double. */
function fakeRes() {
  return {
    status: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

/** Run one route request. */
async function call(route, method, position) {
  const res = fakeRes();
  await route.handler({ method }, res, position);
  return res;
}

test('positionPayload carries an address, never file contents', () => {
  const payload = positionPayload(SELECTION);
  assert.deepEqual(payload, {
    absolutePath: '/w/src/auth.ts',
    workspacePath: 'src/auth.ts',
    appName: 'Cursor',
    selection: { startLine: 11, endLine: 14, isEmpty: false },
    updatedAt: '2026-10-15T00:00:00.000Z',
  });
  assert.equal('context' in payload, false);
});

test('positionPayload tolerates a missing selection and a missing active file', () => {
  assert.equal(positionPayload({ ...SELECTION, selection: null }).selection, null);
  const noAbsolute = positionPayload({ ...SELECTION, activeFile: '' });
  assert.equal(noAbsolute.absolutePath, 'src/auth.ts', 'falls back to the relative path');
});

test('the route is an exact GET path', () => {
  const route = createPositionRoute({ readPosition: async () => SELECTION, stateDir: '/x', maxAgeMs: 1 });
  assert.equal(route.kind, 'exact');
  assert.equal(route.path, DEFAULT_HTTP_PATH);
  const custom = createPositionRoute({
    readPosition: async () => SELECTION,
    stateDir: '/x',
    maxAgeMs: 1,
    path: '/whatever',
  });
  assert.equal(custom.path, '/whatever');
});

test('a current position answers 200 with no-store', async () => {
  const route = createPositionRoute({ readPosition: async () => SELECTION, stateDir: '/x', maxAgeMs: 1 });
  const res = await call(route, 'GET');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['content-length'], Buffer.byteLength(res.body));
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.absolutePath, '/w/src/auth.ts');
});

test('a missing, stale or excluded position is a bare 404', async () => {
  for (const reading of [undefined, { ...SELECTION, context: '' }]) {
    const route = createPositionRoute({ readPosition: async () => reading, stateDir: '/x', maxAgeMs: 1 });
    const res = await call(route, 'GET');
    assert.equal(res.status, 404);
    assert.deepEqual(JSON.parse(res.body), { ok: false });
    assert.equal(
      res.body.includes('auth.ts'),
      false,
      'an exclusion must not leak the path it is hiding',
    );
  }
});

test('HEAD answers the same headers with no body', async () => {
  const route = createPositionRoute({ readPosition: async () => SELECTION, stateDir: '/x', maxAgeMs: 1 });
  const res = await call(route, 'HEAD');
  assert.equal(res.status, 200);
  assert.equal(res.body, undefined);
});

test('anything but GET and HEAD is 405', async () => {
  const route = createPositionRoute({ readPosition: async () => SELECTION, stateDir: '/x', maxAgeMs: 1 });
  const res = await call(route, 'POST');
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, 'GET, HEAD');
});
