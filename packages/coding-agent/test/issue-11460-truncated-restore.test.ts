import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession, type InlineExtension } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

// Repro fixture from https://github.com/earendil-works/pi/issues/11460#issuecomment-6964946487
// Line m1 has an invalid `\X` escape, so it is skipped on load and m2's parent is missing.
const cutJsonl = [
	`{"type":"session","version":3,"id":"s1","timestamp":"2026-01-01T00:00:00Z","cwd":"/tmp"}`,
	`{"type":"message","id":"a1","parentId":null,"timestamp":"2026-01-01T00:00:01Z","message":{"role":"system","content":"","toolsAdded":[{"name":"read","description":"read","parameters":{"type":"object","properties":{}}},{"name":"bash","description":"bash","parameters":{"type":"object","properties":{}}},{"name":"edit","description":"edit","parameters":{"type":"object","properties":{}}},{"name":"write","description":"write","parameters":{"type":"object","properties":{}}}],"timestamp":0}}`,
	`{"type":"message","id":"a2","parentId":"a1","timestamp":"2026-01-01T00:00:02Z","message":{"role":"user","content":"hi","timestamp":0}}`,
	`{"type":"compaction","id":"c1","parentId":"a2","timestamp":"2026-01-01T00:00:03Z","summary":"summary","firstKeptEntryId":"a2","tokensBefore":1000,"systemMessage":{"role":"system","content":"","toolsAdded":[{"name":"read","description":"read","parameters":{"type":"object","properties":{}}},{"name":"bash","description":"bash","parameters":{"type":"object","properties":{}}},{"name":"edit","description":"edit","parameters":{"type":"object","properties":{}}},{"name":"write","description":"write","parameters":{"type":"object","properties":{}}}],"timestamp":0}}`,
	`{"type":"message","id":"m1","parentId":"c1","timestamp":"2026-01-01T00:00:04Z","message":{"role":"user","content":"\\X","timestamp":0}}`,
	`{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-01-01T00:00:05Z","message":{"role":"system","content":"","toolsAdded":[{"name":"ext_tool","description":"ext_tool","parameters":{"type":"object","properties":{}}}],"timestamp":0}}`,
].join("\n");

const extTool: InlineExtension = (pi) => {
	pi.registerTool({
		name: "ext_tool",
		label: "Ext Tool",
		description: "Extension tool declared after the cut",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	});
};

