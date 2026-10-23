# dsh-editor-context

> **[English](README.md) · [中文](README.zh.md)**

Turn the lines you are looking at in Cursor / VS Code into a chip in the DSH
composer.

Type `@`, pick **editor position**, and a chip lands in your draft. Send it, and
the model receives the file and the range:

```
@/data/project/qihuan/hallsrv/internal/logic/logic_purchase/limit.go#L146-L154
```

That is the whole feature. The position reaches the conversation because you put
it in your own sentence — nothing is injected behind you — so there is no
numbering to disambiguate, no auto-injection to switch off, and nothing to
configure. A reference you typed needs none of that.

## What you need

- DSH, running the web profile (`dsh web`)
- The editor half: **Editor Context**, `pandarayc.editor-context-bridge` on the
  [Marketplace](https://marketplace.visualstudio.com/items?itemName=pandarayc.editor-context-bridge),
  0.5.0 or newer. It publishes `~/.editor-context/windows/*.json` and announces
  the WebSocket this plugin dials in `~/.editor-context/endpoints/`.

## Install

```bash
dsh plugin --profile web add github:pandarayc/dsh-editor-context
# or a local checkout:
dsh plugin --profile web add /path/to/dsh-editor-context
# then restart dsh-web — plugins load at process start
```

The package is not on npm yet, so `dsh plugin --profile web add dsh-editor-context`
does not resolve; use the repository form above until it does.

## Use

In the composer, type `@`. An **editor position** group appears with one row —
where you are right now:

```
@
├─ editor position
│    limit.go:146-154        hallsrv/internal/logic/…/limit.go
└─ reference
     src/…  tests/…  …
```

Picking it puts a chip in your draft as a word in your sentence. Type around it,
edit it, delete it, never send it: it is ordinary draft text, and it stays a chip
in replayed history too.

The chip is short (`limit.go:146-154`), but the model receives the full token.
The send path expands every reference through its owner's codec before it goes
out, so the model sees an address it can open, not a label.

| You insert | The model receives |
|---|---|
| `@<absolute path>#L146` | the caret is on line 146 |
| `@<absolute path>#L146-L154` | lines 146-154 are selected |

**The absolute path is what the model gets**, because `relativePath` in the state
file is relative to the *editor's* workspace root, which is generally not the
agent's working directory — `read` could not open it.

**Why `#L`.** DSH's shipped file rule treats everything after `@` up to
whitespace as a path, so `@path:12-34` would have the colon swallowed into the
path and two rules claiming the same span. `#` is outside that grammar, so this
token's ownership is unambiguous — and `#L` is the line-address spelling models
already know from web forges.

## From the editor, without switching windows

The same position can be sent from Cursor / VS Code instead of typed here:
**Add to Bot** on the editor title bar. The chip appears in your draft the moment
you click, so you can point at three places in a row and then ask one question
about all three.

```
Cursor: Add to Bot on limit.go:146-154
   ↓  the extension pushes a delivery frame over its WebSocket
   ↓  this plugin is dialled in and receives it in the same tick
   ↓  your open tab holds a parked long poll; it wakes and inserts
DSH composer: [limit.go:146-154]  ← in your draft, unsent
```

The extension runs the WebSocket **server** and this plugin is the **client**.
That direction is not arbitrary: Node ships a WebSocket client and no server, so
the half that needs a library is the one living in a VSIX — which is why this
plugin still has no dependencies at all.

One extension window is one server, and a port only one process can hold, so the
extension announces where each window actually ended up in
`~/.editor-context/endpoints/<pid>.json`. The plugin reads that directory and
keeps **one link per window** — a second window, a restarted extension or a
changed port all look the same from here: the next scan sees a different
directory than the last one. `wsUrl` is still dialled when the registry is empty,
which is what a pre-0.5 extension looks like.

Neither hop is an interval. The editor pushes; the plugin's long poll parks until
there is something to hand the browser. An idle conversation is one open socket
and one parked response, not a request per second.

The delivery carries the **text** as well as the address and the range. A delivery
is a snapshot, not a pointer: a pointer goes stale the moment the file is edited,
moved or reverted, and the agent is then reasoning about code that no longer
exists.

## Configuration

```yaml
- id: editor-context
  name: dsh-editor-context
  config:
    # wsUrl: "ws://127.0.0.1:7788/editor-context"   # the editor extension's publisher
    # wsToken: ""                    # required if that side set editorContext.ws.token
    # wsName: dsh                    # this subscriber's identity, and its send target
    # wsLabel: DSH                   # how the editor's recipient picker names it
    # includeText: true              # ask for the selected text, not only the address
    # autoSelection: false           # also receive every changed selection
    # stateDir: "~/.editor-context"  # where the extension writes window state
    # logFile: ""                    # defaults to <stateDir>/plugin.log
    # maxAgeSeconds: 3600
    # http: false                    # disable the browser routes entirely
    # httpPath: /editor-context/position
```

`wsUrl` is the **fallback**, not the address: with extension 0.5.0 or newer the
real endpoint comes from the registry, and this is only dialled when the registry
is empty. If the extension sets a token, this side needs the same string or the
publisher refuses the subscription — and a refusal is terminal, reported once,
because a wrong secret is still wrong thirty seconds later.

The plugin mounts a read-only `GET /editor-context/position` on DSH's web server,
which the browser half reads. It returns an address and a line range — never file
contents. A path the extension's `excludeGlobs` rejected answers 404, so the
exclusion rule does not leak the path it is hiding.

### `/editors`

Typing `/editors` in a conversation opens a picker of the **editor windows this
plugin is talking to** — app name, project folder, state and pid. Picking one
inserts *that* window's current position into the draft, which is the DSH-side
equivalent of going back to the editor and pressing Add to Bot.

It is a picker rather than a status dump because the question behind it is
"which Cursor am I pointing at", and with two windows open that has no single
answer. It is named `editors` and not `status`: `status` describes a whole
process, and a keyword nobody can guess is a failure of its own.

The same data is on `GET /editor-context/editors`, one entry per link with its
state (`absent`, `connecting`, `ready`, `refused`), dial count, and the `hello`
the window sent. It says nothing about files, and it exists because the
interesting failure is silence: a plugin with no socket looks exactly like a user
who has not pressed anything.

That route is matched before DSH's SPA fallback and is therefore **not
additionally authenticated**. It is meant for loopback, which is the default;
`http: false` removes it.

## Troubleshooting

| Symptom | What to check |
|---|---|
| `@` shows no **editor position** row | `cat ~/.editor-context/windows/*.json` — no file means the extension is not installed or not activated |
| …the row is there but stale | the position is older than `maxAgeSeconds`; move the caret in the editor |
| …the row is missing only in some files | the path matches `editorContext.excludeGlobs` on the extension side. That is by design: not even the path is published |
| nothing happens at all | `/editors` in a conversation, or `curl -s http://127.0.0.1:3080/editor-context/editors` — no rows means no editor is linked; a `refused` state names why |
| …`/editors` is missing from the menu | the plugin did not mount, or `http: false`; `~/.editor-context/plugin.log` says which |

## Limitations

- **A path containing spaces needs the quoted form**, `@"a b.go"#L12`. The rule
  parses it; the candidate list does not yet produce it.
- **Clicking a chip does not jump back to the editor.** The extension only writes
  files and has no inbound channel.
- **Exclusion is configured on the extension side**, not here. The plugin has no
  rules of its own, and none are needed: it can only offer what the extension
  chose to publish.

## Layout

```
lib/state.js       the position document: one schema, one parser
lib/registry.js    host: which editor windows are announcing an endpoint, and where
lib/link.js        host: one subscriber per window, reconciled against the registry
lib/subscribe.js   host: the WebSocket client that dials one editor window
lib/deliveries.js  host: the queue between that socket and the browser
lib/http.js        host: the three read-only routes, pure and unit-tested
lib/index.js       host: mounts the routes and the token-grammar prompt section
lib/client.js      browser: the @ source, the UserText rule, the chip component,
                   and the intake that inserts what the editor sends
```

This is a **dual-face package**: the host half runs in the DSH process, the
browser half is handed to the page by DSH's client module system through the
`dsh.client` declaration. The browser half is hand-written with no build step and
imports only `react`; cross-package reach is always through cordis services
(`ctx.inputTriggers` / `ctx.uiConversation` / `ctx.slots`).

```bash
npm test    # 82 passed
```

Seven files: `test/editor-context.test.mjs` (the reader, the config, and what
`apply` registers), `test/http.test.mjs` (all three routes and the browser
payload), `test/deliveries.test.mjs` (the queue), `test/subscribe.test.mjs` (the
socket client, against a socket double), `test/registry.test.mjs` and
`test/link.test.mjs` (discovery and membership), and `test/client.test.mjs`, which loads the
**real** bundle behind a fake `window.__ModuleLoader__` and asserts on the bytes
that ship.

For why this plugin cannot put anything into a conversation, what it used to do
instead, and the three sharp edges in the client half:
[docs/internals.md](docs/internals.md).

## License

MIT
