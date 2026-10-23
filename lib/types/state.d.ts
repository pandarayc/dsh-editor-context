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
export function parseWindowState(state: unknown): undefined | {
    sig: string;
    context: string;
    relativePath: string;
    activeFile: string;
    selection: null | {
        startLine: number;
        endLine: number;
        isEmpty: boolean;
    };
    updatedAt: string;
};
/**
 * Read one document from disk.
 * @param {string} path - the file.
 * @returns {Promise<undefined | object>} the reading, or `undefined` when the file is missing or unusable.
 */
export function readDocument(path: string): Promise<undefined | object>;