describe("issue #11460 truncated branch tool restore", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-11460-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	async function resume(sessionPath: string, options: { defaultTools?: string[] } = {}) {
		const sessionManager = SessionManager.open(sessionPath, tempDir, tempDir);
		const settingsManager = SettingsManager.inMemory(
			options.defaultTools ? { defaultTools: options.defaultTools } : {},
		);
		return (
			await createAgentSession({
				cwd: tempDir,
				agentDir: join(tempDir, "agent"),
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				settingsManager,
				sessionManager,
			})
		).session;
	}

	async function resumeWithExtensions(
		sessionPath: string,
		extensionFactories: InlineExtension[],
		defaultTools?: string[],
	) {
		const settingsManager = SettingsManager.inMemory(defaultTools ? { defaultTools } : {});
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir: join(tempDir, "agent"),
			settingsManager,
			extensionFactories,
		});
		await resourceLoader.reload();
		const sessionManager = SessionManager.open(sessionPath, tempDir, tempDir);
		return (
			await createAgentSession({
				cwd: tempDir,
				agentDir: join(tempDir, "agent"),
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				settingsManager,
				sessionManager,
				resourceLoader,
			})
		).session;
	}

	it("keeps default built-ins when a malformed line truncates the branch", async () => {
		const sessionPath = join(tempDir, "cut.jsonl");
		writeFileSync(sessionPath, cutJsonl);
		expect(() => JSON.parse(`{"content":"\\X"}`)).toThrow();

		const loaded = SessionManager.open(sessionPath, tempDir, tempDir);
		expect(loaded.getBranch().map((entry) => entry.id)).toEqual(["m2"]);
		expect(loaded.getBranch()[0]?.parentId).toBe("m1");

		const session = await resume(sessionPath);
		expect(session.getActiveToolNames().sort()).toEqual(["bash", "edit", "read", "write"]);
		session.dispose();
	});

	it("control: a well-formed copy of the same file restores the recorded built-ins", async () => {
		const sessionPath = join(tempDir, "fixed.jsonl");
		writeFileSync(sessionPath, cutJsonl.replace("\\X", "ok"));
		const loaded = SessionManager.open(sessionPath, tempDir, tempDir);
		expect(loaded.getBranch().map((entry) => entry.id)).toEqual(["a1", "a2", "c1", "m1", "m2"]);

		const session = await resume(sessionPath);
		expect(session.getActiveToolNames().sort()).toEqual(["bash", "edit", "read", "write"]);
		session.dispose();
	});

	it("activates a registered extension tool declared after the cut", async () => {
		const sessionPath = join(tempDir, "cut.jsonl");
		writeFileSync(sessionPath, cutJsonl);
		const session = await resumeWithExtensions(sessionPath, [extTool]);
		expect(session.getActiveToolNames().sort()).toEqual(["bash", "edit", "ext_tool", "read", "write"]);
		session.dispose();
	});

	it("uses defaultTools, not the hard-coded built-in set, when the branch is truncated", async () => {
		const sessionPath = join(tempDir, "cut.jsonl");
		writeFileSync(sessionPath, cutJsonl);
		const session = await resume(sessionPath, { defaultTools: ["grep"] });
		expect(session.getActiveToolNames()).toEqual(["grep"]);
		session.dispose();
	});

	it("applies toolsRemoved that remain on the truncated branch", async () => {
		const sessionPath = join(tempDir, "cut-removed.jsonl");
		writeFileSync(
			sessionPath,
			cutJsonl.replace(
				`"toolsAdded":[{"name":"ext_tool","description":"ext_tool","parameters":{"type":"object","properties":{}}}]`,
				`"toolsRemoved":[{"name":"write","description":"write","parameters":{"type":"object","properties":{}}}]`,
			),
		);
		const session = await resume(sessionPath);
		expect(session.getActiveToolNames().sort()).toEqual(["bash", "edit", "read"]);
		session.dispose();
	});

	it("seeds from a compaction snapshot still on the truncated branch", async () => {
		// The malformed line is before the compaction, so the leaf is the compaction itself and the
		// initial system message is unreachable, but the snapshot still holds the reduced loadout.
		const sessionPath = join(tempDir, "cut-compaction.jsonl");
		writeFileSync(
			sessionPath,
			[
				`{"type":"session","version":3,"id":"s1","timestamp":"2026-01-01T00:00:00Z","cwd":"/tmp"}`,
				`{"type":"message","id":"a1","parentId":null,"timestamp":"2026-01-01T00:00:01Z","message":{"role":"system","content":"","toolsAdded":[{"name":"read","description":"read","parameters":{"type":"object","properties":{}}},{"name":"bash","description":"bash","parameters":{"type":"object","properties":{}}},{"name":"edit","description":"edit","parameters":{"type":"object","properties":{}}},{"name":"write","description":"write","parameters":{"type":"object","properties":{}}}],"timestamp":0}}`,
				`{"type":"message","id":"m1","parentId":"a1","timestamp":"2026-01-01T00:00:02Z","message":{"role":"user","content":"\\X","timestamp":0}}`,
				`{"type":"compaction","id":"c1","parentId":"m1","timestamp":"2026-01-01T00:00:03Z","summary":"summary","firstKeptEntryId":"a1","tokensBefore":1000,"systemMessage":{"role":"system","content":"","toolsAdded":[{"name":"read","description":"read","parameters":{"type":"object","properties":{}}},{"name":"grep","description":"grep","parameters":{"type":"object","properties":{}}}],"timestamp":0}}`,
			].join("\n"),
		);
		const loaded = SessionManager.open(sessionPath, tempDir, tempDir);
		expect(loaded.getBranch().map((entry) => entry.id)).toEqual(["c1"]);

		const session = await resume(sessionPath);
		expect(session.getActiveToolNames().sort()).toEqual(["grep", "read"]);
		session.dispose();
	});
});
