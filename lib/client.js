/**
 * dsh-editor-context — browser half.
 *
 * What this changes about the feature: the editor position stops being a
 * message the plugin pushes into the conversation, and becomes a token the user
 * *types*, exactly like `@file`. Picking a candidate inserts plain characters:
 *
 *     @/abs/path/to/limit.go#L165-L185
 *
 * and the chip look is derived by scanning that text — never stored. That is
 * the alpha.3 model, and it is why nothing here builds a chip node: the
 * composer's editor holds ordinary characters, and both the composer and the
 * replayed transcript turn them back into a chip with the same rule.
 *
 * Two halves, one package:
 *
 *   - `inputTriggers` source — offers "where I am right now" in the `@` menu.
 *     Candidates come from the host over same-origin HTTP, because the browser
 *     cannot read `~/.editor-context/`.
 *   - `UserText` rule + node slot — parses the token back out of the original
 *     text and renders it as a chip.
 *
 * Only `react` is imported: cross-package reach is through cordis services
 * (`ctx.slots`, `ctx.uiConversation`, `ctx.inputTriggers`), which is how every
 * shipped client bundle does it.
 *
 * @module dsh-editor-context/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-editor-context',
  factory: (require) => {
    // The module wrapper a bundler would normally generate around a package
    // entry. Hand-written bundles must bring their own: the loader hands the
    // factory a `require` and nothing else, and reads the plugin back off
    // `module.exports`.
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');

    const name = 'editor-context-client';
    const inject = ['inputTriggers', 'uiConversation', 'slots', 'sessions'];

    /** Same-origin routes registered by the host half. */
    const ENDPOINT = '/editor-context/position';
    const NEXT_ENDPOINT = '/editor-context/next';
    const EDITORS_ENDPOINT = '/editor-context/editors';

    /**
     * The browser's own language, for the one piece of copy DSH does not own.
     *
     * No locale service on purpose: the command is four strings, and a missing
     * locale dependency would take the command down with it.
     */
    const ZH = (() => {
      try {
        return /^zh/i.test(String(navigator.language));
      } catch {
        return false;
      }
    })();
    const t = (zh, en) => (ZH ? zh : en);
    /** Business id of the text node this plugin owns; `text` is reserved. */
    const RULE_ID = 'editorPosition';
    /** Menu group title. */
    const SECTION = '编辑器位置';
    /**
     * The reference source name. It has to match the `inputTriggers` source
     * below, because the send path resolves a chip back through the roster by
     * this name to find the source whose `codec` expands it for the model.
     */
    const SOURCE_NAME = 'editor-position';

    /**
     * `@<path>#L12`, `@<path>#L12-L34`, `@<path>#L12-34`, and the quoted path
     * form `@"a b.go"#L12`. The path ends at the first `#`; the suffix is the
     * line address.
     *
     * Why `#L` and not `:12-34` or ` (12-34)`: the shipped file rule matches
     * `@<path>` by scanning to whitespace, so a colon or a paren would be
     * swallowed *into the path* by the built-in rule, leaving two rules
     * claiming overlapping spans and the winner decided by an ordering detail.
     * `#` is not part of that grammar at all, so this rule owns the whole token
     * unambiguously — and `#L` is the line-address convention models already
     * know from web forges.
     */
    const TOKEN = /@(?:"([^"\n]+)"|([^\s"]+?))#L(\d+)(?:-L?(\d+))?/gu;

    /**
     * Read the host's current position, or `undefined` when there is none.
     * A closed editor, a stale reading and an excluded path are all just "no
     * candidate" here — the menu shows nothing rather than an error.
     * @param signal - abort signal from the menu's fetch.
     * @returns the payload, or `undefined`.
     */
    async function readPosition(signal) {
      try {
        const response = await fetch(ENDPOINT, { signal, cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) return undefined;
        const payload = await response.json();
        if (payload === null || typeof payload !== 'object' || payload.ok !== true) return undefined;
        if (typeof payload.absolutePath !== 'string' || payload.absolutePath === '') return undefined;
        return payload;
      } catch {
        return undefined;
      }
    }

    /** Last path segment, for a label short enough to sit in a menu row. */
    function basename(path) {
      const at = path.lastIndexOf('/');
      return at < 0 ? path : path.slice(at + 1);
    }

    /** The line address of a reading, as `12` or `12-34`. */
    function lineLabel(payload) {
      const selection = payload.selection;
      if (selection === null || selection === undefined) return '';
      if (selection.isEmpty === true) return `:${selection.startLine}`;
      return `:${selection.startLine}-${selection.endLine}`;
    }

    /** The text a pick inserts — the token this rule will parse back. */
    function mentionOf(payload) {
      const selection = payload.selection;
      if (selection === null || selection === undefined) return `@${payload.absolutePath}`;
      if (selection.isEmpty === true) return `@${payload.absolutePath}#L${selection.startLine}`;
      return `@${payload.absolutePath}#L${selection.startLine}-L${selection.endLine}`;
    }

    /** Whether a candidate survives the text typed after `@`. */
    function matchesQuery(label, query) {
      const trimmed = typeof query === 'string' ? query.trim() : '';
      if (trimmed === '') return true;
      return label.toLowerCase().includes(trimmed.toLowerCase());
    }

    /**
     * The `@` source: one row, the position the editor is on right now.
     * A fixed single candidate rather than a filtered list — the user is
     * pointing at a place, not searching for one.
     */
    const positionSource = {
      trigger: '@',
      name: SOURCE_NAME,
      showGroupTitle: true,
      // Sorted after the built-in `reference` source, which has no order.
      order: 50,
      async candidates(_session, { query, signal }) {
        const payload = await readPosition(signal);
        if (payload === undefined) return [];
        const label = `${basename(payload.absolutePath)}${lineLabel(payload)}`;
        if (!matchesQuery(label, query)) return [];
        return [
          {
            name: label,
            ...(typeof payload.workspacePath === 'string' && payload.workspacePath !== ''
              ? { description: payload.workspacePath }
              : {}),
            icon: 'file',
            section: SECTION,
            // Opaque to the menu; handed back verbatim in `onPick`.
            value: JSON.stringify({ mention: mentionOf(payload), label }),
          },
        ];
      },
      /**
       * Hand the editor a reference node, not bare characters.
       *
       * There are two ways to land text in the composer and they are not
       * equivalent:
       *
       *   `{ text }`   — ordinary characters. The composer decorates them only
       *                  if they match a name some source publishes through its
       *                  `lexicon`, and the chip then reads the whole name.
       *   `{ insert }` — a reference record carrying its own `label`, so the
       *                  chip shows `limit.go:146-154` while the document text
       *                  stays the full `@path#L…` mention.
       *
       * We want the second: the mention is long by necessity (absolute path),
       * and a chip that reprints it is worse than no chip. `clipboardText` must
       * equal `ref`, because the draft schema holds the document span length to
       * the clipboard text length.
       *
       * The transcript does not depend on this: replayed messages are parsed
       * from their text by {@link editorPositionRule}, which is why the same
       * token is still a chip a week later.
       */
      onPick({ candidate }) {
        const picked = JSON.parse(candidate.value);
        return {
          insert: {
            source: 'editor-position',
            ref: picked.mention,
            label: picked.label,
            appearance: 'file',
            clipboardText: picked.mention,
          },
        };
      },
      /**
       * The model form of one occurrence.
       *
       * A reference occurrence is a chip in the editor, and the send path
       * expands every occurrence through its owner's codec *before* the sink —
       * `serializeReference` rejects outright when the owner has no codec, and
       * the whole submission is blocked rather than downgraded to the clipboard
       * text. So this is not optional once a chip exists.
       *
       * The model must receive the same `@<path>#L…` token the rule parses back,
       * which is why the serialized form is the `ref` itself and not the chip
       * label: the label is for the human, the token is for the model.
       */
      codec: {
        clipboardText: (ref) => ref,
        serialize: (ref) => Promise.resolve(ref),
      },
    };

    /**
     * Forward matcher over the original text. Pure and synchronous — it reads
     * no Facts, so it evaluates identically while typing and while replaying
     * history.
     */
    const editorPositionRule = {
      id: RULE_ID,
      // Ascending order wins same-start ties; the shipped `file` rule is 30, so
      // 20 lets a `#L` token beat "treat the whole thing as a path" without
      // disturbing a bare `@path`.
      order: 20,
      match(text, from) {
        TOKEN.lastIndex = from;
        let found;
        while ((found = TOKEN.exec(text)) !== null) {
          const start = found.index;
          // An `@` glued to a word is part of that word (an email, a decorator),
          // not a reference.
          const before = start === 0 ? '' : text[start - 1];
          if (before !== '' && /[\p{L}\p{N}_.@-]/u.test(before)) continue;
          const path = found[1] ?? found[2] ?? '';
          if (path === '') continue;
          const startLine = Number(found[3]);
          const endLine = found[4] === undefined ? startLine : Number(found[4]);
          if (!Number.isSafeInteger(startLine) || startLine < 1) continue;
          return {
            id: RULE_ID,
            start,
            // Half-open over the whole token, so the range is part of the node.
            end: start + found[0].length,
            data: {
              path,
              startLine,
              endLine: Number.isSafeInteger(endLine) && endLine >= startLine ? endLine : startLine,
            },
          };
        }
        return undefined;
      },
    };

    /** One inline chip for a parsed editor position. */
    function EditorPositionChip(props) {
      const data = props.node?.data ?? {};
      const path = typeof data.path === 'string' ? data.path : '';
      const startLine = data.startLine;
      const endLine = typeof data.endLine === 'number' ? data.endLine : startLine;
      const label = endLine > startLine ? `${basename(path)}:${startLine}-${endLine}` : `${basename(path)}:${startLine}`;
      return React.createElement(
        'code',
        {
          title: path,
          'data-editor-position': `${startLine}-${endLine}`,
          style: {
            padding: '0 4px',
            borderRadius: '3px',
            background: 'rgba(127,127,127,0.18)',
            font: 'inherit',
            whiteSpace: 'nowrap',
          },
        },
        label,
      );
    }

    /** Sleep, without holding the loop. */
    function delay(ms) {
      return new Promise((resolve) => {
        setTimeout(resolve, ms);
      });
    }

    /** Minimum spacing between two long-poll asks, whatever the host answers. */
    const INTAKE_FLOOR_MS = 250;
    /** Backoff after a failed ask — host restarting, route gone. */
    const INTAKE_RETRY_MS = 3_000;

    /**
     * The reference record for a delivered reading.
     *
     * This is the same record the `@` pick hands the composer, built from the
     * same payload — a position is a position however it arrived.
     * @param payload - a `/editor-context/next` body.
     * @returns the reference, or `undefined` when there is nothing to address.
     */
    function referenceOf(payload) {
      const absolutePath = payload.absolutePath;
      if (typeof absolutePath !== 'string' || absolutePath === '') return undefined;
      const mention = mentionOf(payload);
      return {
        source: SOURCE_NAME,
        ref: mention,
        label: `${basename(absolutePath)}${lineLabel(payload)}`,
        appearance: 'file',
        clipboardText: mention,
      };
    }

    /** Per-session insert functions, so the React effect below has a stable prop. */
    const inserts = new Map();

    /**
     * Resolve "put this reference in the composer draft" for one session.
     *
     * The service chain is the one the shipped drag-and-drop path uses:
     * `sessions.scope` → the session-scoped `conversation` service → its input
     * facade. `addFiles` inserts at the live selection and does not need a
     * pick-time span, which is exactly what a click that happened in another
     * application cannot provide.
     * @param ctx - client root context.
     * @param sessionId - the session whose composer should receive it.
     * @returns a function returning whether the insertion applied.
     */
    function insertFor(ctx, sessionId) {
      const existing = inserts.get(sessionId);
      if (existing !== undefined) return existing;
      const insert = (payload) => {
        try {
          const actx = ctx.sessions?.scope(sessionId);
          if (actx === undefined) return false;
          const conversation = ctx.get('conversation');
          if (conversation === undefined) return false;
          const reference = referenceOf(payload);
          if (reference === undefined) return false;
          return conversation.input.for(actx).addFiles([reference], []) === true;
        } catch {
          // A session being torn down is not an error worth surfacing: the next
          // click lands in whichever composer is live by then.
          return false;
        }
      };
      inserts.set(sessionId, insert);
      return insert;
    }

    /**
     * Long-poll the host for positions the user clicked in the editor.
     *
     * Not an interval. Each iteration asks "anything after `seq`?" and the host
     * parks the response until a file lands or the hold expires, so an idle
     * conversation costs one open request rather than a wakeup every second.
     * @param insert - the session's insert function.
     * @returns a stop function, suitable as a React effect cleanup.
     */
    function startIntake(insert) {
      let stopped = false;
      let since = 0;
      let controller;
      const stop = () => {
        stopped = true;
        controller?.abort();
      };
      void (async () => {
        while (!stopped) {
          controller = new AbortController();
          const askedAt = Date.now();
          try {
            const response = await fetch(`${NEXT_ENDPOINT}?since=${String(since)}`, {
              signal: controller.signal,
              cache: 'no-store',
              credentials: 'same-origin',
            });
            // 204 is the idle path: the hold expired with nothing to deliver.
            if (response.status !== 204) {
              if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
              const payload = await response.json();
              const seq = payload?.seq;
              // Monotonic: a reply we have already consumed must not be replayed.
              if (typeof seq === 'number' && seq > since) {
                since = seq;
                if (typeof payload.absolutePath === 'string' && payload.absolutePath !== '') insert(payload);
              }
            }
          } catch {
            if (stopped) return;
            // Host restarting, tab throttled, route disabled: back off rather
            // than hammer it.
            await delay(INTAKE_RETRY_MS);
          }
          // A floor between asks. The long poll normally answers after its whole
          // hold, but a host that answers instantly — or one that keeps handing
          // back a `seq` we already have — must not turn this into a spin.
          const spent = Date.now() - askedAt;
          if (!stopped && spent < INTAKE_FLOOR_MS) await delay(INTAKE_FLOOR_MS - spent);
        }
      })();
      return stop;
    }

    /**
     * Invisible composer companion: owns the long poll for the session it is
     * mounted in and renders nothing. It lives in a slot because a slot's
     * `inject` is the supported way to learn *which* session is on screen.
     */
    function EditorPositionIntake(props) {
      // `insert` is memoised per session, so this effect runs once per mount
      // rather than on every render.
      React.useEffect(() => startIntake(props.insert), [props.insert]);
      return null;
    }

    /** A row label: which app, and which project. */
    function connectionLabel(connection) {
      const app = typeof connection?.peer?.appName === 'string' && connection.peer.appName !== '' ? connection.peer.appName : t('编辑器', 'Editor');
      const folders = Array.isArray(connection?.peer?.workspaceFolders) ? connection.peer.workspaceFolders : [];
      const name = folders.length > 0 && typeof folders[0] === 'string' ? basename(folders[0]) : '';
      return name === '' ? app : `${app} · ${name}`;
    }

    /** A row's second line: whether it is usable, and which process it is. */
    function connectionDetail(connection) {
      const state = connection?.state;
      const label =
        state === 'ready' ? t('已连接', 'connected') : state === 'refused' ? t('已拒绝', 'refused') : t('重试中', 'retrying');
      const pid = connection?.peer?.pid;
      return Number.isInteger(pid) ? `${label} · pid ${String(pid)}` : label;
    }

    /**
     * `/editors`: the windows this plugin is talking to.
     *
     * A list rather than a status dump, because the question behind it is "which
     * Cursor am I pointing at", and with two windows open that has no single
     * answer. Picking a row inserts *that* window's current position into the
     * draft — the DSH-side equivalent of going back to the editor and clicking.
     *
     * Named `editors` and not `status`: `status` describes a whole process, and
     * this describes one thing. A keyword nobody can guess is its own failure.
     * @param ctx - client root context.
     */
    function registerEditorsCommand(ctx) {
      if (typeof ctx.inject !== 'function') return;
      ctx.inject(['commandUi'], (scoped) => {
        scoped.effect(
          () =>
            scoped.commandUi.register({
              name: 'editors',
              label: () => t('编辑器窗口', 'Editor windows'),
              description: () =>
                t('查看已连接的编辑器，并把它的当前位置放进对话', 'Connected editors — insert one\u2019s position'),
              available: () => true,
              ui: {
                kind: 'popupSelect',
                searchMode: 'substring',
                searchLabels: () => ({
                  placeholder: t('搜索编辑器', 'Search editors'),
                  empty: t('没有已连接的编辑器', 'No editor is connected'),
                  noResults: t('没有匹配的编辑器', 'No matching editor'),
                }),
                options: async (session, signal) => {
                  const response = await fetch(EDITORS_ENDPOINT, {
                    signal,
                    cache: 'no-store',
                    credentials: 'same-origin',
                  });
                  if (!response.ok) return [];
                  const body = await response.json();
                  const connections = Array.isArray(body?.connections) ? body.connections : [];
                  return (
                    connections
                      // A link with no `hello` yet has no identity and no window to
                      // read a position from; it is not a row the user can act on.
                      .filter((connection) => Number.isInteger(connection?.peer?.pid) && connection.peer.pid > 0)
                      .map((connection) => ({
                        id: String(connection.peer.pid),
                        label: connectionLabel(connection),
                        detail: connectionDetail(connection),
                      }))
                  );
                },
                onSelect: async (option, session) => {
                  const response = await fetch(`${ENDPOINT}?pid=${encodeURIComponent(option.id)}`, {
                    cache: 'no-store',
                    credentials: 'same-origin',
                  });
                  if (!response.ok) return;
                  insertFor(ctx, session.sessionId)(await response.json());
                },
              },
            }),
          'editor-context-client: /editors command',
        );
      });
    }

    /**
     * Mount the browser half.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.uiConversation.userText.register(editorPositionRule);
      ctx.slots.inject('conversation.user.text.node', function* registerNode() {
        yield ctx.slots.register(
          { name: 'conversation.user.text.node', key: RULE_ID, priority: 100 },
          EditorPositionChip,
        );
      });
      ctx.effect(() => ctx.inputTriggers.registerSource(positionSource), 'editor-context-client: @ source');
      registerEditorsCommand(ctx);
      // Sorted late: this is an intake, not a control the user reads.
      ctx.slots.inject('conversation.input.dock', function* registerIntake() {
        yield ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'editor-position-intake',
            order: 90,
            inject: (sessionId) => ({ insert: insertFor(ctx, sessionId) }),
          },
          EditorPositionIntake,
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
