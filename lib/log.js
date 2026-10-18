/**
 * A log for this plugin that is actually readable.
 *
 * `ctx.logger` output does not reach any file in every deployment — the shipped
 * web profile writes the process's stdout to an append log, and a plugin's
 * logger lines are not in it. A subsystem whose diagnostics go nowhere cannot be
 * debugged: a socket that never dials, and a socket that dials and is refused,
 * look identical from outside.
 *
 * So this writes beside the state it describes, best effort: a log that cannot be
 * written is never a reason to fail, and the file is rotated by size so it cannot
 * grow without bound.
 *
 * @module dsh-editor-context/log
 */

import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Rotate at this size. An editor socket is chatty only when it is broken. */
const MAX_BYTES = 256 * 1024;

/** Check the size once every this many lines, rather than on every write. */
const CHECK_EVERY = 200;

/** Where the plugin's own log lives, beside the state it reads. */
export const DEFAULT_LOG_FILE = join(homedir(), '.editor-context', 'plugin.log');

/**
 * Build a sink that appends timestamped lines to a file.
 * @param {string} [file] - destination; defaults to `~/.editor-context/plugin.log`.
 * @returns {(message: string) => void} the sink. Never throws, never blocks the caller.
 */
export function createFileLog(file = DEFAULT_LOG_FILE) {
  let written = 0;
  let ready;
  return (message) => {
    const line = `${new Date().toISOString()} ${String(message)}\n`;
    void (async () => {
      try {
        ready ??= mkdir(dirname(file), { recursive: true }).catch(() => undefined);
        await ready;
        written += 1;
        if (written % CHECK_EVERY === 0) {
          const info = await stat(file).catch(() => undefined);
          if (info !== undefined && info.size > MAX_BYTES) await writeFile(file, '', 'utf8');
        }
        await appendFile(file, line, 'utf8');
      } catch {
        // Best effort by design: diagnostics must not become a failure mode.
      }
    })();
  };
}
