/**
 * dsh-editor-context — bring "the lines I am looking at" into a DSH conversation.
 *
 * The editor extension (`editor-context`) publishes one JSON file per editor
 * window under `~/.editor-context/windows/`. This plugin is the DSH-side reader.
 *
 * What it injects is a *marker*, not a statement. A message that narrates
 * "the user is currently looking at ..." blends into whatever the human types
 * next, and three such messages in one conversation are indistinguishable from
 * each other. So every insertion is:
 *
 *   - numbered (`#1`, `#2`, ...), per conversation, durably;
 *   - terse — an address (absolute path + line range), not prose;
 *   - carried by a `source.form === 'snapshot'` context message, which the GUI
 *     renders as a collapsed context row rather than as something the human said.
 *
 * It deliberately does NOT inject anything by itself unless you ask for it:
 *
 *   mode: 'on-demand'  (default) only the slash command `/ide` injects.
 *   mode: 'selection'           `/ide` plus one marker per changed *selection*.
 *   mode: 'off'                 registers nothing.
 *
 * Why on-demand is the default: a hook that injects on every position change
 * degenerates into "one durable user message per turn" once the cursor moves
 * often (a high-cardinality dedup key is no dedup at all). An explicit command
 * keeps the history clean and the position fresh at the moment you ask.
 *
 * Zero runtime dependencies on purpose: a `link:`-installed plugin resolves
 * bare `@deepseek-ai/*` imports against its own real path, which is not inside
 * the profile's node_modules. The helpers we need from the harness
 * (`createMessage`, `freezeMessage`) are three lines each, so they are inlined.
 *
 * @module dsh-editor-context
 */

import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { DEFAULT_HTTP_PATH, createPositionRoute } from './http.js';

export const name = 'editor-context';

/** The slash-command registry is the only service we strictly need. */
export const inject = ['commands'];

/** Durable `source.kind` of every message this plugin produces. */
export const SOURCE_KIND = 'editor-context';

/**
 * Session-projection key holding this conversation's insertion counter.
 * A projection rather than process memory, because the numbering has to survive
 * a restart: two markers numbered `#1` in one conversation is the exact
 * ambiguity the numbering exists to remove.
 */
export const COUNTER_KEY = 'editorContext';

/**
 * The GUI dispatches on `source.form` over a closed set
 * (`instructions` | `catalog` | `snapshot` | `notice` | `relay` | `recall`).
 * `snapshot` is the honest one here — a position reading is a point-in-time
 * snapshot that a later reading supersedes, and it is the only form whose body
 * renders named sections.
 */
const FORM = 'snapshot';

const MODES = new Set(['on-demand', 'selection', 'off']);
/**
 * No slash command is registered unless the config asks for one. The push model
 * was the first implementation of this feature; the composer chip replaced it,
 * because a marker pushed into the conversation is a message the user did not
 * write and has to be told apart from one they did.
 */
const DEFAULT_COMMANDS = [];
const DEFAULT_MAX_AGE_SECONDS = 3600;

/** Expand a leading `~` and resolve the published-state directory. */
export function resolveStateDir(configured) {
  const value = typeof configured === 'string' ? configured.trim() : '';
  if (value === '') return join(homedir(), '.editor-context');
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2));
  return resolve(value);
}

/**
 * Read the newest published position, or `undefined` when there is none.
 * @param {string} stateDir - directory holding `windows/<pid>.json`.
 * @param {number} maxAgeMs - ignore files older than this; negative disables the check.
 * @returns {Promise<undefined | {sig: string, context: string, relativePath: string, activeFile: string, appName: string, selection: null | {startLine: number, endLine: number, isEmpty: boolean}, updatedAt: string}>}
 */
export async function readPosition(stateDir, maxAgeMs) {
  const dir = join(stateDir, 'windows');
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  let newest;
  let newestMtime = -1;
  for (const entry of names) {
    if (!entry.endsWith('.json')) continue;
    const candidate = join(dir, entry);
    try {
      const info = await stat(candidate);
      if (info.mtimeMs > newestMtime) {
        newestMtime = info.mtimeMs;
        newest = candidate;
      }
    } catch {
      // A window that vanished mid-scan is simply not a candidate.
    }
  }
  if (newest === undefined) return undefined;
  if (maxAgeMs >= 0 && Date.now() - newestMtime > maxAgeMs) return undefined;
  try {
    const state = JSON.parse(await readFile(newest, 'utf8'));
    if (typeof state !== 'object' || state === null) return undefined;
    return {
      sig: typeof state.sig === 'string' ? state.sig : '',
      // The extension writes `context: ''` for a path its exclude globs reject.
      // That empty string is the only "do not publish" signal on the wire, so it
      // doubles as the exclusion flag here.
      context: typeof state.context === 'string' ? state.context.trim() : '',
      relativePath: typeof state.relativePath === 'string' ? state.relativePath : '',
      activeFile: typeof state.activeFile === 'string' ? state.activeFile : '',
      appName: typeof state.appName === 'string' ? state.appName : '编辑器',
      selection: state.selection ?? null,
      updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : '',
    };
  } catch {
    return undefined;
  }
}

