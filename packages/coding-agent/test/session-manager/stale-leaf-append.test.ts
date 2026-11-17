import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

describe("SessionManager stale leaf across two instances", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-stale-leaf-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeInitialSession(): { file: string; tip: string } {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage(userMsg("erste nachricht"));
		session.appendMessage(assistantMsg("erste antwort"));
		const tip = session.appendCustomEntry("probe-start", { stage: "initial" });
		const file = session.getSessionFile();
		if (!file) throw new Error("expected a session file");
		return { file, tip };
	}

	it("appends an idle instance's custom entry to the file tip instead of forking an orphan branch", () => {
		const { file, tip } = writeInitialSession();

		const idle = SessionManager.open(file, tempDir);
		expect(idle.getLeafId()).toBe(tip);

		const other = SessionManager.open(file, tempDir);
		other.appendMessage(userMsg("zweite nachricht"));
		other.appendMessage(assistantMsg("zweite antwort"));
		const otherShutdown = other.appendCustomEntry("probe-shutdown", { from: "other" });
		expect(other.getLeafId()).toBe(otherShutdown);

		// The idle manager still holds the load-time leaf until it appends.
		expect(idle.getLeafId()).toBe(tip);

		const idleShutdown = idle.appendCustomEntry("probe-shutdown", { from: "idle" });
		const idleEntry = idle.getEntries().find((entry) => entry.id === idleShutdown);
		expect(idleEntry?.parentId).toBe(otherShutdown);
		expect(idle.getLeafId()).toBe(idleShutdown);

		const resumed = SessionManager.open(file, tempDir);
		expect(resumed.getLeafId()).toBe(idleShutdown);
		expect(resumed.getBranch().map((entry) => entry.id)).toEqual([...idle.getBranch().map((entry) => entry.id)]);
		const roles = resumed
			.buildSessionContext()
			.messages.filter((message) => message.role === "user" || message.role === "assistant")
			.map((message) => message.role);
		expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
	});

	it("does not move a leaf that was deliberately branched away from the old file tip", () => {
		const { file, tip } = writeInitialSession();
		const idle = SessionManager.open(file, tempDir);
		const firstUserId = idle.getEntries()[0].id;
		idle.branch(firstUserId);

		const other = SessionManager.open(file, tempDir);
		other.appendMessage(userMsg("zweite nachricht"));
		const otherTip = other.appendMessage(assistantMsg("zweite antwort"));

		const forked = idle.appendCustomEntry("probe-shutdown", { from: "idle-branch" });
		const forkedEntry = idle.getEntries().find((entry) => entry.id === forked);
		expect(forkedEntry?.parentId).toBe(firstUserId);
		expect(idle.getLeafId()).toBe(forked);

		const resumed = SessionManager.open(file, tempDir);
		expect(resumed.getLeafId()).toBe(forked);
		expect(resumed.getBranch().map((entry) => entry.id)).toEqual([firstUserId, forked]);
		expect(resumed.getEntries().some((entry) => entry.id === otherTip)).toBe(true);
		expect(resumed.getEntries().some((entry) => entry.id === tip)).toBe(true);
	});
});
