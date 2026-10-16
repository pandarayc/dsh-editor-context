/**
 * The position document: one schema, two producers.
 *
 * The editor writes the same JSON whether it is publishing where the caret is
 * (`windows/<pid>.json`, continuously) or delivering a position the user asked
 * for (`requests/<epoch-ms>-<pid>.json`, once). Consumers therefore have one
 * parser, not two, and neither producer can drift from the other.
 *
 * @module dsh-editor-context/state
 */

import { readFile } from 'node:fs/promises';

/**
 * Normalize one published document. Pure, and total: every field is optional.
 *
 * `context: ''` is the only "do not publish" signal on the wire — the editor
 * writes it both for a path its exclude globs rejected and for "no file open" —
 * so it travels through here and callers decide what silence means.
 *
 * @param {unknown} state - the parsed JSON value.
 * @returns {undefined | {sig: string, context: string, relativePath: string, activeFile: string, selection: null | {startLine: number, endLine: number, isEmpty: boolean}, updatedAt: string}} the reading.
 */
export function parseWindowState(state) {
  if (typeof state !== 'object' || state === null) return undefined;
  return {
    sig: typeof state.sig === 'string' ? state.sig : '',
    context: typeof state.context === 'string' ? state.context.trim() : '',
    relativePath: typeof state.relativePath === 'string' ? state.relativePath : '',
    activeFile: typeof state.activeFile === 'string' ? state.activeFile : '',
    selection: state.selection ?? null,
    updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : '',
  };
}

/**
 * Read one document from disk.
 * @param {string} path - the file.
 * @returns {Promise<undefined | object>} the reading, or `undefined` when the file is missing or unusable.
 */
export async function readDocument(path) {
  try {
    return parseWindowState(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return undefined;
  }
}
