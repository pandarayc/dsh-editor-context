/**
 * Tests for dsh-editor-context: the reader, the config, and what `apply`
 * registers — driven by a fake cordis context. No DSH host required.
 *
 *   node --test test/editor-context.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { apply, readPosition, resolveStateDir } from '../lib/index.js';

/**
 * `apply` dials the editor's socket, which no unit test should actually do: the
 * address would be whatever happens to be on 127.0.0.1:7788. The double keeps the
 * test about what `apply` registers rather than about the network.
 */
class SilentSocket {
  addEventListener() {}
  send() {}
  close() {}
}
const realWebSocket = globalThis.WebSocket;
globalThis.WebSocket = SilentSocket;

/**
 * A cordis context that records registrations.
 *
 * The listeners, projections and commands it collects are never expected to fill
 * up: this plugin has no way to put anything into a conversation. They are
 * recorded so that stays a tested fact rather than a convention.
 */
function fakeCtx() {
  const listeners = new Map();
  const projections = [];
  const routes = [];
  const sections = [];
  const registeredCommands = [];
  const injected = [];
  return {
    listeners,
    projections,
    routes,
    sections,
    registeredCommands,
    injected,
    webServer: {
      register(route) {
        routes.push(route);
        return () => {
          const at = routes.indexOf(route);
          if (at >= 0) routes.splice(at, 1);
        };
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section);
        return () => {
          const at = sections.indexOf(section);
          if (at >= 0) sections.splice(at, 1);
        };
      },
    },
    sessionProjections: {
      register(definition) {
        projections.push(definition);
      },
      stateOf: () => undefined,
    },
    commands: {
      register(definition) {
        registeredCommands.push(definition);
        return () => {};
      },
    },
    get: () => undefined,
    inject(deps, callback) {
      injected.push(deps);
      callback(this);
    },
    on(event, handler) {
      listeners.set(event, handler);
    },
    effect(fn) {
      fn();
    },
  };
}

/** Publish one window state under a fresh state directory. */
async function publish(state, { pid = 1, name = 'windows' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'editor-context-plugin-'));
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, `${pid}.json`), JSON.stringify(state), 'utf8');
  return dir;
}

const SELECTION = {
  version: 1,
  sig: 'src/auth.ts|sel|11-14',
  context: '[编辑器位置] Cursor /w/src/auth.ts 第 11-14 行',
  relativePath: 'src/auth.ts',
  activeFile: '/w/src/auth.ts',
  appName: 'Cursor',
  selection: { startLine: 11, endLine: 14, startColumn: 1, endColumn: 5, isEmpty: false },
  updatedAt: '2026-10-15T00:00:00.000Z',
};

const CURSOR = {
  ...SELECTION,
  sig: 'src/auth.ts|cursor|42-42',
  context: '[编辑器位置] Cursor /w/src/auth.ts 第 42 行',
  selection: { startLine: 42, endLine: 42, startColumn: 7, endColumn: 7, isEmpty: true },
};

test('resolveStateDir expands ~ and defaults to the published directory', () => {
  assert.equal(resolveStateDir(undefined), join(homedir(), '.editor-context'));
  assert.equal(resolveStateDir('  '), join(homedir(), '.editor-context'));
  assert.equal(resolveStateDir('~'), homedir());
  assert.equal(resolveStateDir('~/sub'), join(homedir(), 'sub'));
  assert.equal(resolveStateDir('/tmp/x'), '/tmp/x');
});

test('readPosition picks the newest window and honours the age limit', async () => {
  const dir = await publish(SELECTION, { pid: 1 });
  const first = join(dir, 'windows', '1.json');
  const second = join(dir, 'windows', '2.json');
  await writeFile(second, JSON.stringify(CURSOR), 'utf8');
  // `readPosition` orders by mtime, and two writes inside one millisecond share
  // it; age the older window so the assertion tests ordering, not the
  // filesystem's timestamp resolution.
  const earlier = new Date(Date.now() - 60_000);
  await utimes(first, earlier, earlier);

  const newest = await readPosition(dir, 60_000);
  assert.equal(newest.sig, CURSOR.sig, 'the last-written window wins');
  const unbounded = await readPosition(dir, -1);
  assert.equal(unbounded.sig, CURSOR.sig, 'a negative budget disables the age check');

  const stale = await publish(CURSOR);
  const old = new Date(Date.now() - 60_000);
  await utimes(join(stale, 'windows', '1.json'), old, old);
  assert.equal(await readPosition(stale, 5_000), undefined, 'a budget past the age expires the reading');
});

