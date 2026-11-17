import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCompleteEntriesFromFile, SessionManager } from "../../src/core/session-manager.ts";
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

	it("does not splice a newline into a torn last line that has no trailing newline", () => {
		const { file } = writeInitialSession();
		const idle = SessionManager.open(file, tempDir);
		const other = SessionManager.open(file, tempDir);
		other.appendMessage(userMsg("zweite nachricht"));
		const parentId = other.getLeafId();
		if (!parentId) throw new Error("expected a leaf");

		const torn = `{"type":"custom","customType":"torn","id":"torn0001","parentId":"${parentId}","timestamp":"2026-01-01T00:00:00.000Z","data":{`;
		appendFileSync(file, torn);

		idle.appendCustomEntry("probe-shutdown", { from: "idle" });

		const after = readFileSync(file);
		const tornBuf = Buffer.from(torn);
		const tornAt = after.indexOf(tornBuf);
		expect(tornAt).toBeGreaterThanOrEqual(0);
		// The in-flight fragment must stay contiguous; a repair newline would split it.
		expect(after.subarray(tornAt, tornAt + tornBuf.length).equals(tornBuf)).toBe(true);
	});

	it("rebuilds from disk when another process rewrites a shorter file", () => {
		const { file, tip } = writeInitialSession();
		const initialContent = readFileSync(file);
		const idle = SessionManager.open(file, tempDir);

		const other = SessionManager.open(file, tempDir);
		other.appendMessage(userMsg("zweite nachricht"));
		const otherTip = other.appendMessage(assistantMsg("zweite antwort"));
		expect(statSync(file).size).toBeGreaterThan(initialContent.length);

		writeFileSync(file, initialContent);

		const idleShutdown = idle.appendCustomEntry("probe-shutdown", { from: "idle" });
		const idleEntry = idle.getEntries().find((entry) => entry.id === idleShutdown);
		expect(idleEntry?.parentId).toBe(tip);
		expect(idle.getEntries().some((entry) => entry.id === otherTip)).toBe(false);

		const resumed = SessionManager.open(file, tempDir);
		expect(resumed.getLeafId()).toBe(idleShutdown);
		expect(resumed.getEntries().some((entry) => entry.id === otherTip)).toBe(false);
		expect(resumed.getBranch().map((entry) => entry.id)).toEqual([...idle.getBranch().map((entry) => entry.id)]);
	});

	it("does not re-read the file when its size is unchanged", () => {
		const { file } = writeInitialSession();
		const idle = SessionManager.open(file, tempDir);
		// Write-only: stat/append still work, but a mistaken ingest read would throw EACCES.
		chmodSync(file, 0o222);
		try {
			const shutdown = idle.appendCustomEntry("probe-shutdown", { from: "idle" });
			expect(idle.getLeafId()).toBe(shutdown);
		} finally {
			chmodSync(file, 0o644);
		}
	});
});

describe("readCompleteEntriesFromFile", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-complete-entries-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("parses only complete newline-terminated lines and leaves a torn tail unread", () => {
		const file = join(tempDir, "session.jsonl");
		const header = '{"type":"session","id":"abc","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}';
		const message =
			'{"type":"message","id":"1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"hi","timestamp":1}}';
		const torn = '{"type":"custom","customType":"torn","id":"torn0001"';
		const content = `${header}\n${message}\n${torn}`;
		writeFileSync(file, content);

		const firstLine = `${header}\n`;
		const { entries, endOffset } = readCompleteEntriesFromFile(file, Buffer.byteLength(firstLine));
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ type: "message", id: "1" });
		expect(endOffset).toBe(Buffer.byteLength(`${header}\n${message}\n`));
		expect(readFileSync(file, "utf8")).toBe(content);
	});
});
