import { readFileSync } from "node:fs";
import { isRecord } from "./guards.ts";

export const BASE_TOOLS = ["read", "grep", "glob"];
export const LSP_ACTIONS = ["definition", "type_definition", "implementation", "references", "hover", "symbols", "diagnostics", "status", "capabilities"];

export interface ResearchSettings {
	lsp: boolean;
	mcpTools: string[];
}

export interface ResearchTool {
	name: string;
	sourceInfo: { source: string };
	mcpServerName?: string;
	mcpToolName?: string;
	mcpReadOnlyHint?: boolean;
}

export interface McpGrant {
	name: string;
	server: string;
	tool: string;
}

export interface ResearchPolicy {
	lsp: boolean;
	mcpTools: McpGrant[];
}

export function parseSettings(value: unknown): ResearchSettings {
	if (!isRecord(value) || Object.keys(value).some(key => key !== "lsp" && key !== "mcpTools")) {
		throw new Error("Expected an object containing only lsp and mcpTools.");
	}
	const { lsp = true, mcpTools = [] } = value;
	if (typeof lsp !== "boolean" || !Array.isArray(mcpTools) || mcpTools.some(name => typeof name !== "string" || !/^mcp__[a-z0-9_]+$/.test(name))) {
		throw new Error('Expected { "lsp": true, "mcpTools": ["mcp__server_tool"] }; MCP names must be exact, without wildcards.');
	}
	return { lsp, mcpTools: [...new Set<string>(mcpTools)] };
}

export function loadSettings(path: string): ResearchSettings {
	let text: string;
	try { text = readFileSync(path, "utf8"); }
	catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return { lsp: true, mcpTools: [] };
		throw error;
	}
	try { return parseSettings(JSON.parse(text)); }
	catch (error) { throw new Error(`Invalid ${path}: ${error instanceof Error ? error.message : String(error)}`); }
}

export function resolvePolicy(settings: ResearchSettings, tools: readonly ResearchTool[]): ResearchPolicy {
	const mcpTools = settings.mcpTools.map(name => {
		const tool = tools.find(candidate => candidate.name === name);
		if (tool?.sourceInfo.source !== "mcp" || !tool.mcpServerName || !tool.mcpToolName) {
			throw new Error(`${name} is not an available MCP tool. Use /better-tools to inspect registered tools.`);
		}
		if (tool.mcpReadOnlyHint !== true) throw new Error(`${name} does not declare readOnlyHint: true; it cannot be granted to /better.`);
		return { name, server: tool.mcpServerName, tool: tool.mcpToolName };
	});
	return { lsp: settings.lsp, mcpTools };
}

export function loadPolicy(path: string): ResearchPolicy {
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isRecord(value) || typeof value.lsp !== "boolean" || !Array.isArray(value.mcpTools)) throw new Error("Invalid helper policy snapshot.");
	const mcpTools = value.mcpTools.map((grant: unknown): McpGrant => {
		if (!isRecord(grant) || typeof grant.name !== "string" || !/^mcp__[a-z0-9_]+$/.test(grant.name) || typeof grant.server !== "string" || !grant.server || typeof grant.tool !== "string" || !grant.tool) {
			throw new Error("Invalid MCP grant in helper policy snapshot.");
		}
		return { name: grant.name, server: grant.server, tool: grant.tool };
	});
	return { lsp: value.lsp, mcpTools };
}

export function researchToolNames(policy: ResearchPolicy): string[] {
	// write is only an xd:// transport. Every filesystem/other URI write is denied
	// below, before dispatch; nested native calls are checked again by omp.
	return [...BASE_TOOLS, ...(policy.lsp ? ["lsp"] : []), ...policy.mcpTools.map(grant => grant.name), ...(policy.lsp || policy.mcpTools.length ? ["write"] : [])];
}

export function blockResearchCall(name: string, input: unknown, policy: ResearchPolicy, tools: readonly ResearchTool[]): { block: true; reason: string } | undefined {
	if (BASE_TOOLS.includes(name)) return;
	if (name === "write") {
		if (!isRecord(input) || typeof input.path !== "string" || !/^xd:\/\/(lsp|mcp__[a-z0-9_]+)$/.test(input.path) || typeof input.content !== "string") {
			return { block: true, reason: "The helper can use write only to dispatch approved research tools at exact xd:// device URLs; file and other URI writes are forbidden." };
		}
		name = input.path.slice("xd://".length);
		try { input = JSON.parse(input.content); }
		catch { return { block: true, reason: "Research device arguments must be a JSON object." }; }
		if (!isRecord(input)) return { block: true, reason: "Research device arguments must be a JSON object." };
	}
	if (name === "lsp") {
		if (policy.lsp && isRecord(input) && typeof input.action === "string" && LSP_ACTIONS.includes(input.action) && input.apply !== true) return;
		return { block: true, reason: `Only these read-only LSP actions are allowed when lsp is enabled: ${LSP_ACTIONS.join(", ")}. Renames, code actions, reloads and raw requests are forbidden.` };
	}
	const grant = policy.mcpTools.find(candidate => candidate.name === name);
	if (grant && isRecord(input)) {
		const tool = tools.find(candidate => candidate.name === name);
		if (tool?.sourceInfo.source === "mcp" && tool.mcpReadOnlyHint === true && tool.mcpServerName === grant.server && tool.mcpToolName === grant.tool) return;
		return { block: true, reason: `${name} no longer matches its approved MCP identity and readOnlyHint: true; the call is blocked.` };
	}
	return { block: true, reason: "This helper only reads files, performs approved LSP lookups, and calls explicitly granted read-only MCP tools. Shell execution, mutation and delegation are forbidden." };
}
