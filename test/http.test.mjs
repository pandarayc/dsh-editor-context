/**
 * Tests for the host-side position route.
 *
 *   node --test test/http.test.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_HTTP_PATH, createPositionRoute, createRequestRoute, deliveryPayload, positionPayload } from '../lib/http.js';

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
    selection: { startLine: 11, endLine: 14, isEmpty: false },
    updatedAt: '2026-10-15T00:00:00.000Z',
  });
  assert.equal('context' in payload, false);
  assert.equal('appName' in payload, false, 'which editor it is open in is not actionable');
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

/** A delivery, as the editor pushes it over the socket. */
function delivery(overrides = {}) {
  return {
    kind: 'editor-context/delivery',
    id: 'id-1',
    reason: 'explicit',
    target: 'dsh',
    activeFile: '/w/src/auth.ts',
    relativePath: 'src/auth.ts',
    selection: { startLine: 11, endLine: 14, startColumn: 1, endColumn: 5, isEmpty: false },
    address: '[编辑器位置] /w/src/auth.ts 第 11-14 行',
    text: 'const a = 1\nconst b = 2\n',
    textTruncated: false,
    updatedAt: '2026-10-17T00:00:00.000Z',
    at: '2026-10-17T00:00:00.000Z',
    ...overrides,
  };
}

/** A queue double that hands out one entry at `seq` and then parks. */
function fakeQueue(entries = []) {
  const asked = [];
  return {
    asked,
    async waitFor(since, { signal, timeoutMs }) {
      asked.push({ since, timeoutMs, signalled: signal !== undefined });
      return entries.find((entry) => entry.seq > since);
    },
  };
}

/** Drive the long-poll route with a request carrying a query string. */
async function callNext(route, url, method = 'GET') {
  const res = fakeRes();
  const req = { method, url, on: () => undefined };
  await route.handler(req, res);
  return res;
}

test('the long poll hands back one sequence-numbered delivery', async () => {
  const queue = fakeQueue([{ seq: 4, at: 0, delivery: delivery() }]);
  const res = await callNext(createRequestRoute({ queue, holdMs: 25_000 }), '/editor-context/next?since=3');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.seq, 4, 'the caller advances its cursor by this number');
  assert.equal(body.absolutePath, '/w/src/auth.ts');
  assert.equal(body.workspacePath, 'src/auth.ts');
  assert.equal(body.address, '[编辑器位置] /w/src/auth.ts 第 11-14 行');
  assert.equal(body.text, 'const a = 1\nconst b = 2\n', 'the snapshot travels with the address');
  assert.deepEqual(body.selection, { startLine: 11, endLine: 14, startColumn: 1, endColumn: 5, isEmpty: false });
  assert.deepEqual(queue.asked, [{ since: 3, timeoutMs: 25_000, signalled: true }]);
});

test('deliveryPayload narrows a delivery without reshaping it', () => {
  const payload = deliveryPayload(delivery());
  assert.deepEqual(payload, {
    absolutePath: '/w/src/auth.ts',
    workspacePath: 'src/auth.ts',
    selection: { startLine: 11, endLine: 14, startColumn: 1, endColumn: 5, isEmpty: false },
    address: '[编辑器位置] /w/src/auth.ts 第 11-14 行',
    text: 'const a = 1\nconst b = 2\n',
    textTruncated: false,
    updatedAt: '2026-10-17T00:00:00.000Z',
  });
  assert.equal('context' in payload, false);
  assert.equal(deliveryPayload(delivery({ activeFile: '', relativePath: 'src/auth.ts' })).absolutePath, 'src/auth.ts');
  assert.equal(deliveryPayload(delivery({ text: undefined })).text, '', 'absent text is empty, not undefined');
  assert.equal(deliveryPayload(delivery({ updatedAt: '' , at: '2026-01-01T00:00:00.000Z' })).updatedAt, '2026-01-01T00:00:00.000Z');
});

test('the long poll answers 204 when nothing arrived before the hold expires', async () => {
  const queue = fakeQueue([{ seq: 4, at: 0, delivery: delivery() }]);
  const res = await callNext(createRequestRoute({ queue, holdMs: 30 }), '/editor-context/next?since=4');
  assert.equal(res.status, 204);
  assert.equal(res.body, undefined, '204 means "ask again", not "here is an empty document"');
  assert.equal(queue.asked[0].timeoutMs, 30);
});

test('a missing or malformed seq starts the caller at the beginning', async () => {
  for (const url of ['/editor-context/next', '/editor-context/next?since=', '/editor-context/next?since=nope', '/editor-context/next?since=-1']) {
    const queue = fakeQueue();
    await callNext(createRequestRoute({ queue, holdMs: 1 }), url);
    assert.equal(queue.asked[0].since, 0, url);
  }
});

test('the long poll refuses anything but GET', async () => {
  const res = await callNext(createRequestRoute({ queue: fakeQueue(), holdMs: 1 }), '/editor-context/next', 'POST');
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, 'GET');
});

test('a reader that aborts is still released', async () => {
  // The route aborts on `req.close`; here the request is already gone, so the
  // signal the route builds must reach the queue in the aborted state.
  const seen = [];
  const queue = {
    async waitFor(_since, { signal }) {
      seen.push(signal.aborted);
      return undefined;
    },
  };
  const res = fakeRes();
  await createRequestRoute({ queue, holdMs: 1 }).handler(
    { method: 'GET', url: '/editor-context/next', on: (event, handler) => { if (event === 'close') handler(); } },
    res,
  );
  assert.deepEqual(seen, [true], 'a closed tab must not leave a parked promise behind');
  assert.equal(res.status, 204);
});

test('a ?pid= asks for one window rather than the newest', async () => {
  const seen = [];
  const route = createPositionRoute({
    readPosition: async (_stateDir, _maxAgeMs, pid) => {
      seen.push(pid);
      return SELECTION;
    },
    stateDir: '/x',
    maxAgeMs: 1,
  });

  const named = fakeRes();
  await route.handler({ method: 'GET', url: '/editor-context/position?pid=4242' }, named);
  assert.equal(named.status, 200);
  assert.deepEqual(seen, [4242]);

  const plain = fakeRes();
  await route.handler({ method: 'GET', url: '/editor-context/position' }, plain);
  assert.deepEqual(seen, [4242, undefined], 'no pid means "the newest", as before');

  const bogus = fakeRes();
  await route.handler({ method: 'GET', url: '/editor-context/position?pid=nope' }, bogus);
  assert.deepEqual(seen, [4242, undefined, undefined], 'a garbage pid must not pick a window by accident');
});
