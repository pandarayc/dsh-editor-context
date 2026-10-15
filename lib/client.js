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
    const inject = ['inputTriggers', 'uiConversation', 'slots'];

    /** Same-origin route registered by the host half. */
    const ENDPOINT = '/editor-context/position';
    /** Business id of the text node this plugin owns; `text` is reserved. */
    const RULE_ID = 'editorPosition';
    /** Menu group title. */
    const SECTION = '编辑器位置';

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
      name: 'editor-position',
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
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
