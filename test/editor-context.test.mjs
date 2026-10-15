/**
 * Tests for dsh-editor-context: the pure readers plus the two behavioural
 * modes, driven by a fake cordis context. No DSH host required.
 *
 *   node --test test/editor-context.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  COUNTER_KEY,
  SOURCE_KIND,
  apply,
  buildMessages,
  contextMessage,
  describePosition,
  readPosition,
  renderMarker,
  resolveStateDir,
} from '../lib/index.js';

/**
 * A cordis context that records registrations and listeners.
 * @param options.sessionProjections - value `ctx.get('sessionProjections')` returns.
 */
function fakeCtx({ sessionProjections } = {}) {
  const registered = [];
  const listeners = new Map();
  const projections = [];
  const routes = [];
  const sections = [];
  const injected = [];
  const service =
    sessionProjections !== undefined
      ? sessionProjections
      : {
          register(definition) {
            projections.push(definition);
          },
          stateOf: () => undefined,
        };
  return {
    registered,
    listeners,
    projections,
    routes,
    sections,
    injected,
    sessionProjections: service,
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
    commands: {
      register(definition) {
        registered.push(definition);
        return () => {
          const at = registered.indexOf(definition);
          if (at >= 0) registered.splice(at, 1);
        };
      },
    },
    get(serviceName) {
      return serviceName === 'sessionProjections' ? service : undefined;
    },
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

/** An agent stub whose inbox records what a plugin prepends. */
function fakeAgent() {
  return {
    session: { id: 's' },
    inbox: { prepended: [], prepend(target, message) { this.prepended.push({ target, message }); } },
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
  context: '[编辑器位置] 用户选中了 src/auth.ts 第 11-14 行。',
  relativePath: 'src/auth.ts',
  activeFile: '/w/src/auth.ts',
  appName: 'Cursor',
  selection: { startLine: 11, endLine: 14, startColumn: 1, endColumn: 5, isEmpty: false },
  updatedAt: '2026-10-15T00:00:00.000Z',
};

const CURSOR = {
  ...SELECTION,
  sig: 'src/auth.ts|cursor|42-42',
  context: '[编辑器位置] 用户光标停在 src/auth.ts 第 42 行。',
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

test('readPosition keeps an empty context so the command can report an exclusion', async () => {
  const dir = await publish({ ...SELECTION, sig: '', context: '', relativePath: 'deep/.env' });
  const position = await readPosition(dir, 60_000);
  assert.equal(position.context, '');
  assert.equal(position.relativePath, 'deep/.env');
});

test('describePosition distinguishes nothing, a cursor and a selection', () => {
  assert.equal(describePosition(SELECTION), 'src/auth.ts 第 11-14 行（共 4 行）');
  assert.equal(describePosition(CURSOR), 'src/auth.ts 第 42 行');
  assert.equal(describePosition({ ...SELECTION, selection: null }), 'src/auth.ts');
});

test('renderMarker is an address with an ordinal, never a narration', () => {
  const selection = renderMarker(SELECTION, 2);
  assert.match(selection, /^\[编辑器位置 #2 · Cursor 插入标记\]/);
  assert.match(selection, /绝对路径：\/w\/src\/auth\.ts/);
  assert.match(selection, /工作区相对路径：src\/auth\.ts/);
  assert.match(selection, /选中第 11-14 行（共 4 行）/);
  assert.match(selection, /read offset=11 limit=4/);
  assert.doesNotMatch(selection, /用户当前在/, 'the old third-person narration is gone');

  assert.match(renderMarker(CURSOR, 7), /#7 · Cursor 插入标记/);
  assert.match(renderMarker(CURSOR, 7), /光标停在第 42 行/);
  assert.match(renderMarker({ ...SELECTION, selection: null }, 1), /没有选区/);
});

test('renderMarker is empty when there is no file to point at', () => {
  assert.equal(renderMarker({ ...SELECTION, activeFile: '', relativePath: '' }, 1), '');
});

test('buildMessages numbers one insertion and keeps the ask as its own section', () => {
  const plain = buildMessages(SELECTION, '   ', 3);
  assert.equal(plain.content.length, 1);
  assert.equal(plain.role, 'user');
  assert.equal(plain.source.kind, SOURCE_KIND);
  assert.equal(plain.source.form, 'snapshot', 'the GUI renders a closed-set form');
  assert.deepEqual(plain.source.sections.map((s) => s.name), ['编辑器位置']);
  assert.match(plain.content[0].text, /#3/);
  assert.equal(Object.isFrozen(plain), true);

  const asked = buildMessages(SELECTION, ' 这里为什么报错 ', 4);
  assert.equal(asked.content.length, 1);
  assert.match(asked.content[0].text, /—— 随本次插入一起提出 ——\n这里为什么报错$/);
  assert.deepEqual(asked.source.sections.map((s) => s.name), ['编辑器位置', '随插入一起提出的问题']);
});

test('buildMessages refuses a position with no address', () => {
  assert.equal(buildMessages({ ...SELECTION, activeFile: '', relativePath: '' }, '', 1), undefined);
});

test('contextMessage mints a fresh id each time', () => {
  const a = contextMessage([{ type: 'text', text: 'x' }], [{ name: 'n', text: 'x' }]);
  const b = contextMessage([{ type: 'text', text: 'x' }], [{ name: 'n', text: 'x' }]);
  assert.notEqual(a.id, b.id);
  assert.equal(a.source.kind, SOURCE_KIND);
});

test('the default config pushes nothing and still serves the chip channel', () => {
  const ctx = fakeCtx();
  apply(ctx, {});
  assert.equal(ctx.registered.length, 0, 'no slash command exists unless the config asks for one');
  assert.equal(ctx.listeners.size, 0, 'no per-turn listener');
  assert.equal(ctx.projections.length, 0, 'no counter without a push channel');
  assert.equal(ctx.routes.length, 1, 'the browser half still needs the position route');
  assert.equal(ctx.sections.length, 1, 'and the model still needs the #L grammar');
});

test('mode off drops the push channel only', () => {
  const ctx = fakeCtx();
  apply(ctx, { mode: 'off' });
  assert.equal(ctx.registered.length, 0);
  assert.equal(ctx.listeners.size, 0);
  assert.equal(ctx.projections.length, 0, 'off does not even register the counter');
  assert.equal(ctx.routes.length, 1, 'off is not "mount nothing": the chip channel is separate');
});

test('on-demand registers the commands and injects only when invoked', async () => {
  const dir = await publish(SELECTION);
  const ctx = fakeCtx();
  apply(ctx, { mode: 'on-demand', commands: ['ide', 'here'], stateDir: dir });
  assert.deepEqual(ctx.registered.map((d) => d.name), ['ide', 'here']);
  assert.equal(ctx.listeners.size, 0, 'on-demand adds no per-turn listener');
  assert.deepEqual(ctx.projections.map((d) => d.key), [COUNTER_KEY], 'the counter is durable');

  const agent = fakeAgent();
  const result = await ctx.registered[0].handler({ agent, rawInput: '这里为什么报错' });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /已插入标记 #1/);
  assert.equal(agent.inbox.prepended.length, 1);
  assert.equal(agent.inbox.prepended[0].target, 'next-step');
  assert.match(agent.inbox.prepended[0].message.content[0].text, /#1 · Cursor 插入标记/);
  assert.match(agent.inbox.prepended[0].message.content[0].text, /这里为什么报错/);
});

test('repeated insertions in one conversation are numbered apart', async () => {
  const dir = await publish(SELECTION);
  const ctx = fakeCtx();
  apply(ctx, { mode: 'on-demand', commands: ['ide', 'here'], stateDir: dir });
  const agent = fakeAgent();
  for (let i = 0; i < 3; i += 1) await ctx.registered[0].handler({ agent, rawInput: '' });

  const numbers = agent.inbox.prepended.map(({ message }) => /#(\d+)/.exec(message.content[0].text)[1]);
  assert.deepEqual(numbers, ['1', '2', '3'], 'a marker still in the inbox is already numbered');
});

test('the numbering continues after a restart via the durable counter', async () => {
  const dir = await publish(SELECTION);
  const ctx = fakeCtx({
    sessionProjections: { register() {}, stateOf: () => ({ count: 4 }) },
  });
  apply(ctx, { mode: 'on-demand', commands: ['ide', 'here'], stateDir: dir });
  const agent = fakeAgent();
  await ctx.registered[0].handler({ agent, rawInput: '' });
  assert.match(agent.inbox.prepended[0].message.content[0].text, /#5/, 'four markers survived the restart');
});

test('an unreadable counter degrades to in-memory numbering instead of failing', async () => {
  const dir = await publish(SELECTION);
  const ctx = fakeCtx({
    sessionProjections: {
      register() {},
      stateOf() {
        throw new Error('no row yet');
      },
    },
  });
  apply(ctx, { mode: 'on-demand', commands: ['ide', 'here'], stateDir: dir });
  const agent = fakeAgent();
  const result = await ctx.registered[0].handler({ agent, rawInput: '' });
  assert.equal(result.kind, 'success');
  assert.match(agent.inbox.prepended[0].message.content[0].text, /#1/);
});

test('each agent numbers independently', async () => {
  const dir = await publish(SELECTION);
  const ctx = fakeCtx();
  apply(ctx, { mode: 'on-demand', commands: ['ide', 'here'], stateDir: dir });
  const a = fakeAgent();
  const b = fakeAgent();
  await ctx.registered[0].handler({ agent: a, rawInput: '' });
  await ctx.registered[0].handler({ agent: b, rawInput: '' });
  assert.match(a.inbox.prepended[0].message.content[0].text, /#1/);
  assert.match(b.inbox.prepended[0].message.content[0].text, /#1/);
});

test('the command reports a missing position and an excluded one', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'editor-context-none2-'));
  const ctxEmpty = fakeCtx();
  apply(ctxEmpty, { mode: 'on-demand', commands: ['ide', 'here'], stateDir: empty });
  const missing = await ctxEmpty.registered[0].handler({ agent: fakeAgent(), rawInput: '' });
  assert.equal(missing.kind, 'error');
  assert.match(missing.text, /没有可用的编辑器位置/);

  const excluded = await publish({ ...SELECTION, context: '', relativePath: '.env' });
  const ctxExcluded = fakeCtx();
  apply(ctxExcluded, { mode: 'on-demand', commands: ['ide', 'here'], stateDir: excluded });
  const agent = fakeAgent();
  const result = await ctxExcluded.registered[0].handler({ agent, rawInput: '' });
  assert.equal(result.kind, 'error');
  assert.equal(agent.inbox.prepended.length, 0, 'an excluded position must not reach the model');
});

test('selection mode injects for a changed selection, once, on step 1 only', async () => {
  const dir = await publish(SELECTION);
  const ctx = fakeCtx();
  apply(ctx, { mode: 'selection', stateDir: dir });
  const preStep = ctx.listeners.get('agent/pre-step');
  assert.equal(typeof preStep, 'function');

  const agent = fakeAgent();
  const decision = { kind: 'enter', messages: [] };
  const next = async () => decision;

  const first = await preStep({ agent, messages: [], step: 1 }, next);
  assert.equal(first.messages.length, 1);
  assert.match(first.messages[0].content[0].text, /#1 · Cursor 插入标记/);
  assert.match(first.messages[0].content[0].text, /选中第 11-14 行/);

  const again = await preStep({ agent, messages: [], step: 1 }, next);
  assert.equal(again, decision, 'the same selection never injects twice');

  const later = await preStep({ agent, messages: [], step: 2 }, next);
  assert.equal(later, decision, 'only the first step of a turn is considered');
});

test('selection mode ignores a bare cursor', async () => {
  const dir = await publish(CURSOR);
  const ctx = fakeCtx();
  apply(ctx, { mode: 'selection', stateDir: dir });
  const preStep = ctx.listeners.get('agent/pre-step');
  const decision = { kind: 'enter', messages: [] };
  const result = await preStep({ agent: fakeAgent(), messages: [], step: 1 }, async () => decision);
  assert.equal(result, decision, 'a cursor is not a deliberate act');
});

test('a rejected pre-step is passed through untouched', async () => {
  const dir = await publish(SELECTION);
  const ctx = fakeCtx();
  apply(ctx, { mode: 'selection', stateDir: dir });
  const rejected = { kind: 'reject' };
  const result = await ctx.listeners.get('agent/pre-step')(
    { agent: fakeAgent(), messages: [], step: 1 },
    async () => rejected,
  );
  assert.equal(result, rejected);
});

test('each agent dedups independently', async () => {
  const dir = await publish(SELECTION);
  const ctx = fakeCtx();
  apply(ctx, { mode: 'selection', stateDir: dir });
  const preStep = ctx.listeners.get('agent/pre-step');
  const a = fakeAgent();
  const b = fakeAgent();
  const decision = { kind: 'enter', messages: [] };
  const first = await preStep({ agent: a, messages: [], step: 1 }, async () => decision);
  const second = await preStep({ agent: b, messages: [], step: 1 }, async () => decision);
  assert.equal(first.messages.length, 1);
  assert.equal(second.messages.length, 1, 'another agent has its own memory');
});

after(async () => {
  await rm(join(tmpdir(), 'editor-context-plugin-'), { recursive: true, force: true });
});

test('apply registers the position route and the token-grammar section', () => {
  const ctx = fakeCtx();
  apply(ctx, { mode: 'on-demand', commands: ['ide', 'here'], stateDir: '/x' });
  assert.deepEqual(
    ctx.routes.map((route) => `${route.kind} ${route.path}`),
    ['exact /editor-context/position'],
    'the browser half reads the position over exactly this route',
  );
  assert.deepEqual(
    ctx.sections.map((section) => [section.name, section.order]),
    [['editor-context', 910]],
    'order 910 sits immediately after FILE_REFERENCE at 900',
  );
  assert.match(ctx.sections[0].text, /#L/);
  assert.match(ctx.sections[0].text, /path is everything before/, 'the model must not read #L as part of the path');
});

test('http: false leaves the plugin a pure push provider', () => {
  const ctx = fakeCtx();
  apply(ctx, { mode: 'on-demand', commands: ['ide', 'here'], stateDir: '/x', http: false });
  assert.deepEqual(ctx.routes, [], 'no endpoint for the browser to read');
  assert.equal(ctx.sections.length, 1, 'the grammar is still needed by the push channel');
  assert.equal(ctx.registered.length, 2, 'the slash commands still register');
});
