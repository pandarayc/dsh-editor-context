/**
 * Tests for the browser half.
 *
 * The real `lib/client.js` is loaded as-is: a fake `window.__ModuleLoader__`
 * captures the registration, a fake `require` stands in for the module registry,
 * and a fake cordis context records what the plugin registers. Nothing is
 * re-implemented here, so the assertions are about the shipped bytes.
 *
 *   node --test test/client.test.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

const ENTRY_ID = 'dsh-editor-context';

/**
 * Load `lib/client.js` and return its module exports.
 * @returns {Promise<{id: string, exports: {apply: Function, inject: string[]}, react: object, effects: Function[]}>}
 */
async function loadClientHalf() {
  let captured;
  const previous = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: (registration) => { captured = registration; } } };
  try {
    // Cache-busted so parallel test files cannot share a partially initialized
    // module registry.
    await import(`../lib/client.js?test=${String(Date.now())}`);
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
  assert.ok(captured, 'the bundle must register itself with the module loader');
  /** Effects the bundle asked React to run, so a component can be driven headlessly. */
  const effects = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useEffect: (fn) => {
      effects.push(fn());
    },
  };
  const exports = captured.factory((id) => {
    if (id === 'react') return React;
    throw new Error(`unexpected require("${id}")`);
  });
  return { id: captured.id, exports, react: React, effects };
}

/** A cordis context that records registrations, keyed by the slot they went into. */
function fakeCtx() {
  const state = { rules: [], nodes: [], sources: [], effects: 0 };
  const registrations = [];
  const sessions = { scope: (sessionId) => ({ sessionId, kind: 'actx' }) };
  const conversation = { input: { for: () => ({ addFiles: () => true }) } };
  return {
    ...state,
    state,
    registrations,
    sessions,
    conversation,
    uiConversation: { userText: { register: (rule) => state.rules.push(rule) } },
    slots: {
      inject: (slot, callback) => {
        for (const registration of callback()) registrations.push({ slot, ...registration });
      },
      register: (definition, component) => {
        state.nodes.push({ definition, component });
        return { definition, component };
      },
    },
    inputTriggers: { registerSource: (source) => state.sources.push(source) },
    get: (service) => (service === 'conversation' ? conversation : undefined),
    effect: (fn) => {
      state.effects += 1;
      return fn();
    },
  };
}

/** One JSON response double. */
function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

const READING = {
  ok: true,
  absolutePath: '/w/src/fancygame/hallsrv/internal/logic/logic_purchase/limit.go',
  workspacePath: 'hallsrv/internal/logic/logic_purchase/limit.go',
  selection: { startLine: 165, endLine: 185, isEmpty: false },
  updatedAt: '2026-10-15T00:00:00.000Z',
};

test('the bundle registers under the loader entry id', async () => {
  const { id } = await loadClientHalf();
  assert.equal(id, ENTRY_ID, 'the id must match the mounted row name the module route is keyed by');
});

test('apply waits for the four services it reaches through', async () => {
  const { exports } = await loadClientHalf();
  assert.deepEqual(exports.inject, ['inputTriggers', 'uiConversation', 'slots', 'sessions']);
});

test('apply registers one rule, two slot entries and one trigger source', async () => {
  const { exports } = await loadClientHalf();
  const ctx = fakeCtx();
  exports.apply(ctx);
  assert.deepEqual(ctx.state.rules.map((r) => r.id), ['editorPosition']);
  assert.deepEqual(
    ctx.registrations.map((r) => `${r.slot} ${r.definition.key ?? r.definition.id}`),
    ['conversation.user.text.node editorPosition', 'conversation.input.dock editor-position-intake'],
  );
  assert.deepEqual(ctx.state.sources.map((s) => `${s.trigger}${s.name}`), ['@editor-position']);
});

