/**
 * Tests for the delivery queue: the parking place between the editor's socket
 * and the browser's long poll.
 *
 *   node --test test/deliveries.test.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDeliveryQueue } from '../lib/deliveries.js';

/** A delivery, as the editor sends it. */
function delivery(overrides = {}) {
  return {
    kind: 'editor-context/delivery',
    id: 'id-1',
    at: '2026-10-17T00:00:00.000Z',
    reason: 'explicit',
    target: 'dsh',
    activeFile: '/w/src/auth.ts',
    relativePath: 'src/auth.ts',
    selection: { startLine: 11, endLine: 14, startColumn: 1, endColumn: 5, isEmpty: false },
    address: '[编辑器位置] /w/src/auth.ts 第 11-14 行',
    text: 'const a = 1\n',
    textTruncated: false,
    updatedAt: '2026-10-17T00:00:00.000Z',
    ...overrides,
  };
}

test('a pushed delivery is numbered and handed to the next reader', async () => {
  const queue = createDeliveryQueue();
  const seq = queue.push(delivery());
  assert.equal(seq, 1);
  assert.equal(queue.latest, 1);
  assert.equal(queue.size, 1);

  const entry = await queue.waitFor(0, { timeoutMs: 50 });
  assert.equal(entry.seq, 1);
  assert.equal(entry.delivery.activeFile, '/w/src/auth.ts');
  assert.equal(entry.delivery.text, 'const a = 1\n');
});

test('a delivery that arrives while a reader is parked wakes it', async () => {
  const queue = createDeliveryQueue();
  const parked = queue.waitFor(0, { timeoutMs: 5_000 });
  queue.push(delivery({ activeFile: '/w/src/other.ts' }));

  const entry = await parked;
  assert.equal(entry.seq, 1, 'no polling: the promise settles because something was pushed');
  assert.equal(entry.delivery.activeFile, '/w/src/other.ts');
});

test('a reader is only given what comes after the seq it already has', async () => {
  const queue = createDeliveryQueue();
  queue.push(delivery());
  queue.push(delivery());

  const first = await queue.waitFor(0, { timeoutMs: 50 });
  assert.equal(first.seq, 1);
  const second = await queue.waitFor(first.seq, { timeoutMs: 50 });
  assert.equal(second.seq, 2);
  assert.equal(await queue.waitFor(second.seq, { timeoutMs: 30 }), undefined, 'exhausted readers park');
});

test('the queue is bounded, and oldest-first', async () => {
  const queue = createDeliveryQueue({ now: () => 0 });
  for (let i = 0; i < 100; i += 1) queue.push(delivery({ id: `id-${String(i)}` }));
  assert.equal(queue.size, 64, 'a browser that never asks cannot grow this without limit');
  const oldest = await queue.waitFor(0, { timeoutMs: 50 });
  assert.equal(oldest.seq, 37, 'the oldest surviving entry, not the first ever pushed');
});

test('an entry older than the budget is not delivered', async () => {
  let now = 1_000_000;
  const queue = createDeliveryQueue({ maxAgeMs: 5_000, now: () => now });
  queue.push(delivery());
  now += 10_000;
  assert.equal(await queue.waitFor(0, { timeoutMs: 30 }), undefined, 'a stale delivery is worse than none');
  assert.equal(queue.size, 0);
});

test('a negative budget disables the age check', async () => {
  let now = 1_000_000;
  const queue = createDeliveryQueue({ maxAgeMs: -1, now: () => now });
  queue.push(delivery());
  now += 86_400_000;
  assert.equal((await queue.waitFor(0, { timeoutMs: 30 })).seq, 1);
});

test('aborting and stopping both release a parked reader', async () => {
  const aborted = createDeliveryQueue();
  const gone = new AbortController();
  const parked = aborted.waitFor(0, { signal: gone.signal, timeoutMs: 30_000 });
  gone.abort();
  assert.equal(await parked, undefined);

  const stopped = createDeliveryQueue();
  const waiting = stopped.waitFor(0, { timeoutMs: 30_000 });
  stopped.stop();
  assert.equal(await waiting, undefined);
});

test('an already-aborted signal never parks', async () => {
  const queue = createDeliveryQueue();
  const gone = new AbortController();
  gone.abort();
  assert.equal(await queue.waitFor(0, { signal: gone.signal, timeoutMs: 30_000 }), undefined);
});
