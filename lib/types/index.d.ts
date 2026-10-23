/** Expand a leading `~` and resolve the published-state directory. */
export function resolveStateDir(configured: any): any;
/**
 * Read the newest published position, or `undefined` when there is none.
 *
 * "Newest" is by file mtime: each editor window owns its own file, and there is
 * no cross-process notion of which window is focused, so the most recently
 * updated reading is the best available answer.
 *
 * @param {string} stateDir - directory holding `windows/<pid>.json`.
 * @param {number} maxAgeMs - ignore files older than this; negative disables the check.
 * @param {number} [pid] - read this window specifically, rather than the newest.
 * @returns {Promise<undefined | {sig: string, context: string, relativePath: string, activeFile: string, selection: null | {startLine: number, endLine: number, isEmpty: boolean}, updatedAt: string}>}
 */
export function readPosition(stateDir: string, maxAgeMs: number, pid?: number): Promise<undefined | {
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
}>;
/**
 * Mount the plugin.
 * @param {object} ctx - cordis context.
 * @param {object} [config] - see `cordis.patch.yml`.
 */
export function apply(ctx: object, config?: object): void;
export const name: "editor-context";
/**
 * No service is required for this plugin to mount. Both of the services it uses
 * (`webServer`, `systemPrompt`) are optional and are taken with `ctx.inject`,
 * because mount order is not ours to pick: `ctx.get` at apply time would read
 * `undefined` for a service that comes up later and silently cost us a feature.
 */
export const inject: any[];
