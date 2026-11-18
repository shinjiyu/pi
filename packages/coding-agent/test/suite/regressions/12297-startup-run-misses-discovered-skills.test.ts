import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

async function setup(createFactories: (skillDir: string) => ExtensionFactory[]): Promise<Harness> {
	const root = mkdtempSync(join(tmpdir(), "pi-12297-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const skillDir = join(root, "probe-skill");
	mkdirSync(skillDir);
	writeFileSync(join(skillDir, "SKILL.md"), "---\nname: probe-skill\ndescription: probe\n---\n");

	const resourceLoader = new DefaultResourceLoader({
		cwd: root,
		agentDir,
		settingsManager: SettingsManager.inMemory(),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: createFactories(skillDir),
	});
	await resourceLoader.reload();

	const harness = await createHarness({ resourceLoader });
	harness.setResponses([{ text: "ok" }]);
	return harness;
}

describe("#12297 startup run waits for resources_discover skills", () => {
	it("includes discovered skills when sendUserMessage runs from session_start", async () => {
		const skillNamesAtRunStart: string[][] = [];
		const harness = await setup((skillDir) => [
			(pi) => {
				pi.on("resources_discover", async () => {
					await new Promise((resolve) => setTimeout(resolve, 40));
					return { skillPaths: [skillDir] };
				});
			},
			(pi) => {
				pi.on("session_start", () => {
					pi.sendUserMessage("hi");
				});
				pi.on("before_agent_start", (event) => {
					skillNamesAtRunStart.push(event.systemPromptOptions.skills.map((skill) => skill.name));
				});
			},
		]);
		try {
			await harness.session.bindExtensions({});
			await harness.session.waitForIdle();
			expect(skillNamesAtRunStart).toEqual([["probe-skill"]]);
		} finally {
			harness.cleanup();
		}
	});

	it("includes discovered skills when sendUserMessage runs from resources_discover", async () => {
		const skillNamesAtRunStart: string[][] = [];
		const harness = await setup((skillDir) => [
			(pi) => {
				pi.on("resources_discover", async () => {
					await new Promise((resolve) => setTimeout(resolve, 40));
					return { skillPaths: [skillDir] };
				});
			},
			(pi) => {
				pi.on("resources_discover", () => {
					pi.sendUserMessage("hi");
				});
				pi.on("before_agent_start", (event) => {
					skillNamesAtRunStart.push(event.systemPromptOptions.skills.map((skill) => skill.name));
				});
			},
		]);
		try {
			await harness.session.bindExtensions({});
			await harness.session.waitForIdle();
			expect(skillNamesAtRunStart).toEqual([["probe-skill"]]);
		} finally {
			harness.cleanup();
		}
	});

	it("includes discovered skills for a prompt issued after bindExtensions", async () => {
		const names: string[] = [];
		const harness = await setup((skillDir) => [
			(pi) => {
				pi.on("resources_discover", async () => ({ skillPaths: [skillDir] }));
				pi.on("before_agent_start", (event) => {
					names.push(...event.systemPromptOptions.skills.map((skill) => skill.name));
				});
			},
		]);
		try {
			await harness.session.bindExtensions({});
			await harness.session.prompt("hi");
			expect(names).toEqual(["probe-skill"]);
		} finally {
			harness.cleanup();
		}
	});
});
