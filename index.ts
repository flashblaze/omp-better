import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { runHelper } from "./helper.ts";
import { buildTask, parsePrompt } from "./prompt.ts";
import { blockResearchCall, loadPolicy, loadSettings, researchToolNames, resolvePolicy, type ResearchPolicy } from "./policy.ts";

const CHILD_ENV = "OMP_BETTER_HELPER";
const POLICY_ENV = "OMP_BETTER_POLICY_FILE";
const ENTRY = "omp-better.rewrite";
const WIDGET = "omp-better";
const TIMEOUT_MS = 10 * 60 * 1000;

// Forward configuration scope, not prompts, credentials, session selectors or extensions.
function scopeArgs(argv: string[]): string[] {
	const result: string[] = [];
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--profile" || arg === "--config") {
			if (argv[i + 1]) result.push(arg, argv[++i]);
		} else if (arg.startsWith("--profile=") || arg.startsWith("--config=")) result.push(arg);
	}
	return result;
}

export default function (pi: ExtensionAPI) {
	if (process.env[CHILD_ENV] === "1") {
		// Explicit --trusted-extension makes this guard fail-closed on loading errors,
		// even when the parent loaded omp-better with -e rather than installation.
		const policyFile = process.env[POLICY_ENV];
		if (!policyFile) throw new Error("The helper requires an explicit research policy snapshot.");
		const policy = loadPolicy(policyFile);
		pi.on("tool_call", event => blockResearchCall(event.toolName, event.input, policy,
			event.toolName.startsWith("mcp__") || event.toolName === "write" ? pi.getAllTools() : []));
		pi.on("session_start", async () => { await pi.setActiveTools(researchToolNames(policy)); });
		pi.on("before_agent_start", () => {
			// Print-mode MCP startup finishes before prompting. A missing or changed
			// grant is an error, not a silent downgrade to weaker research.
			const tools = pi.getAllTools();
			for (const grant of policy.mcpTools) {
				const denied = blockResearchCall(grant.name, {}, policy, tools);
				if (denied) {
					// Ordinary hook exceptions are advisory in omp. Exit this isolated
					// helper before inference instead of pretending the grant exists.
					process.stderr.write(`Approved MCP research tool unavailable: ${denied.reason}\n`);
					process.exit(1);
				}
			}
		});
		return;
	}

	let running: { controller: AbortController; finished?: Promise<void> } | undefined;
	let generation = 0;
	let shutdown = false;

	const cancelOnNavigation = (_event: unknown, ctx: ExtensionContext) => {
		generation++;
		running?.controller.abort();
		ctx.ui.setWidget(WIDGET, undefined);
	};
	pi.on("session_switch", cancelOnNavigation);
	pi.on("session_branch", cancelOnNavigation);
	pi.on("session_tree", cancelOnNavigation);
	pi.on("session_shutdown", async () => {
		shutdown = true;
		generation++;
		running?.controller.abort();
		await running?.finished;
	});
	pi.registerShortcut("ctrl+alt+b", {
		description: "Cancel the background /better rewrite",
		handler: async (_ctx) => { running?.controller.abort(); },
	});
	pi.registerCommand("better-cancel", {
		description: "Cancel the background prompt rewrite without interrupting the main agent",
		handler: async (_args, ctx) => {
			if (running) running.controller.abort();
			else ctx.ui.notify("No /better rewrite is running.", "info");
		},
	});
	pi.registerCommand("better-tools", {
		description: "List MCP tool identities, read-only hints and /better grants",
		handler: async (_args, ctx) => {
			const path = join(pi.pi.getAgentDir(), "omp-better.json");
			const settings = loadSettings(path);
			const rows = pi.getAllTools().filter(tool => tool.sourceInfo.source === "mcp").map(tool =>
				`${tool.name} · ${tool.mcpServerName}/${tool.mcpToolName} · readOnlyHint=${String(tool.mcpReadOnlyHint ?? "missing")} · ${settings.mcpTools.includes(tool.name) ? "configured" : "not granted"}`);
			pi.sendMessage({
				customType: "omp-better.tools", display: true, attribution: "agent",
				content: `Research settings: ${path}\nLSP lookups: ${settings.lsp ? "enabled" : "disabled"}\nOnly exact MCP grants with readOnlyHint=true are usable.\n\n${rows.length ? rows.join("\n") : "No MCP tools are currently registered."}`,
			});
		},
	});
	pi.registerCommand("better", {
		description: "Deepen a prompt (or the current task) against the repo, then place an editable rewrite in the composer",
		handler: async (args, ctx) => {
			if (ctx.agent.kind !== "main") return ctx.ui.notify("Run /better in the main session, not a subagent.", "warning");
			if (running) return ctx.ui.notify("A rewrite is already running. Use /better-cancel or Ctrl+Alt+B to stop it.", "warning");
			if (!ctx.model) return ctx.ui.notify("Select a model with /model before using /better.", "error");
			const prompt = args.trim();
			const branch = ctx.sessionManager.getBranch();
			const hasTask = branch.some(entry => entry.type === "message" && entry.message.role === "user");
			if (!prompt && !hasTask) return ctx.ui.notify("No task to deepen yet. Use /better <prompt>.", "error");
			let policy: ResearchPolicy;
			try {
				policy = resolvePolicy(loadSettings(join(pi.pi.getAgentDir(), "omp-better.json")), pi.getAllTools());
			} catch (error) {
				return ctx.ui.notify(`/better: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
			const run = { controller: new AbortController(), finished: undefined as Promise<void> | undefined };
			running = run;
			const ownGeneration = generation;
			const sessionId = ctx.sessionManager.getSessionId();
			const started = Date.now();
			let stage = "Preparing a private snapshot";
			let tools = 0;
			const paint = () => {
				if (!shutdown && generation === ownGeneration && ctx.mode === "tui") ctx.ui.setWidget(WIDGET, [
					`/better · ${stage}`,
					`${Math.floor((Date.now() - started) / 1000)}s · ${tools} research calls · Ctrl+Alt+B or /better-cancel`,
				]);
			};
			paint();
			const timer = ctx.setInterval(paint, 1000);
			run.finished = (async () => {
				let directory: string | undefined;
				try {
					directory = mkdtempSync(join(tmpdir(), "omp-better-"));
					const snapshot = join(directory, "source.jsonl");
					const header = ctx.sessionManager.getHeader();
					if (!header) throw new Error("The current session has no header.");
					const cacheKey = header.providerPromptCacheKey || header.id;
					// Serialize the selected branch, not the last branch written to disk. This
					// also captures lazy/in-memory sessions without forcing parent persistence.
					writeFileSync(snapshot, [JSON.stringify({ ...header, id: randomUUID(), cwd: ctx.cwd, parentSession: header.id, providerPromptCacheKey: cacheKey }), ...branch.map(entry => JSON.stringify(entry))].join("\n") + "\n", { mode: 0o600 });
					const sourceFile = ctx.sessionManager.getSessionFile();
					const artifacts = sourceFile?.replace(/\.jsonl$/, "");
					if (artifacts && artifacts !== sourceFile && existsSync(artifacts)) cpSync(artifacts, join(directory, "source"), { recursive: true });
					const system = ctx.getSystemPrompt();
					const systemFile = join(directory, "system.txt");
					writeFileSync(systemFile, Array.isArray(system) ? system.join("\n\n") : system, { mode: 0o600 });
					const config = join(directory, "helper.yml");
					writeFileSync(config, `advisor:\n  enabled: false\nmemory:\n  backend: off\nautolearn:\n  enabled: false\nrecap:\n  enabled: false\nupdate:\n  auto: false\nlsp:\n  enabled: ${policy.lsp}\n  shared: false\n  formatOnWrite: false\nautoResume: false\n`, { mode: 0o600 });
					const policyFile = join(directory, "policy.json");
					writeFileSync(policyFile, JSON.stringify(policy), { mode: 0o600 });
					const request = buildTask(prompt);
					const env: NodeJS.ProcessEnv = { ...process.env, [CHILD_ENV]: "1", [POLICY_ENV]: policyFile, PI_CODING_AGENT_DIR: pi.pi.getAgentDir() };
					// A headless helper must not impersonate its parent's terminal or pane.
					for (const key of Object.keys(env)) {
						if (/^(ORCA_|HERDR_|TMUX|ZELLIJ|CMUX|PI_SESSION_|PI_TERMINAL_|PI_TOOL_CALL_ID)/.test(key)) delete env[key];
					}
					const runtime = /^(node|bun)(\.exe)?$/.test(basename(process.execPath).toLowerCase());
					const script = process.argv[1];
					const prefix = runtime && script && existsSync(script) ? [script] : [];
					const command = runtime && !prefix.length ? "omp" : process.execPath;
					stage = "Reading project files";
					const reply = await runHelper({
						command, prefix, cwd: ctx.cwd, env, task: request.task, signal: run.controller.signal, timeoutMs: TIMEOUT_MS,
						args: [...scopeArgs(process.argv), "--config", config, "--mode", "json", "-p", "--resume", snapshot,
							"--model", `${ctx.model.provider}/${ctx.model.id}`, "--thinking", pi.getThinkingLevel(),
							"--prompt-cache-key", cacheKey, "--system-prompt", systemFile,
							"--trusted-extension", fileURLToPath(import.meta.url), "--no-skills", "--no-rules", "--no-context-files", ...(!policy.lsp ? ["--no-lsp"] : []), "--no-title", "--no-prewalk", "--tools", researchToolNames(policy).join(",")],
						onProgress: stream => { stage = stream.stage; tools = stream.tools; },
					});
					if (run.controller.signal.aborted || shutdown || generation !== ownGeneration || ctx.sessionManager.getSessionId() !== sessionId) return;
					let improved: string;
					try { improved = parsePrompt(reply, request.open, request.close); }
					catch (error) {
						const recovery = mkdtempSync(join(tmpdir(), "omp-better-reply-"));
						const file = join(recovery, "reply.md");
						writeFileSync(file, reply, { mode: 0o600 });
						throw new Error(`${error instanceof Error ? error.message : String(error)} The full reply is saved in ${file}.`);
					}
					pi.appendEntry(ENTRY, { prompt, improved, reply });
					if (ctx.mode === "tui") {
						const draft = ctx.ui.getEditorText();
						ctx.ui.setEditorText(draft.trim() ? `${improved}\n\n${draft}` : improved);
						ctx.ui.notify(`The improved prompt is in your composer${draft.trim() ? ", above your existing draft" : ""}. Review it, then press Enter. Nothing was sent.`, "info");
					} else {
						// RPC cannot read its client's draft. Return a result instead of overwriting it.
						pi.sendMessage({ customType: ENTRY, content: improved, display: true, attribution: "agent" });
					}
				} catch (error) {
					if (!shutdown && generation === ownGeneration) ctx.ui.notify(`/better: ${error instanceof Error ? error.message : String(error)}`, run.controller.signal.aborted ? "info" : "error");
				} finally {
					ctx.clearTimer(timer);
					if (directory) {
						try { rmSync(directory, { recursive: true, force: true }); }
						catch (error) { if (!shutdown) ctx.ui.notify(`/better: remove the private snapshot manually: ${directory} (${String(error)})`, "warning"); }
					}
					if (running === run) running = undefined;
					if (!shutdown && generation === ownGeneration) ctx.ui.setWidget(WIDGET, undefined);
				}
			})();
			if (ctx.mode !== "tui") await run.finished;
		},
	});
}
