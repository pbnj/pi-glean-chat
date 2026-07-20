# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.1.0]: https://github.com/pbnj/pi-glean-chat/releases/tag/v1.1.0
