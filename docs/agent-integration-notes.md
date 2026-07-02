# Driving Codex CLI and OpenCode programmatically (adapter reference)

Research notes for the multi-agent adapter layer (Phase 2), verified 2026-07 against the local
`codex` 0.141.0 binary (`codex app-server generate-json-schema` bundle) and OpenCode v1.17.13
source (`anomalyco/opencode`, dev branch). Treat the installed binary / live `GET /doc` OpenAPI
as final authority when versions move.

Normalization target for every adapter:
`init(sessionId) · assistantTextDelta · assistantText · thinking · toolUse(name,input) ·
toolResult(output,isError) · usage(tokens) · turnDone · error`

---

## Codex CLI — use `codex app-server` (JSON-RPC 2.0 over stdio, one JSON object per line)

Same interface the official VS Code extension uses. Long-lived process per host, multiplexes many
threads; text deltas, reasoning deltas, exec-output deltas, token usage, interrupt, and real
approval round-trips. `codex exec --json` is the no-approvals fallback (JSONL, item-level only,
no text deltas, one process per turn, resume via `codex exec resume <uuid>`). Skip `mcp-server`.
Note: `codex exec` has NO `--ask-for-approval` in 0.141.0 (web docs are wrong) — exec cannot prompt.

Handshake (required first):

```json
{"id":0,"method":"initialize","params":{"clientInfo":{"name":"corral","title":"Corral","version":"1.0.0"},"capabilities":{"experimentalApi":false}}}
{"method":"initialized","params":{}}
```

Session + turn:

```json
{"id":1,"method":"thread/start","params":{"cwd":"/home/me/proj","model":"gpt-5.3-codex","approvalPolicy":"on-request","sandbox":{"type":"workspaceWrite","networkAccess":false,"writableRoots":[]}}}
{"id":2,"method":"turn/start","params":{"threadId":"thr_123","input":[{"type":"text","text":"Run the tests"}]}}
```

Key notifications → normalized events:

| notification | normalized |
|---|---|
| `thread/start` / `thread/resume` result (`thread.id`) | `init` |
| `item/agentMessage/delta` | `assistantTextDelta` |
| `item/completed` with `item.type=="agentMessage"` | `assistantText` |
| `item/reasoning/summaryTextDelta` | `thinking` |
| `item/started` type `commandExecution`/`mcpToolCall`/`fileChange`/`webSearch` | `toolUse` |
| matching `item/completed` (`isError` = `status=="failed"` \|\| `exitCode!==0` \|\| `mcpToolCall.error`) | `toolResult` |
| `item/commandExecution/outputDelta` | live tool output |
| `thread/tokenUsage/updated` (`tokenUsage.total.{inputTokens,cachedInputTokens,outputTokens}`, `modelContextWindow`) | `usage` |
| `turn/completed` (`turn.status`: completed \| interrupted \| failed) | `turnDone` |
| `error` (`willRetry`, `error.message`) | `error` |

Ignore unknown methods (new ones appear often). Item union also includes: `userMessage`,
`dynamicToolCall`, `collabAgentToolCall`, `subAgentActivity`, `imageView`, `plan`, `todo`-ish
extras, `contextCompaction`, review-mode markers.

**Approvals** arrive as server→client JSON-RPC *requests* (they carry an `id`; turn blocks until
answered):
- `item/commandExecution/requestApproval` — `{itemId, threadId, turnId, command?, cwd?, reason?, ...}`
- `item/fileChange/requestApproval`
- respond: `{"id":<same>,"result":{"decision":"accept"|"acceptForSession"|"decline"|"cancel"}}`
  (`cancel` = deny + interrupt). `serverRequest/resolved` notified after.

Policies: `approvalPolicy` = `untrusted | on-request | never` (+deprecated `on-failure`); sandbox =
`read-only | workspace-write | danger-full-access`. Interrupt: `turn/interrupt {threadId,turnId}`.
Multi-turn: repeat `turn/start` on the same pipe; `turn/steer` to redirect a running turn.

**Resume:** rollouts at `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`
(`~/.codex` default). app-server: `thread/resume {threadId}`; also `thread/list`, `thread/read`,
`thread/fork`, `thread/archive` for a session picker.

**Auth:** `$CODEX_HOME/auth.json`. ChatGPT plan: `codex login` / `codex login --device-auth`
(headless); status via `codex login status` (non-zero exit when logged out). Remote hosts: copy
`~/.codex/auth.json` (tokens auto-refresh). API-key mode: `codex login --with-api-key` or
`CODEX_API_KEY` env — do NOT pass `CODEX_API_KEY` to children if the user intends subscription
billing (mirror of the ANTHROPIC_API_KEY scrub for claude).

