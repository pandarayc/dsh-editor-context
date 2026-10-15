# Changelog

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
