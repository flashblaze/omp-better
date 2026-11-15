import { spawn } from "node:child_process";
import { isRecord } from "./guards.ts";

export class HelperStream {
	reply = "";
	modelError = "";
	stage = "Reading project files";
	tools = 0;
	private pending = "";

	feed(chunk: string): void {
		this.pending += chunk;
		if (this.pending.length > 16 * 1024 * 1024) throw new Error("The helper emitted an oversized JSON event.");
		let newline: number;
		while ((newline = this.pending.indexOf("\n")) >= 0) {
			this.consume(this.pending.slice(0, newline));
			this.pending = this.pending.slice(newline + 1);
		}
	}

	finish(): void {
		if (this.pending.trim()) this.consume(this.pending);
		this.pending = "";
	}

	private consume(line: string): void {
		let event: unknown;
		try { event = JSON.parse(line); } catch { return; }
		if (!isRecord(event)) return;
		if (event.type === "tool_execution_start") {
			this.tools++;
			const name = typeof event.toolName === "string" ? event.toolName : "read";
			const path = isRecord(event.args) && typeof event.args.path === "string" ? event.args.path : "";
			this.stage = `${name}${path ? ` ${path}` : ""}`.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 160);
		}
		if (event.type === "message_update" && isRecord(event.assistantMessageEvent) && event.assistantMessageEvent.type === "text_delta") {
			this.stage = "Writing the grounded rewrite";
		}
		if (event.type !== "message_end" || !isRecord(event.message) || event.message.role !== "assistant") return;
		const message = event.message;
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			this.modelError = typeof message.errorMessage === "string" ? message.errorMessage : `Model request ${message.stopReason}`;
		} else {
			this.modelError = "";
		}
		if (!Array.isArray(message.content)) return;
		const text = message.content.flatMap((part: unknown) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
		if (text.trim()) this.reply = text;
	}
}

export interface HelperOptions {
	command: string;
	prefix?: string[];
	args: string[];
	task: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	signal: AbortSignal;
	timeoutMs: number;
	onProgress: (stream: HelperStream) => void;
}

export function runHelper(options: HelperOptions): Promise<string> {
	if (options.signal.aborted) return Promise.reject(new Error("Rewrite cancelled; nothing was sent."));
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const stream = new HelperStream();
	const grouped = process.platform !== "win32";
	const child = spawn(options.command, [...(options.prefix ?? []), ...options.args], {
		cwd: options.cwd, env: options.env, detached: grouped, stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	let stopped: Error | undefined;
	let settled = false;
	let forceTimer: NodeJS.Timeout | undefined;
	let deadlineTimer: NodeJS.Timeout | undefined;
	const kill = (signal: NodeJS.Signals) => {
		try {
			if (grouped && child.pid) process.kill(-child.pid, signal);
			else child.kill(signal);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
				stopped ??= new Error(`Could not stop the helper: ${String(error)}`);
			}
		}
	};
	const finish = (error?: Error) => {
		if (settled) return;
		settled = true;
		clearTimeout(timeout);
		clearTimeout(forceTimer);
		clearTimeout(deadlineTimer);
		options.signal.removeEventListener("abort", abort);
		child.stdin.destroy();
		child.stdout.destroy();
		child.stderr.destroy();
		if (error) reject(error);
		else resolve(stream.reply);
	};
	const stop = (error: Error) => {
		if (stopped || settled) return;
		stopped = error;
		kill("SIGTERM");
		forceTimer = setTimeout(() => kill("SIGKILL"), 600);
		// A broken child or inherited pipe cannot leave /better permanently busy.
		deadlineTimer = setTimeout(() => { kill("SIGKILL"); finish(stopped); }, 1200);
	};
	const abort = () => stop(new Error("Rewrite cancelled; nothing was sent."));
	const timeout = setTimeout(() => stop(new Error(`The helper timed out after ${Math.round(options.timeoutMs / 1000)} seconds; try a narrower prompt.`)), options.timeoutMs);
	options.signal.addEventListener("abort", abort, { once: true });
	if (options.signal.aborted) abort();
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		if (settled) return;
		try { stream.feed(chunk); options.onProgress(stream); }
		catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
	child.stdin.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code !== "EPIPE") stop(new Error(`Could not send the helper its prompt: ${error.message}`));
	});
	child.on("error", error => finish(new Error(`Couldn't start omp for the helper: ${error.message}`)));
	child.on("close", (code, signal) => {
		// This process group belongs solely to the helper, including any private
		// language servers or MCP children that outlive its main process.
		kill("SIGKILL");
		if (stopped) return finish(stopped);
		try { stream.finish(); } catch (error) { return finish(error instanceof Error ? error : new Error(String(error))); }
		if (code !== 0) {
			const how = signal ? `was stopped by ${signal}` : `exited with code ${code}`;
			const detail = stream.modelError || stderr.trim().split("\n").slice(-3).join(" ");
			return finish(new Error(`The helper ${how}${detail ? `: ${detail}` : " without an error message"}`));
		}
		if (stream.modelError) return finish(new Error(stream.modelError));
		if (!stream.reply.trim()) return finish(new Error("The helper finished without a reply."));
		finish();
	});
	// Stdin avoids OS argument-size limits and exposing the full request in ps.
	child.stdin.end(options.task);
	return promise;
}
