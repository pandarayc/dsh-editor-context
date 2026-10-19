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
      /**
       * A pre-open failure with no close behind it — what Node's built-in
       * WebSocket actually does when the dial is refused. Modelled separately
       * because the two cases used to be conflated, and the difference is the
       * bug: `fail()` hid it by being kinder than the real socket.
       */
      failSilently() {
        handlers.get('error')?.({});
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

test('a refused dial is retried even though the socket never closes', async () => {
  const { instance, fake, lines } = subscriber({ retryMs: 5 });
  instance.start();
  assert.equal(fake.sockets.length, 1);

  // Exactly what Node 22's WebSocket does on ECONNREFUSED: one error, and then
  // silence. It stays in CONNECTING and never emits close.
  fake.last.failSilently();
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(fake.sockets.length, 2, 'an editor that is simply not open is retried, not given up on');
  assert.equal(fake.sockets[0].closed, true, 'the half-open socket is abandoned rather than leaked');
  assert.match(lines.join('\n'), /retrying in \d+ms/);
  instance.stop();
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

test('the hello is kept: the publisher describes itself before we subscribe', () => {
  const { instance, fake } = subscriber();
  instance.start();
  fake.last.emit('open');
  fake.last.message({
    type: 'hello',
    protocol: 'editor-context/1',
    pid: 99,
    appName: 'Cursor',
    workspaceFolders: ['/w'],
    requiresToken: false,
  });
  assert.deepEqual(instance.peer, { pid: 99, appName: 'Cursor', workspaceFolders: ['/w'], requiresToken: false });
  assert.equal(instance.state, 'connecting');
  instance.stop();
});

test('a refused token stops the retries instead of repeating the question', async () => {
  const { instance, fake, lines } = subscriber({ retryMs: 5 });
  instance.start();
  fake.last.emit('open');
  fake.last.message({ type: 'hello', requiresToken: true });
  fake.last.message({ type: 'error', message: 'bad token' });

  assert.equal(instance.state, 'refused');
  assert.equal(instance.subscribed, false);
  assert.match(lines.join('\n'), /publisher refused: bad token/);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(fake.sockets.length, 1, 'a wrong secret will still be wrong in thirty seconds');
  instance.stop();
});

test('a protocol this client does not speak is refused, not retried', async () => {
  const { instance, fake, lines } = subscriber({ retryMs: 5 });
  instance.start();
  fake.last.emit('open');
  fake.last.message({ type: 'hello', protocol: 'editor-context/2', requiresToken: false });

  assert.equal(instance.state, 'refused');
  assert.match(lines.join('\n'), /speaks editor-context\/2/);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(fake.sockets.length, 1, 'retrying cannot teach either side a new protocol');
  instance.stop();
});

test('a refusal can be lifted once the endpoint is worth another try', async () => {
  const { instance, fake } = subscriber({ retryMs: 5 });
  instance.start();
  fake.last.emit('open');
  fake.last.message({ type: 'hello', protocol: 'editor-context/2', requiresToken: false });
  assert.equal(instance.state, 'refused');

  instance.reset();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fake.sockets.length, 2);
  instance.stop();
});

test('a socket that goes silent after subscribing is reconnected by the watchdog', async () => {
  const { instance, fake, lines } = subscriber({ retryMs: 5, watchdogMs: 20 });
  instance.start();
  fake.last.emit('open');
  fake.last.message({ type: 'hello', protocol: 'editor-context/1', requiresToken: false });
  fake.last.message({ type: 'subscribed', name: 'dsh', includeText: false, autoSelection: false });
  assert.equal(instance.state, 'ready');

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(fake.sockets.length >= 2, 'silence on a subscribed socket is a dead link, not a quiet one');
  assert.match(lines.join('\n'), /no frame for 20ms/);
  instance.stop();
});