test('the intake slot resolves the composer it should insert into', async () => {
  const { exports } = await loadClientHalf();
  const ctx = fakeCtx();
  exports.apply(ctx);
  const intake = ctx.registrations.find((r) => r.definition.id === 'editor-position-intake');

  // A slot's `inject` is the supported way to learn which session is on screen.
  const props = intake.definition.inject('session-7');
  assert.equal(typeof props.insert, 'function');
  assert.equal(intake.definition.inject('session-7').insert, props.insert, 'memoised, so the effect does not restart each render');

  let asked = null;
  ctx.conversation.input.for = (actx) => {
    asked = actx;
    return {
      addFiles: (references, ids) => {
        asked = { actx, references, ids };
        return true;
      },
    };
  };
  const applied = props.insert({
    absolutePath: '/w/src/limit.go',
    workspacePath: 'src/limit.go',
    selection: { startLine: 146, endLine: 154, isEmpty: false },
  });
  assert.equal(applied, true);
  assert.equal(asked.actx.sessionId, 'session-7', 'the session scope comes from the slot, not from a global');
  assert.deepEqual(asked.ids, [], 'a position is not an attachment');
  assert.deepEqual(asked.references, [
    {
      source: 'editor-position',
      ref: '@/w/src/limit.go#L146-L154',
      label: 'limit.go:146-154',
      appearance: 'file',
      clipboardText: '@/w/src/limit.go#L146-L154',
    },
  ]);
});

test('the intake tolerates a session that has gone away', async () => {
  const { exports } = await loadClientHalf();
  const ctx = fakeCtx();
  exports.apply(ctx);
  const props = ctx.registrations.find((r) => r.definition.id === 'editor-position-intake').definition.inject('gone');
  ctx.sessions.scope = () => undefined;
  assert.equal(props.insert({ absolutePath: '/w/src/a.ts' }), false);
  ctx.sessions.scope = () => {
    throw new Error('torn down');
  };
  assert.equal(props.insert({ absolutePath: '/w/src/a.ts' }), false, 'a teardown mid-click is not an error to surface');
});

test('the rule beats the built-in file rule at the same start', async () => {
  const { exports } = await loadClientHalf();
  const rule = (() => {
    const ctx = fakeCtx();
    exports.apply(ctx);
    return ctx.state.rules[0];
  })();
  // The shipped fileReferenceRule is order 30; lower wins a same-start tie.
  assert.ok(rule.order < 30, `order ${rule.order} must sort before the built-in file rule`);
});

test('the rule parses a range, a single line and a quoted path', async () => {
  const { exports } = await loadClientHalf();
  const ctx = fakeCtx();
  exports.apply(ctx);
  const rule = ctx.state.rules[0];

  const text = 'see @/w/a/limit.go#L165-L185 then @/w/b.go#L7';
  const first = rule.match(text, 0);
  assert.equal(first.id, 'editorPosition');
  assert.equal(first.start, 4);
  assert.equal(text.slice(first.start, first.end), '@/w/a/limit.go#L165-L185');
  assert.deepEqual(first.data, { path: '/w/a/limit.go', startLine: 165, endLine: 185 });

  const second = rule.match(text, first.end);
  assert.equal(text.slice(second.start, second.end), '@/w/b.go#L7');
  assert.deepEqual(second.data, { path: '/w/b.go', startLine: 7, endLine: 7 });

  const quoted = rule.match('@"a b.go"#L12-34', 0);
  assert.deepEqual(quoted.data, { path: 'a b.go', startLine: 12, endLine: 34 });

  const shortRange = rule.match('@/w/c.go#L12-34', 0);
  assert.deepEqual(shortRange.data, { path: '/w/c.go', startLine: 12, endLine: 34 });
});

test('the rule leaves a bare @path to the built-in file rule', async () => {
  const { exports } = await loadClientHalf();
  const ctx = fakeCtx();
  exports.apply(ctx);
  const rule = ctx.state.rules[0];
  assert.equal(rule.match('open @/w/a/limit.go please', 0), undefined);
});

