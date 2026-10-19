/**
 * dsh-editor-context — bring "the lines I am looking at" into a DSH conversation.
 *
 * The editor extension (`vscode-editor-context`) writes one JSON file per editor
 * window under `~/.editor-context/windows/`. This plugin is the DSH-side reader,
 * and it does two things with a reading:
 *
 *   1. serves it over loopback routes (`lib/http.js`), which the browser half
 *      turns into two ways to get a position into a conversation:
 *        - `GET /editor-context/position` — the current address, offered in the
 *          `@` menu; picking one puts a chip in the user's own message;
 *        - `GET /editor-context/next` — a long poll delivering positions the
 *          user clicked **in the editor**, which the browser half inserts into
 *          the composer draft (pushed from the editor over a socket, see
 *          `lib/subscribe.js`);
 *   3. tells the model, in the system prompt, how to read the token a chip
 *      leaves behind.
 *
 * That is the whole feature, and nothing here is ever pushed into a
 * conversation: the position arrives because the user typed it. Earlier versions
 * injected a numbered marker on a timer, behind a slash command, or on a changed
 * selection. Each was a workaround for the same problem — a message the user did
 * not write has to be told apart from one they did — and each was worse than the
 * chip, which is simply a word in their sentence. See CHANGELOG 0.4.0 for what
 * was removed and `docs/composer-chip-design.md` for the reasoning.
 *
 * Zero runtime dependencies on purpose: a `link:`-installed plugin resolves
 * bare `@deepseek-ai/*` imports against its own real path, which is not inside
 * the profile's node_modules.
 *
 * @module dsh-editor-context
 */

import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { DEFAULT_REQUEST_PATH, createDeliveryQueue } from './deliveries.js';
import { DEFAULT_HTTP_PATH, createPositionRoute, createRequestRoute, createStatusRoute } from './http.js';
import { readDocument } from './state.js';
import { createFileLog } from './log.js';
import { createLink } from './link.js';

export const name = 'editor-context';

/**
 * No service is required for this plugin to mount. Both of the services it uses
 * (`webServer`, `systemPrompt`) are optional and are taken with `ctx.inject`,
 * because mount order is not ours to pick: `ctx.get` at apply time would read
 * `undefined` for a service that comes up later and silently cost us a feature.
 */
export const inject = [];

const DEFAULT_MAX_AGE_SECONDS = 3600;

/** Where the editor extension listens. Matches `editorContext.ws.*` on that side. */
const DEFAULT_WS_URL = 'ws://127.0.0.1:7788/editor-context';

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
 *
 * "Newest" is by file mtime: each editor window owns its own file, and there is
 * no cross-process notion of which window is focused, so the most recently
 * updated reading is the best available answer.
 *
 * @param {string} stateDir - directory holding `windows/<pid>.json`.
 * @param {number} maxAgeMs - ignore files older than this; negative disables the check.
 * @returns {Promise<undefined | {sig: string, context: string, relativePath: string, activeFile: string, selection: null | {startLine: number, endLine: number, isEmpty: boolean}, updatedAt: string}>}
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
  // Same parser the request queue uses: the editor writes one document schema
  // for both `windows/` and `requests/`, so there is nothing to keep in step.
  return readDocument(newest);
}