/** One-line human summary of a position, for the command's own output. */
export function describePosition(position) {
  const path = position.relativePath || position.activeFile || '(未命名文件)';
  const selection = position.selection;
  if (selection === null || selection === undefined) return path;
  if (selection.isEmpty) return `${path} 第 ${selection.startLine} 行`;
  const span = selection.endLine - selection.startLine + 1;
  return `${path} 第 ${selection.startLine}-${selection.endLine} 行（共 ${span} 行）`;
}

/**
 * Render the model-facing insertion marker, or `''` when there is no file to
 * point at.
 *
 * The marker leads with the *absolute* path on purpose: `relativePath` is
 * relative to the editor's workspace root, which the agent's working directory
 * generally is not, so a bare relative path is not something `read` can open.
 *
 * @param position - a reading from {@link readPosition}.
 * @param ordinal - this insertion's 1-based number within the conversation.
 * @returns the marker text, newline separated.
 */
export function renderMarker(position, ordinal) {
  const absolute = position.activeFile !== '' ? position.activeFile : position.relativePath;
  if (absolute === '') return '';
  const lines = [`[编辑器位置 #${ordinal} · ${position.appName} 插入标记]`, `绝对路径：${absolute}`];
  if (position.relativePath !== '' && position.relativePath !== absolute) {
    lines.push(`工作区相对路径：${position.relativePath}`);
  }
  const selection = position.selection;
  if (selection === null || selection === undefined) {
    lines.push('没有选区，也没有定位到具体行。');
    return lines.join('\n');
  }
  if (selection.isEmpty) {
    lines.push(`光标停在第 ${selection.startLine} 行。`);
    return lines.join('\n');
  }
  const span = selection.endLine - selection.startLine + 1;
  lines.push(
    `选中第 ${selection.startLine}-${selection.endLine} 行（共 ${span} 行）；` +
      `需要内容时 read offset=${selection.startLine} limit=${span}。`,
  );
  return lines.join('\n');
}

/** Deep-freeze a freshly cloned message, mirroring the harness's own constructor. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * Build one immutable context message without importing the harness.
 * @param content - model-facing blocks.
 * @param sections - GUI sections, `{name, text}`, matching the content's grouping.
 * @returns a frozen `user`-role message attributed to this plugin.
 */
export function contextMessage(content, sections) {
  return deepFreeze(
    structuredClone({
      role: 'user',
      content,
      source: { kind: SOURCE_KIND, form: FORM, sections },
      id: randomUUID(),
    }),
  );
}

/**
 * The context message for one insertion, or `undefined` when the reading
 * carries no address at all.
 * @param position - a reading from {@link readPosition}.
 * @param ask - text the user typed after the command, if any.
 * @param ordinal - this insertion's 1-based number within the conversation.
 * @returns a frozen context message.
 */
export function buildMessages(position, ask, ordinal) {
  const marker = renderMarker(position, ordinal);
  if (marker === '') return undefined;
  const question = typeof ask === 'string' ? ask.trim() : '';
  const sections = [{ name: '编辑器位置', text: marker }];
  if (question !== '') sections.push({ name: '随插入一起提出的问题', text: question });
  const text = question === '' ? marker : `${marker}\n—— 随本次插入一起提出 ——\n${question}`;
  return contextMessage([{ type: 'text', text }], sections);
}

/** Normalize the plugin config. */
function readConfig(config) {
  const raw = typeof config === 'object' && config !== null ? config : {};
  const mode = MODES.has(raw.mode) ? raw.mode : 'off';
  const commands = Array.isArray(raw.commands) && raw.commands.length > 0 ? raw.commands : DEFAULT_COMMANDS;
  const seconds = Number(raw.maxAgeSeconds);
  const httpPath = typeof raw.httpPath === 'string' && raw.httpPath.startsWith('/') ? raw.httpPath : DEFAULT_HTTP_PATH;
  return {
    mode,
    commands,
    stateDir: resolveStateDir(raw.stateDir),
    maxAgeMs: Number.isFinite(seconds) ? seconds * 1000 : DEFAULT_MAX_AGE_SECONDS * 1000,
    // The browser half reads the position over this route; `http: false` turns
    // it off and leaves the plugin a pure push-mode `/ide` provider.
    http: raw.http !== false,
    httpPath,
  };
}

/** Accept a persisted counter row, or fall back to zero on anything unusable. */
function parseCounter(value) {
  if (value !== null && typeof value === 'object' && Number.isSafeInteger(value.count) && value.count >= 0) {
    return { count: value.count };
  }
  return { count: 0 };
}

/**
 * Fold this conversation's already-committed insertions off the durable log.
 *
 * Registered through `ctx.inject`, not `ctx.get`, because mount order is not
 * ours to pick: the projection service may come up after this plugin, and
 * `ctx.get` at apply time would then read `undefined` and silently cost us
 * durable numbering. A service that never appears just never runs the callback.
 */
