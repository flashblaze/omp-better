import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { blockResearchCall, loadPolicy, loadSettings, parseSettings, resolvePolicy, type ResearchTool } from "../policy.ts";

const search: ResearchTool = {
	name: "mcp__docs_search", sourceInfo: { source: "mcp" },
	mcpServerName: "docs", mcpToolName: "search", mcpReadOnlyHint: true,
};
const mutate: ResearchTool = {
	name: "mcp__docs_delete", sourceInfo: { source: "mcp" },
	mcpServerName: "docs", mcpToolName: "delete", mcpReadOnlyHint: false,
};
const tools = [search, mutate];
const policy = resolvePolicy(parseSettings({ mcpTools: [search.name] }), tools);

test("read-only LSP navigation is admitted but edits, previews, reloads and raw RPC are blocked", () => {
	assert.equal(blockResearchCall("lsp", { action: "definition", file: "catalog.ts", line: 3, symbol: "rankCatalog" }, policy, tools), undefined);
	assert.equal(blockResearchCall("lsp", { action: "diagnostics", file: "catalog.ts" }, policy, tools), undefined);
	for (const action of ["rename", "rename_file", "code_actions", "reload", "request", "future_action"]) {
		assert.equal(blockResearchCall("lsp", { action, apply: false, query: "workspace/executeCommand" }, policy, tools)?.block, true, action);
	}
	assert.equal(blockResearchCall("lsp", { action: "definition", apply: true }, policy, tools)?.block, true);
	assert.equal(blockResearchCall("lsp", { action: "hover" }, { lsp: false, mcpTools: [] }, tools)?.block, true);
});

test("MCP grants are per exact tool, not server, name pattern or read-only annotation alone", () => {
	assert.equal(blockResearchCall(search.name, { query: "rankCatalog" }, policy, tools), undefined);
	assert.equal(blockResearchCall(mutate.name, {}, policy, tools)?.block, true);
	const sibling = { ...search, name: "mcp__docs_list", mcpToolName: "list" };
	assert.equal(blockResearchCall(sibling.name, {}, policy, [...tools, sibling])?.block, true);
	assert.throws(() => resolvePolicy({ lsp: true, mcpTools: [mutate.name] }, tools), /readOnlyHint/);
	assert.throws(() => resolvePolicy({ lsp: true, mcpTools: ["mcp__missing_search"] }, tools), /not an available MCP/);
	assert.throws(() => resolvePolicy({ lsp: true, mcpTools: [search.name] }, [{ ...search, mcpReadOnlyHint: undefined }]), /readOnlyHint/);
});

test("a reconnected MCP tool must retain its read-only hint, provenance and original identity", () => {
	for (const changed of [
		{ ...search, mcpReadOnlyHint: false },
		{ ...search, mcpReadOnlyHint: undefined },
		{ ...search, mcpServerName: "other-server" },
		{ ...search, mcpToolName: "execute" },
		{ ...search, sourceInfo: { source: "extension" } },
	]) {
		assert.equal(blockResearchCall(search.name, {}, policy, [changed])?.block, true);
	}
	assert.equal(blockResearchCall(search.name, {}, policy, [])?.block, true);
});

test("xd transport preserves the same LSP/MCP policy and cannot write to files or other devices", () => {
	assert.equal(blockResearchCall("write", { path: "xd://lsp", content: JSON.stringify({ action: "hover", file: "catalog.ts", line: 3 }) }, policy, tools), undefined);
	assert.equal(blockResearchCall("write", { path: `xd://${search.name}`, content: '{"query":"sort"}' }, policy, tools), undefined);
	for (const input of [
		{ path: "catalog.ts", content: "overwritten" },
		{ path: "local://scratch.ts", content: "overwritten" },
		{ path: "cfg://memory/backend", content: "off" },
		{ path: "agent://all", content: "implement this" },
		{ path: "xd://bash", content: '{"command":"touch sentinel"}' },
		{ path: "xd://lsp", content: '{"action":"rename","apply":false}' },
		{ path: "xd://lsp?query=anything", content: '{"action":"hover"}' },
		{ path: "xd://lsp:raw", content: '{"action":"hover"}' },
		{ path: `xd://${mutate.name}`, content: "{}" },
		{ path: "xd://lsp", content: "[]" },
		{ path: "xd://lsp", content: "invalid JSON" },
	]) assert.equal(blockResearchCall("write", input, policy, tools)?.block, true, input.path);
	for (const name of ["bash", "powershell", "eval", "edit", "task", "ast_edit", "debug", "learn"]) {
		assert.equal(blockResearchCall(name, {}, policy, tools)?.block, true, name);
	}
});

test("user settings reject wildcards, misspelled keys and non-MCP names", () => {
	for (const value of [null, [], { lsp: "yes" }, { mcpTools: ["mcp__docs_*"] }, { mcpTools: ["bash"] }, { mcpTool: [search.name] }, { mcpTools: [1] }]) {
		assert.throws(() => parseSettings(value));
	}
	assert.deepEqual(parseSettings({ lsp: false, mcpTools: [search.name, search.name] }), { lsp: false, mcpTools: [search.name] });
});

test("absent settings grant no MCP tools, corrupt settings fail closed and the helper uses frozen grants", () => {
	const directory = mkdtempSync(join(tmpdir(), "omp-better-policy-test-"));
	try {
		const settings = join(directory, "omp-better.json");
		assert.deepEqual(loadSettings(settings), { lsp: true, mcpTools: [] });
		writeFileSync(settings, "{broken");
		assert.throws(() => loadSettings(settings), /Invalid/);
		const snapshot = join(directory, "policy.json");
		writeFileSync(snapshot, JSON.stringify(policy));
		writeFileSync(settings, '{"lsp":false,"mcpTools":[]}');
		assert.deepEqual(loadPolicy(snapshot), policy);
		writeFileSync(snapshot, '{"lsp":true,"mcpTools":[{"name":"mcp__docs_*","server":"docs","tool":"search"}]}');
		assert.throws(() => loadPolicy(snapshot), /Invalid MCP grant/);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});
