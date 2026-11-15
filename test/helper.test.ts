import assert from "node:assert/strict";
import { test } from "node:test";
import { HelperStream, runHelper, type HelperOptions } from "../helper.ts";
import { buildTask, parsePrompt } from "../prompt.ts";

const base: HelperOptions = {
	command: process.execPath, args: [], task: "", cwd: process.cwd(), env: process.env,
	signal: new AbortController().signal, timeoutMs: 4000, onProgress: () => {},
};

function invoke(program: string, options: Partial<HelperOptions> = {}) {
	return runHelper({ ...base, args: ["-e", program], ...options });
}

test("rewrite extraction tolerates CRLF and preserves literal example tags", () => {
	const request = buildTask("make parsing clearer");
	const prompt = "Keep this literal example:\n<improved-prompt>\nexample text\n</improved-prompt>\nThen explain the fix.";
	const reply = `(1) evidence\r\n  ${request.open}\r\n${prompt.replaceAll("\n", "\r\n")}\r\n ${request.close}\r\n`;
	assert.equal(parsePrompt(reply, request.open, request.close), prompt);
	assert.throws(() => parsePrompt(`${request.open}\npartial`, request.open, request.close), /complete/);
	assert.throws(() => parsePrompt(`${request.open}\n  \n${request.close}`, request.open, request.close), /empty/);
});

test("streaming updates cannot replace a completed answer with a partial or tool result", () => {
	const stream = new HelperStream();
	const events = [
		{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "interim" }] } },
		{ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "wrong answer" }] } },
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } },
		{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final answer" }] } },
	];
	const input = "extension diagnostic\n" + events.map(event => JSON.stringify(event)).join("\n");
	for (let offset = 0; offset < input.length; offset += 7) stream.feed(input.slice(offset, offset + 7));
	stream.finish();
	assert.equal(stream.reply, "final answer");
});

test("subprocess delivers a long stdin request and its final unterminated JSON line", async () => {
	const task = "project evidence ".repeat(20_000);
	const reply = await invoke(`let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => input += c); process.stdin.on('end', () => process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant',content:[{type:'text',text: input}]}})));`, { task });
	assert.equal(reply, task);
});

test("provider errors, empty replies and child startup failures are surfaced", async () => {
	await assert.rejects(invoke(`console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'quota exhausted',content:[]}}));`), /quota exhausted/);
	await assert.rejects(invoke(`process.stderr.write('configuration invalid'); process.exitCode = 2;`), /code 2: configuration invalid/);
	await assert.rejects(invoke(`process.exitCode = 0;`), /without a reply/);
	await assert.rejects(invoke("", { command: "/nonexistent/omp-better-command" }), /Couldn't start omp/);
});

// Real subprocess integration: fake JS timers cannot deliver OS signals or advance
// a separate Node event loop. Abort is triggered by the child's readiness event.
test("cancellation escalates past SIGTERM and does not leave a child alive", { skip: process.platform === "win32" }, async () => {
	const controller = new AbortController();
	let pid = 0;
	await assert.rejects(invoke(`process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log(JSON.stringify({type:'tool_execution_start',toolName:'read',args:{path:String(process.pid)}}));`, {
		signal: controller.signal,
		onProgress: stream => {
			if (stream.tools) { pid = Number(stream.stage.slice(5)); controller.abort(); }
		},
	}), /cancelled/);
	assert.ok(pid > 0);
	assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

// This case intentionally exercises the production platform deadline, not a mock clock.
test("deadline rejects a nonresponding subprocess instead of leaving the command busy", async () => {
	await assert.rejects(invoke("setInterval(() => {}, 1000);", { timeoutMs: 150 }), /timed out/);
});
