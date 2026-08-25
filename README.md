# pi-glean-chat

pi extension providing Glean AI access via `@gleanwork/api-client`.

## Install

```bash
pi install git:github.com/pbnj/pi-glean-chat
```

pi clones the repo, runs `npm install`, and loads the extension. To try it
without installing:

```bash
pi -e git:github.com/pbnj/pi-glean-chat
```

Set the backend URL (shell profile):

```bash
export GLEAN_BACKEND_URL="https://mycompany-be.glean.com"
```

Authenticate in pi:

```plaintext
/login
# select "Subscription", then "Glean (SSO via OAuth)" for browser-based SSO login (recommended),
# or select glean and paste a Glean Client API token
```

OAuth uses Glean's OAuth 2.1 Authorization Server (Authorization Code + PKCE,
scopes `chat offline_access`). The extension registers itself as a public
client via Dynamic Client Registration, opens your browser for SSO, and pi
stores and auto-refreshes the tokens in `~/.pi/agent/auth.json`. Requires the
Glean admin to have enabled the OAuth Authorization Server (Admin Console →
Settings → Third-party access). If DCR is restricted on your tenant, fall back
to an API key.

Alternatively, export `GLEAN_API_TOKEN` or run `/login` then select API Key and
enter the API key.

## Tests

```bash
npm test
```

Unit tests (`index.test.ts`) run with the built-in Node test runner (Node >=
23.6 for native type stripping). They cover request building (most-recent-first
ordering, author mapping, merging, context stripping), ND-JSON stream parsing
(fragment reassembly per messageId, thinking/text interleaving, citations,
errors, abort), the OAuth flow (DCR, PKCE code exchange, refresh), and the
hand-off commands (transcript rendering, `saveChat`, chat-link derivation,
loading a chat back in) against a mock Glean backend.

## Environment variables

| Variable                     | Required | Description                                                               |
| ---------------------------- | -------- | ------------------------------------------------------------------------- |
| `GLEAN_BACKEND_URL`          | one of   | Full backend URL, e.g. `https://mycompany-be.glean.com`                   |
| `GLEAN_INSTANCE`             | one of   | Instance name, e.g. `mycompany` — used when `GLEAN_BACKEND_URL` is absent |
| `GLEAN_API_TOKEN`            | no       | Glean Client API token — overrides the token stored in `auth.json`        |
| `GLEAN_ENABLE_MODEL_SURFACE` | no       | Set to `0` to disable the provider/model surface                          |
| `GLEAN_REASONING_MODE`       | no       | Default reasoning mode: `advanced` or `auto` (default `auto`)             |
| `GLEAN_WEB_URL`              | no       | Glean web app URL used to build chat links (default `https://app.glean.com`) |
| `GLEAN_SAVE_CHATS`           | no       | Set to `1` to persist every tool / `/glean` request as a Glean chat       |
| `GLEAN_TRANSCRIPT_MAX_CHARS` | no       | Cap on the transcript `/glean-save` sends (default `60000`)               |

## Surfaces

### Tool: `glean_chat`

The LLM can call `glean_chat` to answer questions about internal knowledge.
Conversations are threaded — follow-up calls continue the same Glean chat
session via `chatId`. Pass `new_conversation: true` to start a fresh thread.

Pass `reasoning: "ADVANCED"` for deep-research questions; omit it to use the
session/env reasoning mode. This is a per-call override of the mode set by
`/glean-mode` or `GLEAN_REASONING_MODE`.

The tool's `promptGuidelines` instruct the model to use it for internal docs,
runbooks, policies, ADRs, Jira tickets, and Confluence pages.

The answer **streams into the TUI** as Glean produces it: progress lines
(`UPDATE`/`HEADING`) show while Glean is searching, then the answer text fills in
incrementally instead of appearing all at once when the call completes. The tool
row shows a compact tail while streaming (press the tool-expand key for the full
text) and the complete answer once settled. Cancelling the turn aborts the HTTP
request and returns whatever partial answer had arrived.

### Command: `/glean <question>`

Direct query without an LLM round-trip. The answer is injected as a displayed
session message so subsequent LLM turns can reference it.

```plaintext
/glean what is our PTO policy?
/glean --new what does the incident runbook say about P0 escalation?
```

`--new` clears the current `chatId` and starts a fresh conversation thread.

### Hand-off: `/glean-save`, `/glean-url`, `/glean-load`

Chats created through the Glean API are **transient** unless `saveChat` is set —
they have a `chatId` but no page on glean.com. These three commands make the
round trip explicit.

```plaintext
/glean-save                      # push this session to Glean, print the link
/glean-save --new                # into a fresh Glean chat, not the current thread
/glean-save --full               # ignore the transcript size cap
/glean-save summarize the open questions   # your own instruction instead of the default
/glean-url                       # print (and copy) the link for the current chat
/glean-load <chatId | URL>       # pull a Glean chat back into this session
```

