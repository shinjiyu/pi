import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { formatDefaultModelFallbackMessage } from "../src/core/model-resolver.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

describe("saved default model fallback warning", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	async function createSession(options: { defaultProvider: string; defaultModel: string; authProviders?: string[] }) {
		const tempDir = join(tmpdir(), `pi-default-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);

		const credentials: Record<string, { type: "api_key"; key: string }> = {};
		for (const provider of options.authProviders ?? ["deepseek"]) {
			credentials[provider] = { type: "api_key", key: "test-key" };
		}
		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(credentials),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const settingsManager = SettingsManager.inMemory({
			defaultProvider: options.defaultProvider,
			defaultModel: options.defaultModel,
		});

		const created = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			settingsManager,
			sessionManager: SessionManager.inMemory(tempDir),
			modelRuntime,
			resourceLoader: createTestResourceLoader(),
		});
		return { ...created, modelRuntime };
	}

	// #10812
	test("createAgentSession warns when the saved default is missing from the catalog", async () => {
		const { session, modelFallbackMessage, modelRuntime } = await createSession({
			defaultProvider: "deepseek",
			defaultModel: "deepseek-v4-flash",
		});

		expect(modelRuntime.getModel("deepseek", "deepseek-v4-flash")).toBeUndefined();

		try {
			expect(session.model?.provider).toBe("deepseek");
			expect(session.model?.id).toBe("deepseek-v4-pro");
			expect(modelFallbackMessage).toBe(
				formatDefaultModelFallbackMessage("deepseek", "deepseek-v4-flash", "model no longer exists", {
					provider: "deepseek",
					id: "deepseek-v4-pro",
				}),
			);
		} finally {
			session.dispose();
		}
	});

	test("createAgentSession does not warn when the saved default exists and is authenticated", async () => {
		const { session, modelFallbackMessage } = await createSession({
			defaultProvider: "deepseek",
			defaultModel: "deepseek-flash",
		});

		try {
			expect(session.model?.provider).toBe("deepseek");
			expect(session.model?.id).toBe("deepseek-flash");
			expect(modelFallbackMessage).toBeUndefined();
		} finally {
			session.dispose();
		}
	});
});