/** Normalize the plugin config. */
function readConfig(config) {
  const raw = typeof config === 'object' && config !== null ? config : {};
  const seconds = Number(raw.maxAgeSeconds);
  const httpPath = typeof raw.httpPath === 'string' && raw.httpPath.startsWith('/') ? raw.httpPath : DEFAULT_HTTP_PATH;
  return {
    stateDir: resolveStateDir(raw.stateDir),
    maxAgeMs: Number.isFinite(seconds) ? seconds * 1000 : DEFAULT_MAX_AGE_SECONDS * 1000,
    // The browser half reads the position over this route; `http: false` leaves
    // the plugin with only the grammar section below.
    http: raw.http !== false,
    httpPath,
    // The editor extension is the WebSocket server; this plugin dials it.
    wsUrl: typeof raw.wsUrl === 'string' && raw.wsUrl.trim() !== '' ? raw.wsUrl.trim() : DEFAULT_WS_URL,
    wsToken: typeof raw.wsToken === 'string' ? raw.wsToken : '',
    wsName: typeof raw.wsName === 'string' && raw.wsName.trim() !== '' ? raw.wsName.trim() : 'dsh',
    wsLabel: typeof raw.wsLabel === 'string' && raw.wsLabel.trim() !== '' ? raw.wsLabel.trim() : 'DSH',
    includeText: raw.includeText !== false,
    autoSelection: raw.autoSelection === true,
    logFile: typeof raw.logFile === 'string' ? raw.logFile.trim() : '',
  };
}

/**
 * Mount the plugin.
 * @param {object} ctx - cordis context.
 * @param {object} [config] - see `cordis.patch.yml`.
 */
export function apply(ctx, config) {
  const { stateDir, maxAgeMs, http, httpPath, wsUrl, wsToken, wsName, wsLabel, includeText, autoSelection, logFile } =
    readConfig(config);

  /**
   * Lifecycle narration that cannot itself break the plugin, written both to the
   * cordis logger and to a file — see `lib/log.js` for why the file is the one
   * that matters when something is wrong.
   */
  // Beside the state it describes, not at a fixed home path: a test (or a second
  // profile pointed at another directory) must not append to the log a real
  // deployment is being diagnosed from. Two writers in one file is how a
  // timestamp order stops meaning anything.
  const file = createFileLog(logFile === '' ? join(stateDir, 'plugin.log') : logFile);
  const say = (message) => {
    file(message);
    try {
      ctx.logger?.info?.(message);
    } catch {
      // A logger that is unhappy is not a reason to fail a mount.
    }
  };
  say(
    `mounting: endpoints=${join(stateDir, 'endpoints')} fallback=${wsUrl} token=${wsToken === '' ? '(none)' : 'set'} http=${String(http)}`,
  );

  // The browser half's only way to see the editor: same-origin HTTP. Two routes
  // over one queue — the current position for the `@` menu, and the long poll
  // that carries what the editor pushed.
  if (http) {
    ctx.inject(['webServer'], (scoped) => {
      const queue = createDeliveryQueue({ maxAgeMs });
      let statusSource;
      scoped.effect(() => {
        const stopPosition = scoped.webServer.register(
          createPositionRoute({ readPosition, stateDir, maxAgeMs, path: httpPath }),
        );
        const stopNext = scoped.webServer.register(createRequestRoute({ queue }));
        const stopStatus = scoped.webServer.register(
          createStatusRoute({
            status: () => {
              // `undefined` until the link effect has run: the route is registered
              // in the same effect as the link, so this is only the first
              // microseconds, and answering "no connections" is the truth then.
              return statusSource?.() ?? { subscribed: false, connections: [] };
            },
          }),
        );
        return () => {
          stopPosition();
          stopNext();
          stopStatus();
        };
      }, 'editor-context: position routes');
      // One socket per editor window. Membership comes from the endpoint
      // registry, so a second window, a moved port or a restart are all the same
      // event: the next scan sees a different directory than the last one.
      scoped.effect(() => {
        const link = createLink({
          stateDir,
          fallbackUrl: wsUrl,
          token: wsToken,
          name: wsName,
          label: wsLabel,
          includeText,
          autoSelection,
          onDelivery: (delivery) => {
            queue.push(delivery);
          },
          log: say,
        });
        link.start();
        statusSource = () => link.status();
        return () => {
          statusSource = undefined;
          link.stop();
          queue.stop();
        };
      }, 'editor-context: editor links');
    });
  }

  // A `@path#L12-34` token is still a `@`-path token, and the shipped
  // file-reference guidance says "anything else is a file" — so without this the
  // model can read the `#L` suffix as part of the path and fail to open it.
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
}