test('the rule ignores an @ glued to a word', async () => {
  const { exports } = await loadClientHalf();
  const ctx = fakeCtx();
  exports.apply(ctx);
  const rule = ctx.state.rules[0];
  assert.equal(rule.match('mail me at a@b.go#L12', 0), undefined);
  assert.equal(rule.match('x@y.go#L12', 0), undefined);
});

test('the rule returns the nearest candidate, not the first anywhere', async () => {
  const { exports } = await loadClientHalf();
  const ctx = fakeCtx();
  exports.apply(ctx);
  const rule = ctx.state.rules[0];
  const text = '@/a.go#L1 and @/b.go#L2';
  const fromMiddle = rule.match(text, 10);
  assert.equal(text.slice(fromMiddle.start, fromMiddle.end), '@/b.go#L2');
});

test('candidates come from the host endpoint and honour the query', async () => {
  const { exports } = await loadClientHalf();
  const ctx = fakeCtx();
  exports.apply(ctx);
  const source = ctx.state.sources[0];

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(READING);
  };
  try {
    const rows = await source.candidates({ sessionId: 's' }, { query: '', signal: undefined });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'limit.go:165-185');
    assert.equal(rows[0].description, 'hallsrv/internal/logic/logic_purchase/limit.go');
    assert.equal(rows[0].section, '编辑器位置');
    assert.deepEqual(JSON.parse(rows[0].value), {
      mention: '@/w/src/fancygame/hallsrv/internal/logic/logic_purchase/limit.go#L165-L185',
      label: 'limit.go:165-185',
    });
    assert.equal(calls[0].url, '/editor-context/position');
    assert.equal(calls[0].options.cache, 'no-store', 'a cached position is a wrong position');

    const filtered = await source.candidates({ sessionId: 's' }, { query: 'nope', signal: undefined });
    assert.deepEqual(filtered, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a bare cursor becomes a single-line mention', async () => {
  const { exports } = await loadClientHalf();
  const ctx = fakeCtx();
  exports.apply(ctx);
  const source = ctx.state.sources[0];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    jsonResponse({ ...READING, selection: { startLine: 152, endLine: 152, isEmpty: true } });
  try {
    const [row] = await source.candidates({ sessionId: 's' }, { query: '', signal: undefined });
    assert.equal(row.name, 'limit.go:152');
    assert.equal(
      JSON.parse(row.value).mention,
      '@/w/src/fancygame/hallsrv/internal/logic/logic_purchase/limit.go#L152',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('every failure mode is an empty menu, never an error', async () => {
  const { exports } = await loadClientHalf();
  const ctx = fakeCtx();
  exports.apply(ctx);
  const source = ctx.state.sources[0];
  const originalFetch = globalThis.fetch;
  const scenarios = [
    async () => ({ ok: false, status: 404, json: async () => ({ ok: false }) }),
    async () => jsonResponse({ ok: false }),
    async () => jsonResponse({ ok: true, absolutePath: '' }),
    async () => {
      throw new Error('network down');
    },
  ];
  try {
    for (const scenario of scenarios) {
      globalThis.fetch = scenario;
      assert.deepEqual(await source.candidates({ sessionId: 's' }, { query: '', signal: undefined }), []);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('onPick inserts a reference node with a short label', async () => {
  const { exports } = await loadClientHalf();
  const ctx = fakeCtx();
  exports.apply(ctx);
  const candidate = { value: JSON.stringify({ mention: '@/w/a/limit.go#L146-L154', label: 'limit.go:146-154' }) };
  const outcome = ctx.state.sources[0].onPick({ candidate, action: 'pick' });
  assert.deepEqual(outcome, {
    insert: {
      source: 'editor-position',
      ref: '@/w/a/limit.go#L146-L154',
      label: 'limit.go:146-154',
      appearance: 'file',
      clipboardText: '@/w/a/limit.go#L146-L154',
    },
  });
  assert.equal(
    outcome.insert.ref,
    outcome.insert.clipboardText,
    'the draft schema holds the document span length to the clipboard text length',
  );
  assert.equal(outcome.insert.appearance, 'file', 'appearance is a closed enum: session | file | folder');
});

test('the source carries a codec, without which the send path rejects the draft', async () => {
  const { exports } = await loadClientHalf();
  const ctx = fakeCtx();
  exports.apply(ctx);
  const source = ctx.state.sources[0];
  // `serializeReference` rejects when the owning source has no codec, and the
  // submission is blocked rather than downgraded — an observed failure mode.
  assert.equal(typeof source.codec?.serialize, 'function', 'a chip needs an owner codec to reach the model');
  assert.equal(source.codec.clipboardText('@/w/a.go#L7'), '@/w/a.go#L7');
  const serialized = await source.codec.serialize('@/w/a.go#L7', undefined);
  assert.equal(
    serialized,
    '@/w/a.go#L7',
    'the model form is the token the rule parses back, not the chip label',
  );
});

test('the node component renders the address it was given', async () => {
  const { exports } = await loadClientHalf();
  const ctx = fakeCtx();
  exports.apply(ctx);
  const [{ component }] = ctx.state.nodes;
  const element = component({ node: { data: { path: '/w/a/limit.go', startLine: 165, endLine: 185 } } });
  assert.equal(element.type, 'code');
  assert.deepEqual(element.children, ['limit.go:165-185']);
  assert.equal(element.props.title, '/w/a/limit.go');
  assert.equal(element.props['data-editor-position'], '165-185');
});

/** Wait for a predicate, so a background loop can be observed without sleeping blindly. */
async function until(predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  return predicate();
}

test('the intake long-polls, inserts what arrives, and never replays a seq', async () => {
  const { exports, effects } = await loadClientHalf();
  const ctx = fakeCtx();
  exports.apply(ctx);
  const intake = ctx.registrations.find((r) => r.definition.id === 'editor-position-intake');

  const inserted = [];
  ctx.conversation.input.for = () => ({ addFiles: (references) => { inserted.push(references[0]); return true; } });

  const asked = [];
  const reading = {
    seq: 7,
    absolutePath: '/w/src/limit.go',
    workspacePath: 'src/limit.go',
    selection: { startLine: 146, endLine: 154, isEmpty: false },
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    asked.push(String(url));
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal, 'every request must be abortable, or a closed tab leaks a parked promise');
    if (asked.length === 1) {
      // The host parked the response and the hold expired with nothing to say.
      await new Promise((resolve) => {
        setTimeout(resolve, 1_100);
      });
      return { status: 204, ok: false };
    }
    // Then a click lands, and afterwards the host answers with the same seq
    // again — which must not become a second chip.
    return { status: 200, ok: true, json: async () => reading };
  };

  try {
    const props = intake.definition.inject('s1');
    intake.component(props);
    assert.equal(await until(() => inserted.length >= 1), true, 'the delivered position reached the composer');
    assert.deepEqual(asked, ['/editor-context/next?since=0', '/editor-context/next?since=0']);
    assert.deepEqual(inserted[0], {
      source: 'editor-position',
      ref: '@/w/src/limit.go#L146-L154',
      label: 'limit.go:146-154',
      appearance: 'file',
      clipboardText: '@/w/src/limit.go#L146-L154',
    });

    // Let the loop consume several replayed replies.
    assert.equal(await until(() => asked.length >= 4), true);
    assert.equal(inserted.length, 1, 'a seq already consumed is dropped, so the loop is idempotent');
    assert.equal(asked[asked.length - 1], '/editor-context/next?since=7', 'the cursor advances with the delivery');
  } finally {
    for (const stop of effects) if (typeof stop === 'function') stop();
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  }
});
