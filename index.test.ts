/**
 * Unit tests for the glean-chat extension.
 *
 * Run: node --test
 * (Node >= 23.6 strips types natively; no build step.)
 *
 * Covers:
 *   - buildGleanMessages: ordering (most-recent-first), author mapping,
 *     merging, system prompt / tool traffic dropping, trailing-USER guarantee
 *   - streamGlean: ND-JSON parsing, per-messageId fragment reassembly,
 *     thinking/text block interleaving, citations, errors, abort
 *
 * The extension module is imported once; registerProvider is captured via a
 * stub ExtensionAPI. A mock Glean backend (node:http) serves canned ND-JSON.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";

// ── Test doubles ──────────────────────────────────────────────────────────────

type Captured = {
  providerName?: string;
  providerConfig?: any;
  tool?: any;
  commands: Record<string, any>;
  entries: any[];
  handlers: Record<string, any[]>;
};

const captured: Captured = { commands: {}, entries: [], handlers: {} };

const piStub = {
  registerProvider: (name: string, cfg: any) => {
    captured.providerName = name;
    captured.providerConfig = cfg;
  },
  registerTool: (cfg: any) => {
    captured.tool = cfg;
  },
  registerCommand: (name: string, cfg: any) => {
    captured.commands[name] = cfg;
  },
  on: (event: string, handler: any) => {
    (captured.handlers[event] ??= []).push(handler);
  },
  appendEntry: (_type: string, data: any) => {
    captured.entries.push(data);
  },
  sendMessage: () => {},
} as any;

/** Fire captured extension event handlers with the given payload + ctx. */
async function fireEvent(event: string, payload: any, ctx: any) {
  for (const h of captured.handlers[event] ?? []) await h(payload, ctx);
}

/** Minimal ExtensionCommandContext double for exercising command handlers. */
function makeCommandCtx(overrides: Record<string, any> = {}) {
  const notes: { message: string; level: string }[] = [];
  const statuses: Record<string, string | undefined> = {};
  let footerFactory: any = null;
  const ui = {
    notify: (message: string, level: string) => notes.push({ message, level }),
    setStatus: (key: string, text: string | undefined) => {
      statuses[key] = text;
    },
    setFooter: (factory: any) => {
      footerFactory = factory;
    },
  };
  return {
    notes,
    statuses,
    mode: "tui",
    cwd: "/tmp/project",
    model: { id: "glean-assistant", provider: "glean" },
    ui,
    getFooter: () => footerFactory,
    ...overrides,
  } as any;
}

/** Fake theme + footerData for rendering a captured footer factory. */
function renderFooter(factory: any, providerCount = 2, branch: string | null = null) {
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
  const footerData = {
    getGitBranch: () => branch,
    getAvailableProviderCount: () => providerCount,
    getExtensionStatuses: () => new Map(),
    onBranchChange: () => () => {},
  };
  const component = factory({}, theme, footerData);
  return component.render(80) as string[];
}

// OAuth mock behavior (used by the oauth describe block).
let oauthRegisterStatus = 201;
let tokenRequests: URLSearchParams[] = [];

// Mock Glean backend. Each test sets `respond` to control the ND-JSON body.
let server: Server;
let baseUrl: string;
let respond: (req: {
  body: any;
  res: import("node:http").ServerResponse;
}) => void;
let lastRequestBody: any;

function gleanMsg(
  id: string,
  messageType: string,
  text?: string,
  extra?: Record<string, unknown>,
) {
  return {
    messages: [
      {
        author: "GLEAN_AI",
        messageId: id,
        messageType,
        ...(text !== undefined ? { fragments: [{ text }] } : {}),
        ...extra,
      },
    ],
  };
}

/** Default responder: write ND-JSON lines then end. */
function ndjsonResponder(lines: unknown[]) {
  return ({ res }: { body: any; res: import("node:http").ServerResponse }) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    for (const l of lines) res.write(JSON.stringify(l) + "\n");
    res.end();
  };
}

