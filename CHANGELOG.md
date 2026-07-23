# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.2.0]: https://github.com/pbnj/pi-glean-chat/releases/tag/v1.2.0
[1.1.0]: https://github.com/pbnj/pi-glean-chat/releases/tag/v1.1.0
[1.0.0]: https://github.com/pbnj/pi-glean-chat/releases/tag/v1.0.0
