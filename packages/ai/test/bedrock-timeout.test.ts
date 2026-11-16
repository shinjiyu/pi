import { describe, expect, it, vi } from "vitest";

const bedrockMock = vi.hoisted(() => ({
	mode: "hang-send" as "hang-send" | "hang-after-start" | "complete" | "chunk-then-hang" | "slow-success",
	sendOptions: undefined as { abortSignal?: AbortSignal } | undefined,
	clientConfig: undefined as { requestHandler?: unknown } | undefined,
}));

function rejectWhenAborted(signal: AbortSignal | undefined): Promise<never> {
	return new Promise((_, reject) => {
		const fail = () => {
			const reason = signal?.reason;
			reject(reason instanceof Error ? reason : new Error("Request was aborted"));
		};
		if (signal?.aborted) {
			fail();
			return;
		}
		signal?.addEventListener("abort", fail, { once: true });
	});
}

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}
	class BedrockRuntimeClient {
		constructor(config: { requestHandler?: unknown }) {
			bedrockMock.clientConfig = config;
		}
		send(_command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
			bedrockMock.sendOptions = options;
			const signal = options?.abortSignal;
			if (bedrockMock.mode === "hang-send") {
				return rejectWhenAborted(signal);
			}
			return Promise.resolve({
				$metadata: { httpStatusCode: 200, requestId: "req-timeout" },
				stream: (async function* () {
					yield { messageStart: { role: "assistant" } };
					if (bedrockMock.mode === "complete") {
						yield { messageStop: { stopReason: "end_turn" } };
						return;
					}
					if (bedrockMock.mode === "slow-success") {
						await new Promise((resolve) => setTimeout(resolve, 80));
						yield { messageStop: { stopReason: "end_turn" } };
						return;
					}
					if (bedrockMock.mode === "chunk-then-hang") {
						await new Promise((resolve) => setTimeout(resolve, 80));
						yield { metadata: { usage: { inputTokens: 1, outputTokens: 1 } } };
						await rejectWhenAborted(signal);
						return;
					}
					await rejectWhenAborted(signal);
				})(),
			});
		}
	}
	class ConverseStreamCommand {
		readonly input: unknown;
		constructor(input: unknown) {
			this.input = input;
		}
	}
	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			TOOL_USE: "tool_use",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import type { Model } from "../src/types.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"bedrock-converse-stream"> = {
	id: "global.anthropic.claude-test",
	name: "Claude Test",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 64_000,
};

const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });

async function settledWithin<T>(
	promise: Promise<T>,
	ms: number,
): Promise<{ settled: true; value: T } | { settled: false }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const outcome = await Promise.race([
		promise.then((value) => ({ settled: true as const, value })),
		new Promise<{ settled: false }>((resolve) => {
			timer = setTimeout(() => resolve({ settled: false }), ms);
		}),
	]);
	if (timer) clearTimeout(timer);
	return outcome;
}

function streamOptions(timeoutMs?: number, signal?: AbortSignal) {
	return {
		timeoutMs,
		signal,
		apiKey: "test",
		env: { AWS_BEDROCK_SKIP_AUTH: "1" },
	};
}

describe("bedrock timeoutMs idle timeout", () => {
	it("times out when client.send never resolves", async () => {
		bedrockMock.mode = "hang-send";
		const started = Date.now();
		const result = await streamBedrock(model, context, streamOptions(150)).result();
		const elapsed = Date.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(140);
		expect(elapsed).toBeLessThan(500);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/timed out because of no activity for 150 ms/i);
		expect(isRetryableAssistantError(result)).toBe(true);
		expect(bedrockMock.sendOptions?.abortSignal?.aborted).toBe(true);
		expect(bedrockMock.clientConfig?.requestHandler).toBeUndefined();
	});

	it("times out when the stream stalls after messageStart", async () => {
		bedrockMock.mode = "hang-after-start";
		const started = Date.now();
		const result = await streamBedrock(model, context, streamOptions(150)).result();
		const elapsed = Date.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(140);
		expect(elapsed).toBeLessThan(500);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/timed out because of no activity for 150 ms/i);
		expect(isRetryableAssistantError(result)).toBe(true);
	});

	it("resets the idle timer after stream activity", async () => {
		bedrockMock.mode = "chunk-then-hang";
		const started = Date.now();
		const result = await streamBedrock(model, context, streamOptions(120)).result();
		const elapsed = Date.now() - started;
		// 80ms of activity plus a 120ms idle window, not a 120ms wall-clock deadline.
		expect(elapsed).toBeGreaterThanOrEqual(180);
		expect(elapsed).toBeLessThan(600);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/timed out because of no activity for 120 ms/i);
		expect(isRetryableAssistantError(result)).toBe(true);
	});

	it("does not cut off a stream that stays active past timeoutMs", async () => {
		bedrockMock.mode = "slow-success";
		const result = await streamBedrock(model, context, streamOptions(150)).result();
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
	});

	it("ignores timeoutMs when it is 0", async () => {
		bedrockMock.mode = "hang-send";
		const outcome = await settledWithin(streamBedrock(model, context, streamOptions(0)).result(), 300);
		expect(outcome.settled).toBe(false);
		expect(bedrockMock.sendOptions?.abortSignal?.aborted).toBeFalsy();
	});

	it("treats a user abort as aborted rather than a timeout", async () => {
		bedrockMock.mode = "hang-send";
		const controller = new AbortController();
		const resultPromise = streamBedrock(model, context, streamOptions(500, controller.signal)).result();
		setTimeout(() => controller.abort(), 40);
		const started = Date.now();
		const result = await resultPromise;
		const elapsed = Date.now() - started;
		expect(elapsed).toBeLessThan(300);
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toMatch(/aborted/i);
		expect(isRetryableAssistantError(result)).toBe(false);
	});
});
