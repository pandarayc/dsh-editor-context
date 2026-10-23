/**
 * Build a sink that appends timestamped lines to a file.
 * @param {string} [file] - destination; defaults to `~/.editor-context/plugin.log`.
 * @returns {(message: string) => void} the sink. Never throws, never blocks the caller.
 */
export function createFileLog(file?: string): (message: string) => void;
/** Where the plugin's own log lives, beside the state it reads. */
export const DEFAULT_LOG_FILE: any;