async function runStream(
  context: any,
  options: any = { apiKey: "test-token" },
) {
  const model = {
    id: "glean-assistant",
    api: "glean-chat",
    provider: "glean",
    baseUrl,
  };
  const stream = captured.providerConfig.streamSimple(model, context, options);
  const events: string[] = [];
  let final: any;
  let error: any;
  for await (const ev of stream) {
    events.push(ev.type);
    if (ev.type === "done") final = ev.message;
    if (ev.type === "error") error = ev.error;
  }
  return { events, final, error };
}

const userMsg = (text: string) => ({
  role: "user",
  content: text,
  timestamp: 0,
});
const assistantMsg = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "glean-chat",
  provider: "glean",
  model: "glean-assistant",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 0,
});

// ── Setup ─────────────────────────────────────────────────────────────────────

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = req.url ?? "/";
      // OAuth endpoints
      if (url.startsWith("/.well-known/oauth-authorization-server")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            issuer: `${baseUrl}/oauth`,
            authorization_endpoint: `${baseUrl}/oauth/authorize`,
            token_endpoint: `${baseUrl}/oauth/token`,
            registration_endpoint: `${baseUrl}/oauth/register`,
          }),
        );
        return;
      }
      if (url.startsWith("/oauth/register")) {
        res.writeHead(oauthRegisterStatus, { "Content-Type": "application/json" });
        res.end(
          oauthRegisterStatus === 201
            ? JSON.stringify({ client_id: "test-client-id", scope: "chat" })
            : JSON.stringify({ error: "access_denied" }),
        );
        return;
      }
      if (url.startsWith("/oauth/token")) {
        const params = new URLSearchParams(body);
        tokenRequests.push(params);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: `access-${params.get("grant_type")}`,
            refresh_token: "refresh-1",
            expires_in: 3600,
          }),
        );
        return;
      }
      // Chat endpoint
      lastRequestBody = body ? JSON.parse(body) : undefined;
      respond({ body: lastRequestBody, res });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;

  // Env must be set before import so the model surface registers.
  process.env.GLEAN_BACKEND_URL = baseUrl;
  process.env.GLEAN_API_TOKEN = "test-token";
  const ext = await import("./index.ts");
  ext.default(piStub);
});

after(() => server.close());

beforeEach(() => {
  lastRequestBody = undefined;
  oauthRegisterStatus = 201;
  tokenRequests = [];
  respond = ndjsonResponder([gleanMsg("m1", "CONTENT", "ok")]);
});

// ── Tool schema ───────────────────────────────────────────────────────────────

describe("tool schema", () => {
  it("registers the glean_chat tool", () => {
    assert.equal(captured.tool.name, "glean_chat");
  });

  it("describes reasoning as a plain string enum", () => {
    const reasoning = captured.tool.parameters.properties.reasoning;
    assert.equal(reasoning.type, "string");
    assert.deepEqual(reasoning.enum, ["FAST", "ADVANCED", "AUTO"]);
  });

  it("emits no anyOf/oneOf/allOf/const anywhere in the schema", () => {
    // Grammar-constrained local servers (llama.cpp, vLLM, and other
    // OpenAI-compatible runtimes) reject tool schemas using these keywords,
    // failing the entire request rather than the single tool. Keep the schema
    // to the portable subset so the tool works on any model.
    const json = JSON.stringify(captured.tool.parameters);
    for (const keyword of ["anyOf", "oneOf", "allOf", "const"]) {
      assert.ok(
        !json.includes(`"${keyword}"`),
        `tool schema must not use "${keyword}": ${json}`,
      );
    }
  });
});

// ── Provider registration ─────────────────────────────────────────────────────

describe("provider registration", () => {
  it("registers the glean provider with the glean-assistant model", () => {
    assert.equal(captured.providerName, "glean");
    assert.equal(captured.providerConfig.baseUrl, baseUrl);
    assert.deepEqual(
      captured.providerConfig.models.map((m: any) => m.id),
      ["glean-assistant"],
    );
    assert.equal(typeof captured.providerConfig.streamSimple, "function");
  });
});

