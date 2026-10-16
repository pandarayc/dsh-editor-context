# Internals

Engineering notes for `dsh-editor-context`. The user-facing story is in the
[README](../README.md); the long-form design record is
[composer-chip-design.md](composer-chip-design.md) (Chinese).

## The invariant: nothing enters a conversation from here

This plugin can mount a read-only HTTP route and add a system-prompt section. It
cannot add, prepend or schedule a message. That is not a limitation of the current
design — it is the design, and `test/editor-context.test.mjs` asserts it: after
`apply`, no slash command, no `agent/pre-step` listener and no session projection
has been registered.

Getting there took three versions, and the middle ones are worth recording
because each looked reasonable at the time.

### 1. A `UserPromptSubmit` hook

The hook fires **when the user sends a message**, not when the cursor moves. That
is the natural reading of the data, and it is what makes the mechanism fail:

- the dedup key was the exact position (`file|sel|11-14`);
- a cursor that moves often changes that key nearly every turn;
- a high-cardinality dedup key is no dedup at all;
- so **every turn appended one durable user message** to the conversation.

### 2. Explicit push (`/ide`, `mode`)

Switching to an explicit command fixed the pollution — nothing was injected until
asked — but not the semantics. The marker was still "someone else speaking for
you", it landed as a message the user did not write, and three insertions in one
conversation had to be told apart by an ordinal:

```
[编辑器位置 #2 · Cursor 插入标记]
绝对路径：/data/project/…/trigger_gift.go
```

The ordinal had to be durable (a session projection, so it survived a restart) —
a process-local counter restarting at `#1` is exactly the ambiguity the numbering
exists to remove. `mode: 'selection'` then re-introduced the original problem from
the other side, watching the editor and pushing one marker per changed selection.

Version 0.4.0 deleted all of it. It had been unreachable by default anyway:
`mode` defaulted to `off` and `commands` defaulted to `[]`.

### 3. A chip (current)

The reference became **text the user types**. No ordinal is needed, because the
position is already part of the sentence; no switch is needed, because nothing is
automatic; and no `form`/`sections` bookkeeping is needed, because the message is
not a context card — it is the user's own message.

| Mechanism | Triggered by | Lands as | Pollution |
|---|---|---|---|
| hook `additionalContext` | platform, every turn | durable user message | every turn / every change |
| `/ide` numbered marker | user, explicitly | durable context card | low, but needs ordinals |
| **`@` → editor position** | **user, explicitly** | **a chip in their own message** | **none** |
| `@path 第 A-B 行` typed by hand | user, explicitly | their message | none |
| MCP `open_at_range` (not built) | model / user | UI action | none |

## The three sharp edges in the browser half

All three were found by running it, and all three are asserted in
`test/client.test.mjs` against the real bundle bytes.

1. **Insert via `{insert}`, not `{text}`.** They are not equivalent. `{text}`
   lands ordinary characters, which are only decorated if they match a name some
   source publishes through its `lexicon` — and the chip then reprints the whole
   name. `{insert}` creates a reference record carrying its own `label`, which is
   how the chip can read `limit.go:146-154` while the document text stays the full
   token.
2. **A reference source must carry a `codec`.** Before the sink, every chip is
   expanded through its owner's codec. Without one, `serializeReference`
   **rejects the whole submission** rather than downgrading it to the clipboard
   text — so a missing codec is a send button that does nothing, not a cosmetic
   bug.
3. **The `UserText` rule has to sort before the shipped `file` rule.** Rules are
   ordered by ascending `order` and the first wins a same-start tie; the shipped
   `file` rule is 30, so this one is 20. Without that, `@path#L12-34` is claimed
   by the built-in rule and read as a file literally named `path#L12-34`.

A fourth, in the host half: the system-prompt section at order 910 sits
immediately after DSH's own `FILE_REFERENCE` section (900). The token is still a
`@`-path token, and the shipped guidance says "anything else is a file", so
without an explicit note the model can read the `#L` suffix as part of the path
and fail to open it.