**Windows/SSH:** native .exe, plain pipes, no PTY. Spawn the resolved `codex.exe` (the npm `codex.cmd`
shim needs shell:true). Remote: `ssh host codex app-server` (no `-t`) or wrap in `bash -lc` for PATH.
Windows sandboxing is new (restricted tokens; `windowsSandbox/*` methods) — prefer
`approvalPolicy:"on-request"` + our UI as the guard.

---

## OpenCode — use `opencode serve` (HTTP + SSE, OpenAPI at `GET /doc`)

One server per host handles many project dirs — every endpoint takes `?directory=/abs/path`
(or `x-opencode-directory` header). `opencode run --format json` is one-shot only (completed
parts, no deltas, auto-rejects permission asks unless `--auto`).

```
opencode serve --port 4096 --hostname 127.0.0.1   # optional: OPENCODE_SERVER_PASSWORD basic auth
```

Flow: `GET /event` (SSE; first event `server.connected`) → `POST /session?directory=...`
`{"title":"...", "permission":[{"permission":"bash","pattern":"*","action":"ask"}]}` →
`POST /session/:id/prompt_async` (204; results via SSE):

```json
{"model":{"providerID":"anthropic","modelID":"claude-sonnet-4-5"},"parts":[{"type":"text","text":"Fix the failing test"}]}
```

SSE events → normalized (filter everything by `properties.sessionID`; stream is bus-wide):

| event | normalized |
|---|---|
| `POST /session` response / `session.created` | `init` |
| `message.part.delta` (`field=="text"`) | `assistantTextDelta` (also handle full-part updates) |
| `message.part.updated` text part with `time.end` | `assistantText` |
| `reasoning` part (same delta path) | `thinking` |
| `tool` part entering `state.status=="running"` (`part.tool`, `state.input`) | `toolUse` |
| same part at `completed`/`error` (`state.output` / `state.error`) | `toolResult` |
| assistant `message.updated` `info.tokens` + `info.cost` | `usage` |
| `session.status` → `{type:"idle"}` | `turnDone` |
| `session.error` | `error` |

Part types: `text`, `reasoning`, `tool` (`pending→running→completed|error`), `file`, `step-start`,
`step-finish` (per-step cost/tokens), `snapshot`, `patch`, `retry`, `compaction`, `subtask`.

**Permissions:** per-session ruleset injected at `POST /session` (`action: allow|ask|deny`, glob
patterns, last match wins) — forces `ask` without touching user config. `permission.asked` SSE
event → reply `POST /session/:sessionID/permissions/:permissionID` `{"response":"once"|"always"|"reject"}`
(newer alt: `POST /permission/:requestID/reply` with optional `message` feedback to the model).
Interrupt: `POST /session/:id/abort`. Multi-turn: another `prompt_async` on the same session
(server queues while busy).

**Resume:** plain JSON storage under `~/.local/share/opencode/storage/`
(`session/<projectID>/<id>.json`, `message/<sessionID>/*.json`, `part/<messageID>/*.json` —
same dotted path on Windows). After restart: `GET /session?directory=...` lists,
`GET /session/:id/message` replays, `prompt_async` continues. IDs stable (`ses_*`).

**Auth:** `opencode auth login` → `~/.local/share/opencode/auth.json`; provider env vars
(`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, ...) picked up automatically — decide explicitly what env
the child gets. Models are `{providerID, modelID}`. NOTE: docs themselves say Anthropic prohibits
third-party clients on Pro/Max subscriptions — prefer API keys for OpenCode.

**Install:** Windows `choco install opencode` / `scoop install opencode` / `npm i -g opencode-ai`;
Linux `curl -fsSL https://opencode.ai/install | bash`. Repo moved: `github.com/anomalyco/opencode`.

**SSH remotes:** run serve on the remote loopback + `ssh -L` tunnel (we already have tunnel
infrastructure); SSE needs keep-alives over flaky links — on reconnect re-`GET /event` and
reconcile via `GET /session/:id/message`.

---

## Confidence

High: all Codex app-server method/approval shapes (local schema bundle), OpenCode event/permission
shapes (source). Medium: exact `codex exec --json` samples (docs-sourced), app-server JSONL framing
(confirm on first handshake), OpenCode delta granularity (handle both delta + full-part updates).
