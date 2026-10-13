# pi-glean-chat (archived)

> [!WARNING]
> **This repository is archived and the extension is no longer maintained.**
> For new setups, use Pi's built-in `codemode` and Glean's hosted MCP server
> instead. You do not need to install this extension to use Glean from Pi.

`pi-glean-chat` previously added a Glean chat tool, `/glean` commands, and a
Glean-backed model/provider. Pi now connects to Glean through its built-in MCP
client, so this extension's custom Glean API integration is no longer the
recommended setup.

## Migrate to Glean MCP

### 1. Remove the extension

If you installed the package, remove it with:

```sh
pi remove git:github.com/pbnj/pi-glean-chat
```

### 2. Enable codemode

`codemode` is built into Pi; no separate package is needed. To keep it enabled
in every session, add `+codemode` to `defaultTools` in
`~/.pi/agent/settings.json`:

```json
{
  "defaultTools": ["+codemode"]
}
```

If `defaultTools` already exists, add `"+codemode"` to that array. This adds
codemode without replacing Pi's default tools. To enable it for one run instead,
use:

```sh
pi --tools +codemode
```

Pi also activates codemode when a configured MCP server uses the `codemode`
exposure (the default for MCP servers). The setting above makes codemode
available even when no MCP server is connected.

### 3. Connect Pi to Glean

A Glean administrator must enable an MCP server for your organization. In Glean,
open **Your settings → Third-party apps and MCP → Connect to your AI apps with
Glean MCP**, choose a server, and copy its URL. Use the exact URL shown there;
it is tenant- and server-specific. If the configurator is unavailable, ask your
Glean administrator for the MCP URL and access.

Add the remote server to Pi's user-level MCP configuration and sign in with
Glean SSO:

```sh
GLEAN_MCP_URL="PASTE_THE_URL_FROM_GLEAN_HERE"
pi mcp add glean --url "$GLEAN_MCP_URL" --exposure codemode
pi mcp login glean
pi mcp list
```

`pi mcp add` stores the server in `~/.pi/agent/mcp.json`; `pi mcp login`
completes OAuth sign-in and keeps credentials in Pi's local auth store. Do not
put access tokens in a project file or commit them. The Glean MCP URL commonly
has the form `https://<backend-domain>/mcp/<server-name>`, but copy the full URL
from Glean rather than guessing the path.

### 4. Use Glean from Pi

Once `pi mcp list` reports the server as connected, ask Pi to use Glean, for
example: “Use Glean to find the on-call runbook and summarize the escalation
steps.” MCP tools with `codemode` exposure are callable from codemode scripts;
the available tools depend on the server and your Glean permissions.

For tool discovery from a codemode script, use `searchTools("Glean search")`
or `describeNamespace("glean")` and inspect the returned tool descriptions
before calling them.

## What changes

The built-in MCP connection provides the Glean tools enabled for your
organization, such as search, chat, and document retrieval, and uses your Glean
permissions. It does not recreate this extension's custom `/glean`,
`/glean-save`, `/glean-load`, `/glean-mode`, chat-link, or Glean Assistant
model/provider features. The extension source remains here for reference, but
it will not receive further updates.

See Glean's [Using the Glean MCP Server](https://docs.glean.com/user-guide/mcp/usage)
guide for the MCP configurator and connection requirements. Run
`pi mcp --help` for Pi's current MCP command options.
