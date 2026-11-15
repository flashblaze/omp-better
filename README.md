# omp-better

A standalone oh-my-pi extension inspired by [pi-better](https://github.com/nicobailon/pi-better) and Felix Rieseberg's [Depth prompt](https://felixrieseberg.com/how-to-be-more-ambitious-a-tutorial-for-humans-with-models/#depth).

`/better <request>` researches the project and rewrites the request into a deeper, repo-grounded prompt. The result goes into the TUI composer; nothing is submitted automatically. Bare `/better` deepens the current unresolved task, including the latest feedback.

## Install

Requires **omp 18.20.2 or newer** and an authenticated GitHub CLI account with access to this private repository. No npm install or build is needed.

```sh
# Authenticate first if needed: gh auth login
gh repo clone flashblaze/omp-better
cd omp-better
omp plugin link "$PWD"
```

The link uses this checkout directly, so keep it at that location. Restart any running omp sessions to load the extension. Then open omp in the project you want to work on:

```sh
omp
```

Select a provider/model with `/login` and `/model` if you have not already configured one. Enter `/better <request>` in omp's composer, review the rewritten prompt, then press Enter yourself.

To load it for just one session instead of installing, pass the absolute checkout path:

```sh
omp -e /absolute/path/to/omp-better/index.ts
```

To update a linked checkout, run `git pull --ff-only` from that checkout and restart omp. Uninstall with:

```sh
omp plugin uninstall omp-better
```

## Use

- `/better make the error messages actionable` — research and rewrite a request.
- `/better` — rewrite the current unresolved task from the active conversation branch.
- `/better-cancel` or **Ctrl+Alt+B** — stop only the rewrite, not the main agent.
- `/better-tools` — list registered MCP tool names, original identities, read-only hints and configured grants.

The helper runs in the background in the TUI. Two widget rows show the latest read/search, elapsed time, and tool count. Keep chatting or composing a draft; when the result arrives it is placed above the current draft. Review and edit it, then press Enter yourself.

Esc keeps omp's normal behavior; the extension does not intercept dialogs, patch the editor, or interfere with double-Esc rewind. Only one rewrite per session is allowed. Switching sessions, branching, navigating the tree, or shutting down cancels the rewrite rather than delivering it to a different context.

Print/JSON/RPC/ACP calls wait for completion and receive a displayed `omp-better.rewrite` custom message. RPC drafts are not overwritten because omp cannot read the remote editor's current contents. No model turn is triggered by delivery.

## Research permissions

Read-only LSP queries are enabled by default. Allowed actions: `definition`, `type_definition`, `implementation`, `references`, `hover`, `symbols`, `diagnostics`, `status`, and `capabilities`. Rename, rename-file, code actions (including previews), reload, and raw LSP requests are blocked. The helper uses private language-server clients and disables format-on-write.

MCP access is **off by default**. Configure the active agent directory's `omp-better.json` (normally `~/.omp/agent/omp-better.json`; profiles use their own agent directory):

```json
{
  "lsp": true,
  "mcpTools": []
}
```

To grant a particular MCP research tool:

1. Run `/better-tools` and inspect the exact runtime name, original server/tool identity, and `readOnlyHint`.
2. Review the server and tool semantics yourself. Add only its exact runtime name to `mcpTools`. Server-wide grants and wildcards are rejected.
3. The tool must also declare `readOnlyHint: true`. Missing/false hints, unknown tools, malformed settings and misspelled setting keys are rejected; an allowlist entry never overrides that requirement.

Only this user-owned settings file grants permissions; a repository-local settings file cannot widen them. Settings are read on each `/better` invocation, then frozen into a private policy snapshot. The helper rechecks live MCP provenance, original server/tool identity and read-only hint on every call. Reconnects or name collisions cannot silently substitute another tool. A granted tool missing from the helper at prompt time stops that helper with an explicit error.

Set `"lsp": false` to disable LSP research. Tools still need their normal omp/server configuration; this extension does not install language servers or configure MCP credentials.

`write` can appear in the helper's tool catalog solely as the transport for exact approved `xd://lsp` and `xd://mcp__...` device URLs. File, `local://`, configuration, coordination, shell-device and unapproved MCP writes are blocked before dispatch. Nested device calls receive the same policy checks.


## How it works

1. Snapshot the active branch and current system prompt in a private temporary directory. This also works with a lazy or `--no-session` parent, without materializing the parent session.
2. Copy any existing session artifacts into the private snapshot so inherited artifact references remain resolvable. Large artifact trees add startup time and temporary disk usage.
3. Start a separate headless omp process on the current model and thinking level, with the same agent-directory/profile/config scope. Its snapshot has a new session identity; the original transcript is never opened for writing.
4. Explicitly load this extension with `--trusted-extension` and expose file readers, permitted LSP queries, and approved MCP tools. The helper-side hook enforces the operation-level policy, including device dispatch. Ambient extension modules do not load; automatic memory learning, advisor work, and recap generation are disabled in the helper.
5. Ask the four Depth questions: professional methods, primary evidence, concrete tools, and an independent correctness check. Read the repo, then produce a rewritten prompt—not an implementation.
6. Parse unique per-run delimiter lines and place only the rewritten prompt in the composer. Numbered reasoning and the result are retained as a non-LLM custom session entry, not injected into the main model context.
7. Delete the private snapshot on success, failure, cancellation, or normal shutdown. Cancellation and the ten-minute deadline escalate SIGTERM to SIGKILL. On POSIX the helper process group, including remaining private LSP/MCP subprocesses, is stopped when the helper closes.

## Safety and limits

- No shell, eval, editing, arbitrary file writing, delegation or mutation-oriented LSP calls are allowed. Unlike pi-better's bash/powershell access, shell restrictions here do not depend on the prompt. The helper cannot run verification commands; it identifies commands for the eventual implementer instead.
- This is a tool-call policy, not an operating-system sandbox. omp and its readers run as your user, can read outside the project, can fetch URLs, and write runtime/session bookkeeping. Configured language servers and MCP processes remain trusted: an MCP read-only hint is a server assertion, not proof, and omp's native LSP client can accept server-initiated workspace edits even during a lookup. This allowlist does not protect against a malicious or misbehaving server. Normal omp startup may initialize configured MCP connections/processes even when none of their tools are granted.
- Conversation snapshots and project evidence are sent to the selected model provider, just like a normal omp turn. The helper uses existing credentials; it makes billable model calls.
- The provider cache identity is carried over, but the restricted tool catalog and flattened system-prompt blocks differ from the parent. Cache hits are **not guaranteed**. Safety takes priority over matching the original tool catalog.
- The snapshot contains completed messages, not the main agent's partial streaming text. Repo files are live: concurrent edits can make research stale. Review the result before sending it.
- Model-generated prompts may still be wrong or over-prescriptive. The helper is instructed to preserve scope and distinguish missing evidence from established facts.
- If output delimiters are missing/empty, the full reply is saved in a separate private `omp-better-reply-*/reply.md` temporary directory. The error names the path. It may contain project details; remove that directory after inspection. The conversation snapshot is still deleted.
- Abrupt SIGKILL or power loss can leave an `omp-better-*` snapshot directory under the OS temp directory. It is private (directory mode 0700; snapshot/system/config files 0600). Remove it once no helper is running.
- Windows does not have POSIX process groups; only the direct helper process is killed there. Windows has not been verified.
- A model defined only by a parent extension cannot be recreated in the isolated helper; configure it in your agent's model/provider configuration instead.

Automatic subagent-brief rewriting and boomerang mode are intentionally not included. They add latency and lifecycle risks without improving the explicit review-before-send flow.

## Development

```sh
node --test test/*.test.ts
```

Requires Node with TypeScript stripping and `Promise.withResolvers` (Node 24+ recommended). Tests cover output parsing, process supervision, LSP operation restrictions, exact MCP grants, metadata/identity changes, malformed settings, and device-dispatch bypass attempts. They do not require an installed SDK package or provider credentials.