## Why zero dependencies, and why `ctx.inject`

The plugin is installed with `link:`, so its real path is not inside the profile's
`node_modules` and a bare `@deepseek-ai/*` import cannot resolve. The helpers it
would have imported (`createMessage`, `freezeMessage`) are three lines each, so
they were inlined — until 0.4.0 removed the only code that used them.

Optional services are always taken with `ctx.inject([...], cb)` rather than
`ctx.get()`. Mount order is not ours to pick: the service may come up after this
plugin, and `ctx.get()` at apply time would read `undefined` and **degrade
silently**. A service that never appears just means that one feature is not
registered — the plugin still mounts, and `inject` is empty.

## The intake: two hops, neither an interval

A click in Cursor has to end up in a composer draft in the browser. That is two
process boundaries, and each one uses the transport it can actually have.

**Editor → host: a socket, dialled out.** The extension runs the WebSocket
*server*; this plugin is the *client*. That direction is forced by what Node
ships: a WebSocket client and no server. So the dependency lands in the VSIX,
where dependencies are ordinary, and this plugin stays at zero. It also happens
to be the direction every editor integration converged on — Claude Code's
extension is a server too.

**Host → browser: a parked response.** The browser half is a cordis plugin with
no server of its own, so it cannot be dialled. It asks with
`GET /editor-context/next?since=<seq>` and the host holds the response until the
socket has something to hand over, then answers `204` ("ask again") if the hold
expires. A sequence number lets the client advance a monotonic cursor, so a
replayed reply cannot become a second chip.

The counter-argument to a fixed interval is worth stating plainly: one request per
second per open tab is 86,400 a day to deliver, typically, nothing. Here an idle
conversation is one open socket and one parked response.

### What the socket replaced

Until 0.6.0 the editor wrote a file per click into `~/.editor-context/requests/`
and the host watched that directory. That worked, and it carried a surprising
amount of machinery: `fs.watch` plus a settle timer for the burst an atomic
rename produces, a directory scan with a "considered names" set, pruning, a
sequence derived from mtimes, and an age check — all of it to discover something
the editor already knew and could simply have said. The socket deleted the file,
the watcher and the scan together. `lib/deliveries.js` is now only a queue.

The file mailbox still exists, and the hook face still reads it: a hook script
runs only when a prompt is sent, so it has nowhere to hold a socket open. That is
the difference between a consumer that can be dialled and one that cannot.

### Why the text travels

A delivery carries `text` next to `address` and `selection`, and that is not
convenience. A pointer goes stale the moment the file is edited, moved, reverted
or deleted, and the reader is then reasoning about code that no longer exists —
while `at` and `selection` say where it was, so the two can be compared later. A
snapshot cannot dangle.

### The floor between asks

`startIntake` leaves a minimum gap between long-poll iterations whatever the host
answered. The normal timeout takes its whole hold, so the floor is invisible — but
a host that answers instantly, or that keeps returning a `seq` the client has
already consumed, would otherwise turn the loop into a spin. This was found by a
test hanging, not by reading the code.

### What the client depends on

`addFiles` is reached as `ctx.sessions.scope(sessionId)` →
`ctx.get('conversation').input.for(actx)` → `shell.addFiles(references, [])`. Two
things about that are worth knowing:

- It is the **shipped** path: drag-and-dropping a file onto the composer builds the
  identical reference record and calls the same method. `insertReference`, by
  contrast, needs a pick-time span and a draft-revision match, so it cannot serve a
  click that originated in another application.
- It is **internal** — no `types` contract documents `SessionInputShell.addFiles`.
  That puts it in the same risk class as `inputTriggers.registerSource` and
  `uiConversation.userText`, both of which this plugin already depends on. The
  session id itself comes from a slot's `inject(sessionId)`, which is the supported
  way to learn which conversation is on screen.