function registerCounter(ctx) {
  ctx.inject(['sessionProjections'], (scoped) => {
    scoped.sessionProjections.register({
      key: COUNTER_KEY,
      stateVersion: 1,
      // Duck-typed schema: the service only ever calls `.parse(value)`.
      stateSchema: { parse: parseCounter },
      init: () => ({ count: 0 }),
      apply: (state, event) =>
        event !== null &&
        typeof event === 'object' &&
        event.type === 'user/message' &&
        event.data?.source?.kind === SOURCE_KIND
          ? { count: state.count + 1 }
          : state,
    });
  });
}

/**
 * Mount the plugin.
 * @param {object} ctx - cordis context carrying `commands`.
 * @param {object} [config] - see `cordis.patch.yml`.
 */
export function apply(ctx, config) {
  const { mode, commands, stateDir, maxAgeMs, http, httpPath } = readConfig(config);

  // The browser half's only way to see `~/.editor-context`: a same-origin GET.
  // `ctx.inject` rather than `ctx.get`, because mount order against the web
  // server is not ours to pick. Independent of `mode`: the chip channel is not
  // a push channel.
  if (http) {
    ctx.inject(['webServer'], (scoped) => {
      const route = createPositionRoute({ readPosition, stateDir, maxAgeMs, path: httpPath });
      scoped.effect(() => scoped.webServer.register(route), 'editor-context: position route');
    });
  }

  // A `@path#L12-34` token is still a `@`-path token, and the shipped
  // file-reference guidance says "anything else is a file" — so without this
  // the model can read the `#L` suffix as part of the path and fail to open it.
  // Order 910 sits immediately after FILE_REFERENCE (900): the grammar this
  // extends, explained where it is introduced.
  ctx.inject(['systemPrompt'], (scoped) => {
    scoped.effect(
      () =>
        scoped.systemPrompt.section({
          name: 'editor-context',
          order: 910,
          text:
            'An editor-position token has the form @<path>#L12 or @<path>#L12-L34: the path is everything before "#L", and the suffix names the lines the user is looking at. Read that path (never the whole token) when the contents matter.',
        }),
      'editor-context: position grammar',
    );
  });

  // The push channel is opt-in now that the composer chip exists. `off` is the
  // default: the browser half and the grammar section above are the whole
  // feature, and nothing enters the conversation unless the user types it.
  if (mode === 'off') return;

  registerCounter(ctx);

  /** Last auto-injected signature per agent, in memory — no writes, ever. */
  const lastAuto = new WeakMap();
  /** Highest ordinal handed out per agent, covering markers still in the inbox. */
  const issued = new WeakMap();

  /**
   * Reserve the next insertion number: `max(committed, issued) + 1`, because a
   * marker still sitting in the inbox has not been committed yet. A marker
   * dropped by a cancel leaves a gap — a gap costs nothing, a repeat does not.
   */
  const nextOrdinal = (agent) => {
    let committed = 0;
    try {
      const state = ctx.get('sessionProjections')?.stateOf?.(agent?.session, COUNTER_KEY);
      if (state !== undefined && state !== null && Number.isSafeInteger(state.count)) committed = state.count;
    } catch {
      // An unreadable projection is a missing count, not a failed command.
    }
    const next = Math.max(committed, issued.get(agent) ?? 0) + 1;
    issued.set(agent, next);
    return next;
  };

  const description = '把 Cursor/VS Code 里当前选区或光标位置作为插入标记送进本会话（可再跟一句问题）';

  const handler = async (invocation) => {
    const position = await readPosition(stateDir, maxAgeMs);
    if (position === undefined) {
      return {
        kind: 'error',
        text: `没有可用的编辑器位置：${join(stateDir, 'windows')} 下没有状态文件，或已超过 maxAgeSeconds。`,
      };
    }
    if (position.context === '') {
      return { kind: 'error', text: `当前位置被排除规则命中，不发布：${describePosition(position)}` };
    }
    const ordinal = nextOrdinal(invocation.agent);
    const message = buildMessages(position, invocation.rawInput, ordinal);
    if (message === undefined) {
      return { kind: 'error', text: `当前位置没有可用的文件地址：${describePosition(position)}` };
    }
    invocation.agent.inbox.prepend('next-step', message);
    return { kind: 'success', text: `已插入标记 #${ordinal}：${describePosition(position)}` };
  };

  ctx.effect(() => {
    const disposers = commands.map((commandName) => ctx.commands.register({ name: commandName, description, handler }));
    return () => {
      for (const dispose of disposers) dispose();
    };
  });

  if (mode === 'selection') {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next();
      if (decision === undefined || decision.kind === 'reject') return decision;
      if (payload.step !== 1) return decision;
      const position = await readPosition(stateDir, maxAgeMs);
      if (position === undefined || position.context === '') return decision;
      const selection = position.selection;
      // Selections only: a bare cursor is not a deliberate act, and moving one is
      // cheap, so auto-injecting on it is pure noise.
      if (selection === null || selection === undefined || selection.isEmpty) return decision;
      if (lastAuto.get(payload.agent) === position.sig) return decision;
      lastAuto.set(payload.agent, position.sig);
      return { ...decision, messages: [...decision.messages, buildMessages(position, '', nextOrdinal(payload.agent))] };
    });
  }
}
