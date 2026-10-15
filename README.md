# dsh-editor-context

> **[English](README.md) · [中文](README.zh.md)**

Turn the lines you are looking at in Cursor / VS Code into a chip in the DSH composer.

Type `@` in the composer and an **editor position** group appears; pick one and a chip lands in your draft. Send it, and the model receives the full address and range:

```
@/data/project/work/qihuan/src/fancygame/hallsrv/internal/logic/logic_purchase/limit.go#L146-L154
```

**It is text you typed, not a message the plugin pushed into the conversation.** That distinction is the point of this version. A pushed message has to be told apart from what you actually said — by numbering it, by wording it as a pointer rather than a sentence. A chip is simply a word in your sentence: it can sit mid-clause, be edited, be deleted, never be sent.

The editor side is [`vscode-editor-context`](https://github.com/pandarayc/vscode-editor-context): the extension publishes the current position to a state file, and this plugin is the DSH-side reader.

---

## Why not automatic injection

The first version used a hook. The conclusion was that **it necessarily degenerates into pollution when the cursor moves often**:

- the hook fires **when you send a message**, not when the cursor moves (measured: one `UserPromptSubmit` call per turn),
- but the dedup key was the exact position, and a moving cursor changes it nearly every turn, so **dedup never fired**,
- so **every turn appended one durable user message** to the conversation.

In one line: **a high-cardinality dedup key is no dedup at all.**

The second version switched to explicit push (`/ide` inserting a numbered marker). That fixed pollution but not semantics: the marker was still "someone else speaking for you", and three insertions had to be told apart by `#1 #2 #3`.

This third version makes the reference **text you type**. No numbering is needed, because the position is already part of the sentence.

## Every channel, compared

| Mechanism | Triggered by | Line numbers | Lands as | Pollution |
|---|---|---|---|---|
| hook `additionalContext` | platform, every turn | text | durable user message | every turn / every change |
| **`@` → editor position** (default, this plugin) | you, explicitly | structured | **a chip in your own message** | none |
| `/ide` numbered marker (opt-in, `mode: on-demand`) | you, explicitly | text | durable context card | low |
| `@path 第 A-B 行` (typed by hand) | you, explicitly | plain text | your message | none |
| MCP `open_at_range` (**not built**) | model / user | — | UI action | none |

## Install

```bash
dsh plugin --profile web add /path/to/dsh-editor-context
# then restart dsh-web
```

Requires `vscode-editor-context` running in the editor (it publishes `~/.editor-context/windows/*.json`).

This is a **dual-face package**: the host half runs in the DSH process, and the browser half is handed to the page by DSH's client module system through the `dsh.client` declaration. One package, two faces.

## Usage

Type `@` in the composer and pick **editor position**. The inserted text is:

```
@<absolute path>#L146        caret on line 146
@<absolute path>#L146-L154   lines 146-154 selected
```

Model-side behaviour is guaranteed by a system-prompt section (`order: 910`, immediately after DSH's own `@` file-reference guidance):

> An editor-position token has the form `@<path>#L12` or `@<path>#L12-L34`: the path is everything before `#L` … Read that path (never the whole token) when the contents matter.

**Why `#L`**: DSH's shipped file rule treats everything after `@` up to whitespace as a path, so `@path:12-34` would have the colon swallowed into the path, leaving two rules claiming the same span. `#` is not part of that grammar, so this token's ownership is unambiguous — and `#L` is the line-address spelling models already know from code forges.

**Why an absolute path**: `relativePath` in the state file is relative to the **editor's** workspace root, which is generally not the agent's working directory, so `read` cannot open it.

## Configuration

```yaml
- id: editor-context
  name: dsh-editor-context
  config:
    http: true                       # chip channel, on by default
    # httpPath: /editor-context/position
    mode: off                        # push channel, off by default
    # stateDir: "~/.editor-context"
    # maxAgeSeconds: 3600
    # commands: [ide, here]          # only used by mode: on-demand
```

### The two channels are independent

**Chip channel** (`http`, on by default) — mounts a read-only `GET /editor-context/position`, which the browser half offers as candidates. It writes nothing into the conversation.

> The route is **not additionally authenticated**: DSH's `webServer` matches registered routes before the SPA fallback that carries auth. It should therefore only listen on loopback, which is the default. It returns addresses, **never file contents**; a path rejected by `excludeGlobs` returns 404 rather than leaking the path it was meant to hide.

**Push channel** (`mode`, `off` by default) — `on-demand` registers the slash commands named in `commands`; `selection` adds one automatic marker per changed non-empty selection. What it pushes is a **numbered address marker**, not narration:

```
[编辑器位置 #2 · Cursor 插入标记]
绝对路径：/data/project/.../trigger_gift.go
工作区相对路径：hallsrv/internal/logic/logic_trigger_gift/trigger_gift.go
选中第 132-136 行（共 5 行）；需要内容时 read offset=132 limit=5。
```

The ordinal increments **within a conversation** and is persisted through a session projection, so it **survives a restart** — a process-local counter would restart at `#1`, which is exactly the ambiguity the numbering exists to remove. On the way in, `source.form` is `snapshot`, so the GUI renders it as a collapsed context card.

Auto-push only ever fires for a **non-empty selection**: a bare caret is not a deliberate act.

## Implementation notes

```
lib/http.js    host: the read-only position endpoint (pure, unit-tested)
lib/index.js   host: mounts the route, the grammar section, the optional push channel
lib/client.js  browser: the @ source, the UserText rule, the chip component
```

The browser half is **hand-written**, with no build step:

```js
window.__ModuleLoader__.load({ id: 'dsh-editor-context', factory: (require) => { … } });
```

Cross-package reach is always through cordis services (`ctx.inputTriggers` / `ctx.uiConversation` / `ctx.slots`), and `require('react')` is the only import — which is what every shipped client bundle does.

Three things that will bite, all found by running it:

1. **Insert via `{insert}`, not `{text}`.** They are not equivalent. `{text}` lands ordinary characters, which are only decorated if they match a name some source publishes through its `lexicon` — and the chip then reprints the whole name. `{insert}` creates a reference record carrying its own `label`, which is how the chip can read `limit.go:146-154` while the document text stays the full token.
2. **A reference source must carry a `codec`.** Before the sink, every chip is expanded through its owner's codec; without one, `serializeReference` **rejects the whole submission** rather than downgrading it.
3. **The node rule has to sort before the shipped `file` rule.** Rules are ordered by ascending `order` and the first wins a same-start tie; the shipped `file` rule is 30, so this one is 20.

The chip also holds up in **replayed history**: playback re-parses the original text through the `UserText` rule, with no reference node involved. Both paths produce a chip.

## Why zero dependencies

The plugin is installed via `link:`, so its real path is not inside the profile's `node_modules` and a bare `@deepseek-ai/*` import cannot resolve. The few constructors it needs are inlined (they were already three-line `deepFreeze(structuredClone({...}))` helpers).

Optional services are always taken with `ctx.inject([...], cb)` rather than `ctx.get()`: mount order is not ours to pick, the service may come up after this plugin, and `ctx.get()` would then read `undefined` and **degrade silently**. A missing service just means that feature is not registered — the plugin still mounts.

## Tests

```bash
npm test
# 45 passed
```

Three files: `test/editor-context.test.mjs` (push channel and config), `test/http.test.mjs` (the endpoint), `test/client.test.mjs` (which **loads the real bundle** behind a fake `window.__ModuleLoader__` and `require`, asserting on the bytes that would ship).

The client half catches what static checks cannot — a missing module wrapper (which would break in the browser too), a missing codec (which only surfaces on click).

## Known limitations

- A path containing spaces needs the quoted `@"a b.go"` form. The rule parses it; the candidate list does not yet produce it.
- Clicking a chip does not jump back to the editor: `vscode-editor-context` only writes files and has no inbound channel. Jumping would need one, and it is not built.
- `excludeGlobs` is configured on the **extension** side; the plugin has no separate exclusion rules.
