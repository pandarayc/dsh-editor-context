/**
 * Tests for the socket subscriber.
 *
 * The socket is a double rather than a real connection, because what is worth
 * asserting here is the *conversation* — when the subscribe frame goes out, what
 * it carries, when a retry is scheduled — and a fake makes those deterministic.
 * The real protocol is exercised across both packages by the extension's
 * `test/server.test.mjs`, which runs Node's own WebSocket client against Node's
 * own... publisher.
 *
 *   node --test test/subscribe.test.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSubscriber } from '../lib/subscribe.js';

/** A WebSocket double: records frames, and lets a test drive the events. */
function fakeSocket() {
  const sockets = [];
  const factory = (url) => {
    const handlers = new Map();
    const socket = {
      url,
      sent: [],
      closed: false,
      send(value) {
        this.sent.push(JSON.parse(value));
      },
      close() {
        this.closed = true;
        handlers.get('close')?.({});
      },
      addEventListener(type, handler) {
        handlers.set(type, handler);
      },
      emit(type, event = {}) {
        handlers.get(type)?.(event);
      },
      message(value) {
        handlers.get('message')?.({ data: JSON.stringify(value) });
      },
      fail() {
        handlers.get('error')?.({});
        handlers.get('close')?.({});
      },
    };
    sockets.push(socket);
    return socket;
  };
  return { sockets, factory, get last() { return sockets[sockets.length - 1]; } };
}

/** A subscriber with a socket double, plus the log lines it produced. */
function subscriber(overrides = {}) {
  const fake = fakeSocket();
  const lines = [];
  const deliveries = [];
  const instance = createSubscriber({
    url: 'ws://127.0.0.1:7788/editor-context',
    onDelivery: (delivery) => deliveries.push(delivery),
    log: (message) => lines.push(message),
    createSocket: fake.factory,
    retryMs: 10,
    ...overrides,
  });
  return { instance, fake, lines, deliveries };
}

test('nothing is dialled until start', () => {
  const { instance, fake } = subscriber();
  assert.equal(fake.sockets.length, 0);
  instance.start();
  assert.equal(fake.sockets.length, 1);
  assert.equal(fake.last.url, 'ws://127.0.0.1:7788/editor-context');
  instance.stop();
});

test('the subscribe frame is only sent after the hello, and carries the policy', () => {
  const { instance, fake } = subscriber({ name: 'dsh', label: 'DSH', includeText: false, autoSelection: true });
  instance.start();
  const socket = fake.last;
  socket.emit('open');
  assert.deepEqual(socket.sent, [], 'a publisher that has not introduced itself gets nothing');

  socket.message({ type: 'hello', protocol: 'editor-context/1', requiresToken: false });
  assert.deepEqual(socket.sent, [
    { type: 'subscribe', name: 'dsh', label: 'DSH', includeText: false, autoSelection: true },
  ]);
  instance.stop();
});

test('a token is presented when the publisher asks for one, or when we have one', () => {
  const asked = subscriber({ token: 'sekrit' });
  asked.instance.start();
  asked.fake.last.emit('open');
  asked.fake.last.message({ type: 'hello', requiresToken: true });
  assert.equal(asked.fake.last.sent[0].token, 'sekrit');
  asked.instance.stop();

  const offered = subscriber({ token: 'sekrit' });
  offered.instance.start();
  offered.fake.last.emit('open');
  offered.fake.last.message({ type: 'hello', requiresToken: false });
  assert.equal(offered.fake.last.sent[0].token, 'sekrit', 'a publisher with no token ignores the field');
  offered.instance.stop();

  const none = subscriber();
  none.instance.start();
  none.fake.last.emit('open');
  none.fake.last.message({ type: 'hello', requiresToken: false });
  assert.equal('token' in none.fake.last.sent[0], false);
  none.instance.stop();
});

test('a delivery is handed on; a refusal is logged and not dressed up as a link', () => {
  const { instance, fake, deliveries, lines } = subscriber();
  instance.start();
  fake.last.emit('open');
  fake.last.message({ type: 'hello', requiresToken: false });

  fake.last.message({ type: 'error', message: 'bad token' });
  assert.equal(instance.subscribed, false, 'a refused subscriber is not a subscriber');
  assert.match(lines.join('\n'), /publisher refused: bad token/);

  fake.last.message({ type: 'subscribed', name: 'dsh', includeText: true, autoSelection: false });
  assert.equal(instance.subscribed, true);

  const payload = { kind: 'editor-context/delivery', id: 'a', text: 'const a = 1\n' };
  fake.last.message({ type: 'delivery', delivery: payload });
  assert.deepEqual(deliveries, [payload]);
  instance.stop();
});

test('a frame that is not JSON is ignored rather than fatal', () => {
  const { instance, fake, lines, deliveries } = subscriber();
  instance.start();
  fake.last.emit('open');
  fake.last.addEventListener;
  fake.last.emit('message', { data: '{ not json' });
  assert.match(lines.join('\n'), /not JSON/);
  assert.deepEqual(deliveries, []);
  instance.stop();
});

test('a dropped connection is retried with backoff, and start-stop is idempotent', async () => {
  const { instance, fake, lines } = subscriber({ retryMs: 5 });
  instance.start();
  fake.last.emit('open');
  fake.last.message({ type: 'hello', requiresToken: false });
  fake.last.message({ type: 'subscribed', name: 'dsh' });
  assert.equal(instance.attempts, 1);

  fake.last.emit('close');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fake.sockets.length, 2, 'a closed editor is a temporary state, not a fatal one');
  assert.ok(instance.attempts >= 2);

  instance.stop();
  const after = fake.sockets.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(fake.sockets.length, after, 'stop() stops dialling');
  assert.equal(fake.last.closed, true);
  assert.ok(lines.length > 0);
});

test('a socket that cannot even be constructed schedules a retry', async () => {
  const lines = [];
  const instance = createSubscriber({
    url: 'ws://127.0.0.1:1/x',
    log: (message) => lines.push(message),
    retryMs: 5,
    createSocket: () => {
      throw new Error('no route to host');
    },
  });
  instance.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(lines.join('\n'), /could not dial .*no route to host/);
  assert.ok(instance.attempts >= 2, 'and it keeps trying');
  instance.stop();
});