test('readPosition is undefined for a missing, empty or malformed state dir', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'editor-context-none-'));
  assert.equal(await readPosition(empty, 60_000), undefined);

  const broken = await publish(SELECTION);
  await writeFile(join(broken, 'windows', '1.json'), '{ not json', 'utf8');
  assert.equal(await readPosition(broken, 60_000), undefined);
});

test('readPosition keeps an empty context, which is how "publish nothing" travels', async () => {
  const excluded = await publish({ ...SELECTION, sig: '', context: '', relativePath: 'deep/.env' });
  const position = await readPosition(excluded, 60_000);
  assert.equal(position.context, '');
  assert.equal(position.relativePath, 'deep/.env');

  const nothingOpen = await publish({ ...SELECTION, sig: '', context: '', activeFile: '', relativePath: '' });
  const silent = await readPosition(nothingOpen, 60_000);
  assert.equal(silent.context, '', 'no file open is silent, not narrated');
});

test('apply registers the three read-only routes and the token-grammar section, and nothing else', () => {
  const ctx = fakeCtx();
  apply(ctx, { stateDir: '/x' });

  assert.deepEqual(
    ctx.routes.map((route) => `${route.kind} ${route.path}`),
    ['exact /editor-context/position', 'exact /editor-context/next', 'exact /editor-context/status'],
    'the browser half reads the current position here, parks its long poll there, and can ask which editor is connected',
  );
  assert.deepEqual(
    ctx.sections.map((section) => [section.name, section.order]),
    [['editor-context', 910]],
    'order 910 sits immediately after FILE_REFERENCE at 900',
  );

  // The invariant the whole design rests on.
  assert.deepEqual(ctx.registeredCommands, [], 'no slash command');
  assert.equal(ctx.listeners.size, 0, 'no per-turn listener');
  assert.deepEqual(ctx.projections, [], 'no durable counter, because nothing needs numbering');
});

test('the grammar section stops the model reading #L as part of the path', () => {
  const ctx = fakeCtx();
  apply(ctx, {});
  const [section] = ctx.sections;
  assert.match(section.text, /#L12-L34/);
  assert.match(section.text, /path is everything before/);
  assert.match(section.text, /never the whole token/);
});

test('http: false leaves the plugin with only the grammar section', () => {
  const ctx = fakeCtx();
  apply(ctx, { http: false });
  assert.deepEqual(ctx.routes, [], 'no endpoints for the browser to read');
  assert.equal(ctx.sections.length, 1, 'the model still needs the token grammar');
});

test('a custom httpPath moves the current-position route only', () => {
  const moved = fakeCtx();
  apply(moved, { httpPath: '/custom/where' });
  assert.deepEqual(moved.routes.map((route) => route.path), ['/custom/where', '/editor-context/next', '/editor-context/status']);

  const bogus = fakeCtx();
  apply(bogus, { httpPath: 'custom/where' });
  assert.equal(bogus.routes[0].path, '/editor-context/position', 'a non-absolute path falls back to the default');
});

test('the route apply mounts is wired to the configured directory and budget', async () => {
  // The route's own behaviour is http.test.mjs's job; what is only testable here
  // is that `apply` hands it the config rather than something else.
  const dir = await publish(CURSOR);
  const ctx = fakeCtx();
  apply(ctx, { stateDir: dir, maxAgeSeconds: 60 });

  const fresh = await callRoute(ctx.routes[0], 'GET');
  assert.equal(fresh.status, 200);
  assert.equal(JSON.parse(fresh.body).absolutePath, '/w/src/auth.ts');

  const old = new Date(Date.now() - 120_000);
  await utimes(join(dir, 'windows', '1.json'), old, old);
  const expired = await callRoute(ctx.routes[0], 'GET');
  assert.equal(expired.status, 404, 'maxAgeSeconds reaches the reader too');
});

/** Drive a route handler with the smallest request/response pair that works. */
async function callRoute(route, method) {
  const answer = { status: 0, headers: {}, body: undefined };
  const res = {
    writeHead(status, headers = {}) {
      answer.status = status;
      Object.assign(answer.headers, headers);
      return this;
    },
    end(body) {
      if (body !== undefined) answer.body = body.toString();
    },
  };
  await route.handler({ method }, res);
  return answer;
}

after(async () => {
  await rm(join(tmpdir(), 'editor-context-plugin-'), { recursive: true, force: true });
});

test.after(() => {
  if (realWebSocket === undefined) delete globalThis.WebSocket;
  else globalThis.WebSocket = realWebSocket;
});
