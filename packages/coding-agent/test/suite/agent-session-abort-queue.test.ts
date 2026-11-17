import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

function userTextsFromContext(context: { messages: Array<{ role: string; content: unknown }> }): string[] {
	return context.messages
		.filter((message) => message.role === "user")
		.map((message) => {
			if (typeof message.content === "string") return message.content;
			if (!Array.isArray(message.content)) return "";
			return message.content
				.filter((part): part is { type: "text"; text: string } => {
					return typeof part === "object" && part !== null && (part as { type?: string }).type === "text";
				})
				.map((part) => part.text)
				.join("\n");
		});
}

function blockingTool(onStarted: () => void): AgentTool {
	return {
		name: "block",
		label: "Block",
		description: "Blocks until aborted",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, signal) => {
			onStarted();
			await new Promise<void>((resolve) => {
				if (signal?.aborted) resolve();
				else signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			return { content: [{ type: "text", text: "tool aborted" }], details: {} };
		},
	};
}

describe("abort and message queues", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses) harness.cleanup();
		harnesses.length = 0;
	});

	async function createAbortableSession(options?: { extensionFactories?: Array<(pi: ExtensionAPI) => void> }) {
		let markToolStarted = () => {};
		const toolStarted = new Promise<void>((resolve) => {
			markToolStarted = resolve;
		});
		const harness = await createHarness({
			tools: [blockingTool(markToolStarted)],
			extensionFactories: options?.extensionFactories,
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const modelRuntime = harness.session.modelRuntime;
		harness.session.agent.streamFunction = (model, context, options) =>
			modelRuntime.streamSimple(model, context, options);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" })]);
		const prompt = harness.session.prompt("start");
		await toolStarted;
		return { harness, prompt };
	}

	it("keeps a follow-up that was already queued when abort() is called", async () => {
		const { harness, prompt } = await createAbortableSession();
		await expect(harness.session.followUp("keep me")).resolves.toBe("queued");
		expect(harness.session.getFollowUpMessages()).toEqual(["keep me"]);

		await harness.session.abort();
		await prompt;

		expect(harness.session.isIdle).toBe(true);
		expect(harness.session.getFollowUpMessages()).toEqual(["keep me"]);
		expect(harness.session.pendingMessageCount).toBe(1);
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
	});

	it("does not keep a follow-up queued by agent_end during abort, and the next prompt is clean", async () => {
		let agentEndHandlerCalls = 0;
		const { harness, prompt } = await createAbortableSession({
			extensionFactories: [
				(pi) => {
					pi.on("agent_end", () => {
						agentEndHandlerCalls += 1;
						// A one-shot continuation/nudge: if abort drops it, it must not
						// reappear on a later unrelated prompt.
						if (agentEndHandlerCalls !== 1) return;
						void pi.sendUserMessage("stale continuation", { deliverAs: "followUp" });
					});
				},
			],
		});

		await harness.session.abort();
		await prompt;

		expect(harness.session.isIdle).toBe(true);
		expect(agentEndHandlerCalls).toBe(1);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(getUserTexts(harness)).toEqual(["start"]);

		const firstRequestUsers: string[][] = [];
		harness.setResponses([
			(context) => {
				firstRequestUsers.push(userTextsFromContext(context));
				return fauxAssistantMessage("new answer");
			},
		]);
		await harness.session.prompt("unrelated question");

		expect(agentEndHandlerCalls).toBe(2);
		expect(firstRequestUsers).toEqual([["start", "unrelated question"]]);
		expect(getUserTexts(harness)).toEqual(["start", "unrelated question"]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.session.isIdle).toBe(true);
	});

	it("does not let agent_end re-queue after clearQueue() then abort()", async () => {
		const { harness, prompt } = await createAbortableSession({
			extensionFactories: [
				(pi) => {
					pi.on("agent_end", () => {
						void pi.sendUserMessage("stale continuation", { deliverAs: "followUp" });
					});
				},
			],
		});
		await expect(harness.session.followUp("pre-existing")).resolves.toBe("queued");
		expect(harness.session.clearQueue()).toEqual({ steering: [], followUp: ["pre-existing"] });

		await harness.session.abort();
		await prompt;

		expect(harness.session.isIdle).toBe(true);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
	});
});
