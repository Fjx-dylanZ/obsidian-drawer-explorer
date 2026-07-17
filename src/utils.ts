export function prettySize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Debounce timers, sizes and caps used across the plugin. */
export const PREVIEW_DEBOUNCE_MS = 90;
export const REFRESH_DEBOUNCE_MS = 60;
export const TAG_REFRESH_DEBOUNCE_MS = 180;
export const FILTER_RESULT_CAP = 300;
export const MARKDOWN_PREVIEW_CAP = 100_000;
export const TEXT_PREVIEW_CAP = 50_000;
