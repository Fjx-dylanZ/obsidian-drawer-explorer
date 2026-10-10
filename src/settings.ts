import { App, PluginSettingTab, Setting, SettingDefinitionItem } from "obsidian";
import type DrawerExplorerPlugin from "./main";

export interface DrawerExplorerSettings {
	startInInsertMode: boolean;
}

export const DEFAULT_SETTINGS: DrawerExplorerSettings = {
	startInInsertMode: false,
};

const START_IN_INSERT_MODE = {
	name: "Start in insert mode",
	desc: "Focus the filter when the drawer opens, to type a file name right away.",
};

export class DrawerExplorerSettingTab extends PluginSettingTab {
	private plugin: DrawerExplorerPlugin;

	constructor(app: App, plugin: DrawerExplorerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [{ ...START_IN_INSERT_MODE, control: { type: "toggle", key: "startInInsertMode" } }];
	}

	// Obsidian < 1.13 has no declarative settings
	display() {
		this.containerEl.empty();
		new Setting(this.containerEl)
			.setName(START_IN_INSERT_MODE.name)
			.setDesc(START_IN_INSERT_MODE.desc)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.startInInsertMode).onChange(async (value) => {
					this.plugin.settings.startInInsertMode = value;
					await this.plugin.saveSettings();
				}),
			);
	}
}