`/glean-save` renders the current session branch as a markdown transcript and
sends it as a single `USER` message with `saveChat: true`. User and assistant
prose is kept; tool calls collapse to one-line markers (`_[tool: bash — npm
test]_`) and tool output, thinking blocks, and the system prompt are dropped.
Answers previously injected by `/glean` are included. When the transcript exceeds
`GLEAN_TRANSCRIPT_MAX_CHARS` (default 60 000) the **oldest** turns are dropped
first and the message says so. Glean's reply — by default a recap of where you
left off — plus the chat link are injected into the session, and the link is
copied to the clipboard.

`/glean-load` accepts a bare chat id or any `…/chat/<id>` URL, injects the web
conversation into the local session, and adopts its `chatId`, so subsequent
`glean_chat` / `/glean` calls continue that same Glean chat.

Chat links point at `https://app.glean.com/chat/<chatId>` — the web app is served
from that one host, not a per-tenant one. Glean's API exposes no link for a Chat,
so this is a convention rather than a contract; override it with `GLEAN_WEB_URL`
if your tenant differs.

### Command: `/glean-mode [advanced|auto]`

View, set, or toggle the reasoning mode used for every Glean chat request
(applies to the tool, the `/glean` command, and the model surface). The mode maps
to Glean's `agentConfig.agent`:

| Mode       | Behavior                                                        |
| ---------- | -------------------------------------------------------------- |
| `advanced` | Agentic engine; thinks longer, more LLM calls, higher quality  |
| `auto`     | Agentic engine; routes reasoning effort by question/context    |

```plaintext
/glean-mode              # toggle to the other mode and report it
/glean-mode advanced     # set a specific mode
```

With no argument the command toggles between `advanced` and `auto`. The
selection is persisted in session state and survives `/reload`. The startup
default comes from `GLEAN_REASONING_MODE` (or `auto` if unset, or if it names
an unknown mode). These agents require the agentic engine to be enabled in your
Glean deployment.

Glean's `FAST` agent is not exposed by this extension: it is unreliable enough
to return erroneous answers, so neither the LLM nor `/glean-mode` can select it.
A `FAST` value left over in an old session or in `GLEAN_REASONING_MODE` is
ignored and falls back to `auto`.

While the `glean / Glean Assistant` model is selected, the footer is replaced
with a compact Glean footer whose model line reads
`(glean) glean-assistant • <mode>`, mirroring the built-in
`model • thinking-level` indicator. Glean's API exposes no token/context/cost
data, so those stats are omitted. Switching to any other model restores pi's
built-in footer.

### Model: `glean / Glean Assistant`

Selectable via `Ctrl+P` or `/model`. Routes the active conversation through
Glean Chat instead of a normal LLM. Registered only when `GLEAN_BACKEND_URL` or
`GLEAN_INSTANCE` is set at startup.

Streaming is real: the provider calls `/rest/api/v1/chat` with `stream: true`
and parses ND-JSON lines as they arrive. Glean `UPDATE`/`HEADING` progress
messages render as thinking blocks; `CONTENT` messages stream as text; citations
are appended as a Sources block.

**Limitations — read before using:**

- **No tool calling.** Glean returns prose + citations only. This model cannot
  run `bash`, `read`, `edit`, or any other tool. Do not use it for coding tasks.
- **Context is stripped.** pi's system prompt, tool schemas, and tool-result
  messages are dropped. Only user/assistant text turns reach Glean.
- **No token accounting.** Glean returns no usage data; cost tracking stays
  zero.

Disable with `GLEAN_ENABLE_MODEL_SURFACE=0` if you want only the tool/command
surfaces.

## Conversation threading

`chatId` is tracked in extension memory and persisted via `pi.appendEntry` so
the thread survives `/reload`. It is shared between the tool and the `/glean`
command. The provider (model) surface does not use `chatId` — it forwards the
full conversation history to Glean on every turn.

Whether a thread is *saved* is tracked alongside the `chatId`: `/glean-save` and
`/glean-load` always mark it saved, the tool and `/glean` do so only under
`GLEAN_SAVE_CHATS=1`. `/glean-url` refuses to hand out a link for an unsaved
thread rather than printing one that 404s.

## Token source

Credentials are resolved in this order:

1. pi auth storage (`~/.pi/agent/auth.json`, managed by `/login`) — OAuth
   tokens are refreshed automatically; API keys are used as-is
2. `GLEAN_API_TOKEN` env var

The model surface receives the resolved token from pi's provider registry via
`options.apiKey`. The tool and command resolve through pi's model registry when
available, falling back to env / `auth.json` directly.
