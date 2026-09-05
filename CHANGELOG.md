# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.7.0](https://github.com/pbnj/pi-glean-chat/compare/v1.6.0...v1.7.0) (2026-09-05)


### Added

* expose glean as a models.json api provider ([#4](https://github.com/pbnj/pi-glean-chat/issues/4)) ([a46eba7](https://github.com/pbnj/pi-glean-chat/commit/a46eba771eb6d5311ba29bd0944897af21483408))
* show live progress while glean commands run ([#1](https://github.com/pbnj/pi-glean-chat/issues/1)) ([13cbf58](https://github.com/pbnj/pi-glean-chat/commit/13cbf5818fd7df30a6bc1e8e47388a0884886f69))

## [1.6.0] - 2026-08-25

### Added

- **Chat hand-off between pi and glean.com.** Every request the extension made
  was transient: Glean only persists a conversation when `saveChat` is set, so
  nothing done from pi appeared in Glean's web chat history and the `chatId` the
  extension threaded on could not be opened in a browser. Three commands close
  the loop:
  - `/glean-save [--new] [--full] [instructions]` renders the current session
    branch as a markdown transcript and sends it as a single `USER` message with
    `saveChat: true`, then injects Glean's recap and the chat link into the
    session and copies the link to the clipboard. One message rather than a
    replay of every turn: it costs one Glean answer, and the API does not
    document whether caller-supplied `GLEAN_AI` turns are persisted.
  - `/glean-url` prints and copies the link for the current chat, and says so
    plainly when the thread was never saved instead of handing out a dead link.
  - `/glean-load <chatId | URL>` pulls a Glean web chat into the session and
    adopts its `chatId`, so `glean_chat` and `/glean` continue that thread.
- The transcript keeps user and assistant prose, collapses tool calls to
  one-line markers (`_[tool: bash — npm test]_`), and drops tool output,
  thinking blocks, and the system prompt — Glean acts on prose, and a hand-off
  needs to convey what was asked, answered, and touched, not replay the tools.
  Over `GLEAN_TRANSCRIPT_MAX_CHARS` (default 60 000) the **oldest** turns are
  dropped first, since a hand-off cares where the conversation ended up.
- `GLEAN_SAVE_CHATS=1` makes the `glean_chat` tool and `/glean` persist their
  chats too, so any thread started from pi is resumable on the web. Off by
  default: otherwise every question the LLM asks mid-task lands in the user's
  Glean chat history.
- Chat links point at `https://app.glean.com/chat/<chatId>`; the web app is
  served from that one host, not a per-tenant one (a host derived from the
  backend URL, `https://<instance>.glean.com`, does not reach the chat page).
  Glean's API exposes no link for a Chat, so this is a convention rather than a
  contract — `GLEAN_WEB_URL` (env or `auth.json`) overrides it.

## [1.5.0] - 2026-08-17

### Added

- The Glean backend URL now falls back to the `glean` entry in
  `~/.pi/agent/auth.json` (`env.GLEAN_BACKEND_URL`, `env.GLEAN_INSTANCE`, or a
  bare `backendUrl` / `instance`) when neither environment variable is set,
  mirroring how pi already stores provider-local settings such as the
  `llama.cpp` entry's `env.LLAMA_BASE_URL`. Environment variables still win.
  The model surface registers only when a URL resolves, so env-only resolution
  meant pi worked in an interactive shell but reported `Model "glean" not
  found` anywhere the profile had not been sourced — cron, launchd, a bare
  `env -i` — even with a valid credential already stored in `auth.json`. The
  auth entry is read on demand rather than cached, since `/login` and OAuth
  refresh rewrite the file mid-session, and `makeClient()` shares the same
  resolution so the tool and the provider cannot disagree about the backend.

### Removed

- **The `FAST` reasoning mode is gone.** Glean's `FAST` agent is unreliable
  enough to return erroneous answers, so it is no longer selectable from any
  surface: it is dropped from the `glean_chat` `reasoning` enum, from
  `/glean-mode` and its completions, and from the `GLEAN_REASONING_MODE`
  values. The remaining modes are `ADVANCED` and `AUTO` (still defaulting to
  `AUTO`), and `/glean-mode` with no argument now toggles between the two
  instead of cycling three.
- A `FAST` value surviving in persisted session state, in
  `GLEAN_REASONING_MODE`, or in a model-invented `reasoning` tool argument is
  ignored and falls back to the session/env default rather than reaching the
  retired agent.

## [1.4.0] - 2026-07-30

### Added

- `glean_chat` now **streams its answer into the TUI**. Previously the tool made
  a blocking, non-streaming API call and printed a static `Querying Glean...`
  line until the whole response arrived. It now uses the same ND-JSON streaming
  endpoint as the model surface and pushes partial tool results via `onUpdate`:
  Glean's `UPDATE`/`HEADING` progress lines show while it searches, then the
  answer text fills in as it is generated (throttled to ~80 ms per frame).
- A custom `renderResult` for `glean_chat`: while streaming, the tool row shows
  a dimmed tail of the last 8 lines so the transcript stays compact; the full
  answer renders once the call settles (or when the row is expanded).
- `glean_chat` honors the tool-call `AbortSignal`. Cancelling a turn now tears
  down the HTTP request instead of leaking it, and returns the partial answer
  received so far.

### Changed

- The ND-JSON reader is now a single shared core (`streamGleanChat`) consumed by
  both the model surface and the tool, replacing the duplicated parse loop and
  the tool's dependence on the Glean SDK's blocking `chat.create`. Citation
  collection and the trailing **Sources** block are shared as well, so both
  surfaces format answers identically.
- `@earendil-works/pi-tui` is now a peer dependency (used by `renderResult`).

## [1.3.1] - 2026-07-30

### Fixed

- `glean_chat` now works with OpenAI-compatible servers that only implement the
  JSON Schema `enum` keyword. The optional `reasoning` argument was declared as
  a union of literals, which TypeBox emits as `anyOf` + `const`. Cloud providers
  accept that, but grammar-constrained local runtimes (llama.cpp, vLLM, and
  similar self-hosted servers) reject the **entire request** — every turn failed
  with a terminated stream as soon as the tool was enabled, not just the tool
  call itself. The argument is now declared as `{ type: "string", enum: [...] }`,
  which is equivalent for every provider and portable across all of them. No
  change to the accepted values or to the tool's behavior.

## [1.3.0] - 2026-07-22

### Added

- `glean_chat` now accepts an optional `reasoning` argument (`FAST`, `ADVANCED`,
  or `AUTO`) so the model can pick the reasoning effort per call — e.g.
  `reasoning: ADVANCED` for deep-research questions or `reasoning: FAST` for
  quick answers. When omitted, the session/env reasoning mode (set via
  `/glean-mode` or `GLEAN_REASONING_MODE`) is used.

### Fixed

- `glean_chat` no longer returns an empty answer with only a **Sources** block.
  The tool extracted the answer from the *last* non-USER message, but Glean
  returns many non-`CONTENT` messages (UPDATE/HEADING/CONTROL_*/SERVER_TOOL/
  WARNING/etc.). When the final message was not `CONTENT`, the answer came back
  empty while citations were still appended. This happened more often in
  `ADVANCED`/agentic runs, which emit more intermediate messages. The answer is
  now assembled from every `CONTENT` message (matching the streaming path), with
  a fallback to the last non-USER message.

## [1.2.0] - 2026-07-22

### Changed

- Broadened the `glean_chat` tool description and prompt guidelines to make clear
  Glean AI searches **both internal/private resources** (Confluence, Jira, Linear,
  Slack, private GitHub repos, runbooks, policies, ADRs) **and external/public
  resources** on the internet (public docs, web pages, public GitHub repos).
- Added guidance to prefer asking Glean a specific question about a page (e.g.
  "review <url> and tell me how to import that resource") over requesting a raw
  dump, and to request exact content explicitly (e.g. "print the raw contents of
  <url>") only when genuinely needed.
- Updated README auth instructions: `/login` now selects "Subscription" then
  "Glean (SSO via OAuth)", and documented the API Key login flow.

## [1.1.0] - 2026-07-20

### Added

- Reasoning mode selection for Glean's agentic engine, applied to all three
  surfaces (`glean_chat` tool, `/glean` command, and the model surface) via
  `agentConfig.agent`.
- `/glean-mode [fast|advanced|auto]` command to view, set, or cycle the reasoning
  mode, with argument autocompletion. Running it with no argument cycles
  `fast -> advanced -> auto`. The selection is persisted in session state and
  survives `/reload`.
- `GLEAN_REASONING_MODE` environment variable to set the startup default
  (`fast`, `advanced`, or `auto`; defaults to `auto`).
- Footer integration for the reasoning mode: while the
  `glean / Glean Assistant` model is selected, the footer is replaced with a
  compact Glean footer whose model line reads `(glean) glean-assistant • <mode>`,
  mirroring the built-in `model • thinking-level` style. Glean exposes no
  token/context/cost data, so those stats are omitted. Switching to any other
  model restores pi's built-in footer.

## [1.0.0]

### Added

- Initial release of the pi-glean-chat extension.
- OAuth login via the Glean Authorization Server.

[1.5.0]: https://github.com/pbnj/pi-glean-chat/releases/tag/v1.5.0
[1.4.0]: https://github.com/pbnj/pi-glean-chat/releases/tag/v1.4.0
[1.3.1]: https://github.com/pbnj/pi-glean-chat/releases/tag/v1.3.1
[1.3.0]: https://github.com/pbnj/pi-glean-chat/releases/tag/v1.3.0
[1.2.0]: https://github.com/pbnj/pi-glean-chat/releases/tag/v1.2.0
[1.1.0]: https://github.com/pbnj/pi-glean-chat/releases/tag/v1.1.0
[1.0.0]: https://github.com/pbnj/pi-glean-chat/releases/tag/v1.0.0
