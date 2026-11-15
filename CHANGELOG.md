# Changelog

## 0.2.0 — 2026-11-15

- Enable read-only LSP navigation and diagnostics; block raw requests, reloads, renames and all code actions.
- Add user-owned `omp-better.json` research settings and `/better-tools` for MCP grant discovery.
- Require exact MCP grants plus `readOnlyHint: true`, with original server/tool identity pinned and revalidated at execution.
- Freeze grants per rewrite and fail explicitly when approved tools are unavailable in the helper.
- Apply the same checks to direct calls and approved `xd://` device dispatch; keep file writes, shell execution and delegation blocked.
- Stop remaining private helper process-group members, including LSP/MCP children.
- Document the trust boundary for language servers and MCP annotations.
- Verify 12 regression tests, strict SDK typechecking, real TypeScript definition/reference queries, a local MCP boundary fixture, blocked mutation attempts, missing-grant failure before inference, and a provider-backed rewrite using both research capabilities.

## 0.1.0 — 2026-11-15

- Add `/better <prompt>` and bare `/better` for repo-grounded prompt deepening.
- Research on a private active-branch snapshot in a separate omp process, with only read, grep and glob available to the model.
- Preserve a TUI draft beneath the rewrite and require explicit user submission.
- Show background progress and add `/better-cancel` and Ctrl+Alt+B.
- Cancel on session navigation/shutdown; enforce a ten-minute helper deadline and escalate process termination.
- Return a displayed result instead of overwriting RPC drafts.
- Preserve malformed replies in private recovery files and remove working snapshots after completion.
- Verify parser/process edge cases with six regression tests, strict typechecking against omp 18.20.2 declarations, a real provider-backed rewrite, and the real TUI composer with an existing draft.
