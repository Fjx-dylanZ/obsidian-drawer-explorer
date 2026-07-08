import { App, Component, TFile } from "obsidian";

/** Everything a provider needs to render a preview. */
export interface PreviewContext {
	app: App;
	/** Container to render into. It is discarded wholesale when the selection changes. */
	el: HTMLElement;
	file: TFile;
	/** Lifecycle owner for renderers that need one (e.g. MarkdownRenderer). Unloaded on selection change. */
	component: Component;
}

/**
 * A preview renderer for one or more file types.
 *
 * Register via `plugin.registerPreviewProvider(...)` — first provider whose
 * `canPreview` returns true wins, so more specific providers should be
 * registered before generic ones.
 */
export interface PreviewProvider {
	/** Unique id, used for ordering (`before`) and debugging. */
	id: string;
	canPreview(file: TFile): boolean;
	render(ctx: PreviewContext): Promise<void> | void;
}

export class PreviewRegistry {
	private providers: PreviewProvider[] = [];

	register(provider: PreviewProvider, opts?: { before?: string }): void {
		if (opts?.before) {
			const idx = this.providers.findIndex((p) => p.id === opts.before);
			if (idx >= 0) {
				this.providers.splice(idx, 0, provider);
				return;
			}
		}
		this.providers.push(provider);
	}

	unregister(id: string): void {
		this.providers = this.providers.filter((p) => p.id !== id);
	}

	resolve(file: TFile): PreviewProvider | undefined {
		return this.providers.find((p) => p.canPreview(file));
	}
}
