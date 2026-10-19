# Changelog

## 0.7.1 — 2026-10-19

The registry scan adapts, and reacts.

- **Changed** — the scan interval is no longer a constant. While any link is not
  ready it runs every 5s (that is when a scan can find a window); once every link
  is ready it drops to 60s (the only thing left to find is a new window). Fewer
  wakeups, and faster in the case that matters — the old fixed 15s was slower
  than needed when broken and noisier than needed when fine.
- **Added** — a link that leaves `ready` schedules a scan within a second, so a
  closed window is dropped at once instead of being retried until the next tick.
- **Added** — `scanInterval()` is exported and tested on its own: the policy is
  four lines and does not need a minute-long timer to verify.

## 0.7.0 — 2026-10-19

One link per editor window, found through the registry the extension now writes.

- **Added** — `lib/registry.js`: reads `<stateDir>/endpoints/`, and keeps an
  announcement only when its pid is alive **and** its heartbeat is recent. A
  file this plugin cannot parse, or that names a non-loopback URL, is skipped —
  a writable file in `$HOME` must not be able to point the socket anywhere.
- **Added** — `lib/link.js`: membership, not the wire. Each scan reconciles the
  live links against the registry, so a window that closes, a window that opens
  on another port, and a window that restarts are one event each — and a missed
  event costs a rescan, not a dead feature. The configured `wsUrl` is still
  dialled when the registry is empty, so a pre-0.5 extension keeps working.
- **Added** — `GET /editor-context/status`: which windows are connected, what
  each one said in its `hello`, and whether any of them acknowledged. Silence was
  the hard failure to diagnose; this is the one place outside the log where it is
  visible.
- **Changed** — `createSubscriber` now keeps the `hello` (`peer`), reports a
  `state` (`absent` / `connecting` / `ready` / `refused`), and treats a refused
  token or an unknown protocol as **terminal**: retrying cannot fix either, and
  the retries were hiding the one thing the user has to change.
- **Changed** — a watchdog closes a subscribed socket that has been silent for
  90s. The extension pings every 30s, so silence means a half-open link that will
  never correct itself — it would otherwise sit there looking connected.

## 0.6.0 — 2026-10-17

The editor pushes over a socket; the watcher, the scan and the long-poll cursor's
job all shrink to one queue.

- **Added** — `lib/subscribe.js`: a WebSocket client that dials the editor
  extension's publisher, presents a token when one is wanted, and hands every
  `delivery` frame to the queue. Still **zero dependencies** — Node ships a
  WebSocket client and no server, which is exactly why the extension is the
  server and this is the client.
- **Removed** — `lib/requests.js` and with it `fs.watch`, the directory scan, the
  settle timer, and the mtime-derived sequence. The delivery queue is now fed by
  the socket (`lib/deliveries.js`), which is a push and needs no discovery.
- **Changed** — the long poll still exists, because the browser half has no server
  of its own, but it no longer polls anything: the host holds the request until
  the socket pushes. One hop is a socket, the other is a parked response, and
  neither is an interval.
- **Changed** — the browser payload carries `text` and `textTruncated` alongside
  the address and the range. A delivery is a snapshot: the file may have moved on
  by the time the user sends, and the original code is the part worth keeping.
- **Added** — config: `wsUrl` (default `ws://127.0.0.1:7788/editor-context`),
  `wsToken`, `wsName`, `wsLabel`, `includeText`, `autoSelection`.


## 0.5.0 — 2026-10-16

The editor can point at something, and it lands in the draft.

- **Added** — `GET /editor-context/next`, a long poll that delivers positions the
  user clicked in the editor (the extension's *Send Current Position to Agent*).
  The chip goes into the composer draft, so it is editable, deletable and unsent
  until the user sends it — `Add to Chat` semantics, not a message pushed into the
  conversation.
- **Added** — `lib/requests.js`: a queue fed by `fs.watch` on the editor's
  `requests/` directory. When nobody is clicking, a parked inotify descriptor is
  the entire cost; there is no timer anywhere, and the browser's long poll parks
  rather than asking on an interval.
- **Added** — `lib/state.js`, the single schema reader. `windows/` and `requests/`
  hold the same document, so there is one parser rather than two and the two
  producers cannot drift.
- **Changed** — the browser half resolves the session's composer through
  `sessions.scope` → `conversation.input.for(actx)` → `addFiles`, the same chain
  the shipped drag-and-drop path uses. `addFiles` inserts at the live selection and
  needs no pick-time span, which a click in another application cannot provide.
- **Fixed** — the long-poll loop has a floor between asks. A host that answers
  instantly, or replays a `seq` the client already consumed, would otherwise spin
  at full speed; a test covers exactly that reply sequence.

## 0.4.0 — 2026-10-16

One channel: the chip. The rest of the plugin was machinery for putting things
into a conversation the user did not type, and it is gone.

- **Removed** — the push channel: `mode`, `commands`, the `/ide` slash command,
  the numbered insertion marker, and with it the durable ordinal. The session
  projection, the `agent/pre-step` listener and the frozen-message constructor
  go too. `mode: 'off'` had been the default and `commands` defaulted to `[]`,
  so this whole path was already unreachable without hand-written config.
- **Removed** — `renderMarker`, `buildMessages`, `contextMessage`,
  `describePosition`, `SOURCE_KIND` and `COUNTER_KEY` from the module's exports.
- **Changed** — nothing in this plugin can now add a message to a session. What
  `apply` registers is a read-only route and one system-prompt section; a test
  asserts that no slash command, listener or projection is registered.
- **Changed** — `inject` is empty. Neither service the plugin uses is required
  for it to mount.

## 0.3.0 — 2026-10-15

The editor position becomes text you type.

- **Added** — an `@` menu source offering the current position, and a `UserText`
  rule that renders `@<path>#L12-L34` as a chip in both the composer and
  replayed history. Picking a candidate inserts a reference record, so the chip
  reads `limit.go:146-154` while the model receives the full token.
- **Added** — `GET /editor-context/position`, a read-only endpoint returning an
  address (never file contents), plus the hand-written browser half that
  consumes it. No build step; `require('react')` is the only import.
- **Added** — a system-prompt section at order 910 stating that the path is
  everything before `#L`, so the model does not read the suffix as part of it.
- **Added** — a `codec` on the reference source. Without it the send path
  rejects the whole submission rather than downgrading it.
- **Changed** — the push channel is opt-in. `mode` defaults to `off` and no
  slash command is registered unless the config names one. `mode: off` now means
  "no push channel", not "mount nothing", because the chip channel is
  independent of it.
- **Known** — the rule sorts at `order: 20`, ahead of the shipped file rule at
  30, so a `#L` token wins a same-start tie.

## 0.2.0 — 2026-10-15

- **Changed** — the injected text is a numbered address marker
  (`[编辑器位置 #2 · Cursor 插入标记]`) instead of a third-person sentence. The
  ordinal is durable through a session projection, so it survives a restart; a
  process-local counter would restart at `#1`, which is the ambiguity the
  numbering exists to remove.
- **Changed** — the marker leads with the absolute path, because the editor's
  workspace-relative path is generally not the agent's working directory and
  `read` cannot open it.
- **Removed** — the narration form ("the user is currently looking at …"), which
  read like the user's own words once it sat next to them.

## 0.1.0 — 2026-10-15

- First version: `/ide` inserts the current position as a context message;
  `selection` mode injects one automatically on a changed non-empty selection.
