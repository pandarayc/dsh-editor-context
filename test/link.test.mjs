/**
 * Tests for the link manager: membership, not the wire.
 *
 * The subscriber is replaced by a double on purpose — what is worth asserting
 * here is *which* subscribers exist after the registry changes, which is the
 * part that used to be hard-coded to a single URL.
 *
 *   node --test test/link.test.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLink } from '../lib/link.js';

/** A subscriber double that records the lifecycle and can be made to look ready. */
function harness() {
  const made = [];
  const connect = (options) => {
    const subscriber = {
      url: options.url,
      started: false,
      stopped: false,
      state: 'absent',
      subscribed: false,
      attempts: 1,
      peer: undefined,
      start() {
        this.started = true;
      },
      stop() {
        this.stopped = true;
      },
    };
    made.push(subscriber);
    return subscriber;
  };
  return { made, connect };
}

function endpoint(url, pid = 1, appName = 'Cursor') {
  return { url, pid, appName, workspaceFolders: [], port: 0 };
}

function linkWith({ made, connect }, discover, overrides = {}) {
  return createLink({
    stateDir: '/state',
    fallbackUrl: '',
    discover,
    connect,
    log: () => undefined,
    ...overrides,
  });
}

test('every announced endpoint gets a subscriber, and start is idempotent', async () => {
  const h = harness();
  const link = linkWith(h, async () => [
    endpoint('ws://127.0.0.1:5001/editor-context', 1, 'Cursor'),
    endpoint('ws://127.0.0.1:5002/editor-context', 2, 'Code'),
  ]);
  link.start();
  link.start();
  const found = await link.refresh();
  assert.deepEqual(found.map((item) => item.url).sort(), [
    'ws://127.0.0.1:5001/editor-context',
    'ws://127.0.0.1:5002/editor-context',
  ]);
  assert.equal(h.made.length, 2, 'a second scan must not duplicate a link');
  assert.ok(h.made.every((subscriber) => subscriber.started));
  link.stop();
});

test('a window that leaves the registry is stopped; the others are untouched', async () => {
  const h = harness();
  let endpoints = [
    endpoint('ws://127.0.0.1:5001/editor-context', 1),
    endpoint('ws://127.0.0.1:5002/editor-context', 2),
  ];
  const link = linkWith(h, async () => endpoints);
  link.start();
  await link.refresh();
  const [first, second] = h.made;

  endpoints = [endpoints[1]];
  await link.refresh();
  assert.equal(first.stopped, true, 'a closed window must not leave a dialling loop behind');
  assert.equal(second.stopped, false);
  assert.equal(h.made.length, 2, 'no re-dial for the window that is still there');
  link.stop();
});

test('a window that comes back on a new port is a new link, and the old one goes', async () => {
  const h = harness();
  let endpoints = [endpoint('ws://127.0.0.1:5001/editor-context', 1)];
  const link = linkWith(h, async () => endpoints);
  link.start();
  await link.refresh();

  endpoints = [endpoint('ws://127.0.0.1:6001/editor-context', 1)];
  await link.refresh();
  assert.equal(h.made.length, 2, 'a port change is a new endpoint, not a mutated one');
  assert.equal(h.made[0].stopped, true);
  assert.equal(h.made[1].started, true);
  link.stop();
});

test('with an empty registry the configured fallback is dialled, once', async () => {
  const h = harness();
  const link = linkWith(h, async () => [], { fallbackUrl: 'ws://127.0.0.1:7788/editor-context' });
  link.start();
  await link.refresh();
  await link.refresh();
  assert.equal(h.made.length, 1);
  assert.equal(h.made[0].url, 'ws://127.0.0.1:7788/editor-context', 'a pre-registry extension still works');
  link.stop();
});

test('with no registry and no fallback, nothing is dialled', async () => {
  const h = harness();
  const link = linkWith(h, async () => []);
  link.start();
  await link.refresh();
  assert.deepEqual(h.made, []);
  link.stop();
});

test('a registry read that fails does not take the plugin down', async () => {
  const h = harness();
  const link = linkWith(h, async () => {
    throw new Error('permission denied');
  });
  link.start();
  await assert.doesNotReject(link.refresh());
  assert.deepEqual(h.made, []);
  link.stop();
});

test('status reports one entry per link, with what the publisher said about itself', async () => {
  const h = harness();
  const link = linkWith(h, async () => [endpoint('ws://127.0.0.1:5001/editor-context', 7, 'Cursor')]);
  link.start();
  await link.refresh();
  const [subscriber] = h.made;
  subscriber.subscribed = true;
  subscriber.state = 'ready';
  subscriber.peer = { pid: 7, appName: 'Cursor', workspaceFolders: ['/w'], requiresToken: false };

  const status = link.status();
  assert.equal(status.subscribed, true);
  assert.deepEqual(status.connections, [
    {
      url: 'ws://127.0.0.1:5001/editor-context',
      state: 'ready',
      subscribed: true,
      attempts: 1,
      peer: { pid: 7, appName: 'Cursor', workspaceFolders: ['/w'], requiresToken: false },
    },
  ]);
  link.stop();
  assert.deepEqual(link.status(), { subscribed: false, connections: [] });
});