// ── Request building ──────────────────────────────────────────────────────────

describe("request building", () => {
  it("orders messages most-recent-first with CONTENT type", async () => {
    await runStream({
      systemPrompt: "system prompt to drop",
      messages: [
        userMsg("hi"),
        assistantMsg("hi there"),
        userMsg("who are you?"),
      ],
    });
    const sent = lastRequestBody.messages;
    assert.equal(sent.length, 3);
    assert.deepEqual(
      sent.map((m: any) => [
        m.author,
        m.fragments.map((f: any) => f.text).join(""),
      ]),
      [
        ["USER", "who are you?"],
        ["GLEAN_AI", "hi there"],
        ["USER", "hi"],
      ],
    );
    for (const m of sent) assert.equal(m.messageType, "CONTENT");
    assert.equal(lastRequestBody.stream, true);
  });

  it("drops system prompt and tool traffic", async () => {
    await runStream({
      systemPrompt: "SYSTEM",
      messages: [
        userMsg("run a command"),
        {
          ...assistantMsg("running"),
          content: [
            { type: "text", text: "running" },
            { type: "toolCall", id: "t1", name: "bash", arguments: {} },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "t1",
          toolName: "bash",
          content: [{ type: "text", text: "TOOL OUTPUT" }],
          isError: false,
          timestamp: 0,
        },
        userMsg("thanks"),
      ],
    });
    const all = JSON.stringify(lastRequestBody);
    assert.ok(!all.includes("SYSTEM"));
    assert.ok(!all.includes("TOOL OUTPUT"));
    assert.ok(!all.includes("toolCall"));
  });

  it("merges consecutive same-author messages", async () => {
    await runStream({
      messages: [userMsg("part one"), userMsg("part two")],
    });
    const sent = lastRequestBody.messages;
    assert.equal(sent.length, 1);
    assert.equal(sent[0].author, "USER");
    assert.equal(
      sent[0].fragments.map((f: any) => f.text).join(""),
      "part one\n\npart two",
    );
  });

  it("appends (continue) when history ends with assistant", async () => {
    await runStream({
      messages: [userMsg("hi"), assistantMsg("hello")],
    });
    const sent = lastRequestBody.messages;
    assert.equal(sent[0].author, "USER");
    assert.equal(sent[0].fragments[0].text, "(continue)");
  });

  it("sends thinking blocks nowhere (assistant text only)", async () => {
    await runStream({
      messages: [
        userMsg("q"),
        {
          ...assistantMsg("answer"),
          content: [
            { type: "thinking", thinking: "SECRET THINKING" },
            { type: "text", text: "answer" },
          ],
        },
        userMsg("follow up"),
      ],
    });
    assert.ok(!JSON.stringify(lastRequestBody).includes("SECRET THINKING"));
  });
});

// ── Reasoning mode ─────────────────────────────────────────────────────

describe("reasoning mode", () => {
  it("defaults to AUTO in the request agentConfig", async () => {
    // /glean-mode --> auto is the default; a fresh cycle test below relies on
    // this ordering, so assert the default before mutating session state.
    await runStream({ messages: [userMsg("hi")] });
    assert.deepEqual(lastRequestBody.agentConfig, { agent: "AUTO" });
  });

  it("registers the /glean-mode command", () => {
    assert.equal(typeof captured.commands["glean-mode"], "object");
    assert.equal(typeof captured.commands["glean-mode"].handler, "function");
  });

  it("sets the mode explicitly and applies it to requests", async () => {
    const ctx = makeCommandCtx();
    await captured.commands["glean-mode"].handler("advanced", ctx);
    assert.ok(ctx.notes.some((n: any) => n.message.includes("ADVANCED")));

    await runStream({ messages: [userMsg("hi")] });
    assert.deepEqual(lastRequestBody.agentConfig, { agent: "ADVANCED" });
  });

  it("cycles to the next mode when given no argument", async () => {
    const ctx = makeCommandCtx();
    // Start from a known state: advanced -> auto -> fast -> advanced.
    await captured.commands["glean-mode"].handler("advanced", ctx);
    await captured.commands["glean-mode"].handler("", ctx);
    await runStream({ messages: [userMsg("hi")] });
    assert.deepEqual(lastRequestBody.agentConfig, { agent: "AUTO" });

    await captured.commands["glean-mode"].handler("", ctx);
    await runStream({ messages: [userMsg("hi")] });
    assert.deepEqual(lastRequestBody.agentConfig, { agent: "FAST" });
  });

  it("rejects an invalid mode without changing state", async () => {
    const ctx = makeCommandCtx();
    await captured.commands["glean-mode"].handler("fast", ctx);
    await captured.commands["glean-mode"].handler("turbo", ctx);
    assert.ok(
      ctx.notes.some(
        (n: any) => n.level === "error" && n.message.includes("turbo"),
      ),
    );
    await runStream({ messages: [userMsg("hi")] });
    assert.deepEqual(lastRequestBody.agentConfig, { agent: "FAST" });
  });

  it("persists the selected mode via appendEntry", async () => {
    const ctx = makeCommandCtx();
    const before = captured.entries.length;
    await captured.commands["glean-mode"].handler("advanced", ctx);
    const added = captured.entries.slice(before);
    assert.ok(added.some((e: any) => e.reasoningMode === "ADVANCED"));
  });

  it("renders a custom footer with model and reasoning mode when Glean is active", async () => {
    const ctx = makeCommandCtx();
    await captured.commands["glean-mode"].handler("advanced", ctx);
    await fireEvent(
      "model_select",
      { model: { id: "glean-assistant", provider: "glean" } },
      ctx,
    );
    const factory = ctx.getFooter();
    assert.equal(typeof factory, "function");
    const lines = renderFooter(factory);
    assert.equal(lines.length, 2);
    // Model line is right-aligned and includes provider + reasoning mode.
    assert.ok(lines[1].includes("(glean) glean-assistant \u2022 advanced"));
    assert.ok(lines[1].startsWith(" "));
  });

  it("omits the provider prefix when only one provider is available", async () => {
    const ctx = makeCommandCtx();
    await captured.commands["glean-mode"].handler("auto", ctx);
    await fireEvent(
      "model_select",
      { model: { id: "glean-assistant", provider: "glean" } },
      ctx,
    );
    const lines = renderFooter(ctx.getFooter(), 1);
    assert.ok(lines[1].includes("glean-assistant \u2022 auto"));
    assert.ok(!lines[1].includes("(glean)"));
  });

  it("reflects a mode change on the next footer render", async () => {
    const ctx = makeCommandCtx();
    await fireEvent(
      "model_select",
      { model: { id: "glean-assistant", provider: "glean" } },
      ctx,
    );
    await captured.commands["glean-mode"].handler("fast", ctx);
    assert.ok(renderFooter(ctx.getFooter())[1].includes("\u2022 fast"));
  });

  it("restores the built-in footer when switching away from Glean", async () => {
    const ctx = makeCommandCtx();
    await fireEvent(
      "model_select",
      { model: { id: "glean-assistant", provider: "glean" } },
      ctx,
    );
    assert.equal(typeof ctx.getFooter(), "function");
    await fireEvent(
      "model_select",
      { model: { id: "claude", provider: "anthropic" } },
      ctx,
    );
    // setFooter(undefined) restores pi's default footer.
    assert.equal(ctx.getFooter(), undefined);
  });

  it("does not install a custom footer while a non-Glean model is active", async () => {
    const ctx = makeCommandCtx();
    await fireEvent(
      "model_select",
      { model: { id: "claude", provider: "anthropic" } },
      ctx,
    );
    await captured.commands["glean-mode"].handler("advanced", ctx);
    assert.equal(ctx.getFooter(), null);
  });

  it("offers argument completions filtered by prefix", async () => {
    const cmd = captured.commands["glean-mode"];
    const all = await cmd.getArgumentCompletions("");
    assert.deepEqual(
      all.map((i: any) => i.value).sort(),
      ["advanced", "auto", "fast"],
    );
    const a = await cmd.getArgumentCompletions("a");
    assert.deepEqual(
      a.map((i: any) => i.value).sort(),
      ["advanced", "auto"],
    );
  });
});

// ── Stream parsing ────────────────────────────────────────────────────────────

describe("stream parsing", () => {
  it("reassembles token fragments of the same messageId with no separator", async () => {
    respond = ndjsonResponder([
      gleanMsg("c1", "CONTENT", "I"),
      gleanMsg("c1", "CONTENT", "'m"),
      gleanMsg("c1", "CONTENT", " Glean"),
      gleanMsg("c1", "CONTENT", "."),
    ]);
    const { final } = await runStream({ messages: [userMsg("q")] });
    const text = final.content.filter((b: any) => b.type === "text");
    assert.equal(text.length, 1);
    assert.equal(text[0].text, "I'm Glean.");
  });

  it("separates distinct CONTENT messages with a paragraph break", async () => {
    respond = ndjsonResponder([
      gleanMsg("c1", "CONTENT", "First message."),
      gleanMsg("c2", "CONTENT", "Second message."),
    ]);
    const { final } = await runStream({ messages: [userMsg("q")] });
    const text = final.content.find((b: any) => b.type === "text");
    assert.equal(text.text, "First message.\n\nSecond message.");
  });

  it("reassembles HEADING tokens into thinking without mid-word newlines", async () => {
    respond = ndjsonResponder([
      gleanMsg("h1", "HEADING", "Answer"),
      gleanMsg("h1", "HEADING", "ing"),
      gleanMsg("h1", "HEADING", " simple"),
      gleanMsg("h1", "HEADING", " questions"),
      gleanMsg("c1", "CONTENT", "Done."),
    ]);
    const { final } = await runStream({ messages: [userMsg("q")] });
    const thinking = final.content.find((b: any) => b.type === "thinking");
    assert.equal(thinking.thinking, "Answering simple questions");
  });

  it("separates distinct thinking messages with a newline", async () => {
    respond = ndjsonResponder([
      gleanMsg("h1", "HEADING", "Step one"),
      gleanMsg("h2", "UPDATE", "Step two"),
      gleanMsg("c1", "CONTENT", "Done."),
    ]);
    const { final } = await runStream({ messages: [userMsg("q")] });
    const thinking = final.content.find((b: any) => b.type === "thinking");
    assert.equal(thinking.thinking, "Step one\nStep two");
  });

  it("preserves chronological interleaving of thinking and text blocks", async () => {
    respond = ndjsonResponder([
      gleanMsg("h1", "HEADING", "Searching"),
      gleanMsg("c1", "CONTENT", "Found it."),
      gleanMsg("h2", "HEADING", "Inspecting"),
      gleanMsg("c2", "CONTENT", "All done."),
    ]);
    const { final, events } = await runStream({ messages: [userMsg("q")] });
    assert.deepEqual(
      final.content.map((b: any) => b.type),
      ["thinking", "text", "thinking", "text"],
    );
    assert.equal(
      events.filter((e) => e === "thinking_start").length,
      events.filter((e) => e === "thinking_end").length,
    );
    assert.equal(
      events.filter((e) => e === "text_start").length,
      events.filter((e) => e === "text_end").length,
    );
  });

  it("ignores fragment-less status UPDATEs and CONTROL messages", async () => {
    respond = ndjsonResponder([
      gleanMsg("u0", "UPDATE", undefined, {
        stepId: "X",
        isStepComplete: true,
      }),
      gleanMsg("c1", "CONTENT", "Answer."),
      gleanMsg("u1", "UPDATE"),
      gleanMsg("ctrl", "CONTROL"),
    ]);
    const { final } = await runStream({ messages: [userMsg("q")] });
    assert.deepEqual(
      final.content.map((b: any) => b.type),
      ["text"],
    );
    assert.equal(final.content[0].text, "Answer.");
  });

  it("skips USER-authored echo messages", async () => {
    respond = ndjsonResponder([
      {
        messages: [
          {
            author: "USER",
            messageType: "CONTENT",
            fragments: [{ text: "echo" }],
          },
        ],
      },
      gleanMsg("c1", "CONTENT", "Reply."),
    ]);
    const { final } = await runStream({ messages: [userMsg("q")] });
    assert.equal(
      final.content.find((b: any) => b.type === "text").text,
      "Reply.",
    );
  });

  it("tolerates non-JSON keep-alive lines", async () => {
    respond = ({ res }) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.write("not json\n");
      res.write(JSON.stringify(gleanMsg("c1", "CONTENT", "Fine.")) + "\n");
      res.end();
    };
    const { final, error } = await runStream({ messages: [userMsg("q")] });
    assert.equal(error, undefined);
    assert.equal(final.content[0].text, "Fine.");
  });

  it("collects citations into a Sources block, deduplicated", async () => {
    respond = ndjsonResponder([
      {
        messages: [
          {
            author: "GLEAN_AI",
            messageId: "c1",
            messageType: "CONTENT",
            fragments: [
              {
                text: "See policy.",
                citation: {
                  sourceDocument: { title: "PTO", url: "https://w/pto" },
                },
              },
            ],
          },
        ],
      },
      {
        messages: [
          {
            author: "GLEAN_AI",
            messageId: "c1",
            messageType: "CONTENT",
            fragments: [
              {
                text: " More.",
                citation: {
                  sourceDocument: { title: "PTO", url: "https://w/pto" },
                },
              },
            ],
            citations: [
              { sourceDocument: { title: "Handbook", url: "https://w/hb" } },
            ],
          },
        ],
      },
    ]);
    const { final } = await runStream({ messages: [userMsg("q")] });
    const text = final.content.find((b: any) => b.type === "text").text;
    assert.ok(text.includes("See policy. More."));
    assert.ok(text.includes("**Sources:**"));
    assert.equal(text.match(/https:\/\/w\/pto/g)?.length, 1);
    assert.ok(text.includes("[Handbook](https://w/hb)"));
  });

  it("returns (no response) for an empty stream", async () => {
    respond = ndjsonResponder([gleanMsg("ctrl", "CONTROL")]);
    const { final } = await runStream({ messages: [userMsg("q")] });
    assert.equal(final.content[0].text, "(no response)");
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe("error handling", () => {
  it("surfaces ERROR messages as stream errors", async () => {
    respond = ndjsonResponder([gleanMsg("e1", "ERROR", "quota exceeded")]);
    const { error } = await runStream({ messages: [userMsg("q")] });
    assert.equal(error.stopReason, "error");
    assert.match(error.errorMessage, /quota exceeded/);
  });

  it("surfaces HTTP errors with status and hint", async () => {
    respond = ({ res }) => {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("bad token");
    };
    const { error } = await runStream({ messages: [userMsg("q")] });
    assert.equal(error.stopReason, "error");
    assert.match(error.errorMessage, /401/);
    assert.match(error.errorMessage, /GLEAN_API_TOKEN/);
  });

  it("errors when no token is available", async () => {
    // resolveGleanToken falls back to ~/.pi/agent/auth.json; point HOME at an
    // empty dir so a real auth.json on the test machine cannot satisfy it.
    const savedToken = process.env.GLEAN_API_TOKEN;
    const savedHome = process.env.HOME;
    delete process.env.GLEAN_API_TOKEN;
    process.env.HOME = "/nonexistent-glean-test";
    try {
      const { error } = await runStream({ messages: [userMsg("q")] }, {});
      assert.equal(error.stopReason, "error");
      assert.match(error.errorMessage, /token/i);
    } finally {
      process.env.GLEAN_API_TOKEN = savedToken;
      process.env.HOME = savedHome;
    }
  });

  it("reports aborted when the signal fires mid-stream", async () => {
    const controller = new AbortController();
    respond = ({ res }) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.write(JSON.stringify(gleanMsg("c1", "CONTENT", "partial")) + "\n");
      // Keep the connection open; abort will terminate it.
      setTimeout(() => controller.abort(), 50);
      setTimeout(() => res.end(), 5000).unref();
    };
    const { error } = await runStream(
      { messages: [userMsg("q")] },
      {
        apiKey: "test-token",
        signal: controller.signal,
      },
    );
    assert.equal(error.stopReason, "aborted");
  });
});

// ── OAuth ─────────────────────────────────────────────────────────────────────

describe("oauth", () => {
  it("registers an oauth block on the provider", () => {
    const oauth = captured.providerConfig.oauth;
    assert.ok(oauth);
    assert.equal(typeof oauth.login, "function");
    assert.equal(typeof oauth.refreshToken, "function");
    assert.equal(oauth.getApiKey({ access: "a", refresh: "r", expires: 0 }), "a");
  });

  it("login: DCR + PKCE code exchange yields credentials with clientId", async () => {
    const oauth = captured.providerConfig.oauth;
    const creds = await oauth.login({
      onAuth: ({ url }: { url: string }) => {
        // Simulate the browser: hit the redirect_uri with code + state.
        const authUrl = new URL(url);
        assert.equal(authUrl.searchParams.get("client_id"), "test-client-id");
        assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
        assert.ok(authUrl.searchParams.get("code_challenge"));
        const redirect = new URL(authUrl.searchParams.get("redirect_uri")!);
        redirect.searchParams.set("code", "auth-code-1");
        redirect.searchParams.set("state", authUrl.searchParams.get("state")!);
        fetch(redirect).catch(() => {});
      },
      onDeviceCode: () => {},
      onPrompt: async () => "",
      onSelect: async () => undefined,
    });

    assert.equal(creds.access, "access-authorization_code");
    assert.equal(creds.refresh, "refresh-1");
    assert.equal(creds.clientId, "test-client-id");
    assert.ok(creds.expires > Date.now());

    // Code exchange must carry PKCE verifier and no client secret.
    const exchange = tokenRequests.find(
      (p) => p.get("grant_type") === "authorization_code",
    )!;
    assert.ok(exchange.get("code_verifier"));
    assert.equal(exchange.get("code"), "auth-code-1");
    assert.equal(exchange.get("client_secret"), null);
  });

  it("refreshToken: uses stored clientId and preserves refresh fallback", async () => {
    const oauth = captured.providerConfig.oauth;
    const creds = await oauth.refreshToken({
      access: "old",
      refresh: "refresh-old",
      expires: 0,
      clientId: "test-client-id",
    });
    assert.equal(creds.access, "access-refresh_token");
    assert.equal(creds.clientId, "test-client-id");
    const req = tokenRequests.find((p) => p.get("grant_type") === "refresh_token")!;
    assert.equal(req.get("refresh_token"), "refresh-old");
    assert.equal(req.get("client_id"), "test-client-id");
  });

  it("refreshToken: rejects without clientId", async () => {
    const oauth = captured.providerConfig.oauth;
    await assert.rejects(
      () => oauth.refreshToken({ access: "a", refresh: "r", expires: 0 }),
      /client_id/,
    );
  });

  it("login: fails with guidance when DCR is restricted", async () => {
    oauthRegisterStatus = 403;
    const oauth = captured.providerConfig.oauth;
    await assert.rejects(
      () =>
        oauth.login({
          onAuth: () => {},
          onDeviceCode: () => {},
          onPrompt: async () => "",
          onSelect: async () => undefined,
        }),
      /Dynamic Client Registration may be restricted/,
    );
  });
});
