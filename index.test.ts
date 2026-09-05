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
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTranscript,
  formatProgressLine,
  gleanChatUrl,
  parseChatId,
  resolveGleanBaseUrl,
  resolveGleanToken,
  resolveGleanWebUrl,
} from "./index.ts";

// ── Test doubles ──────────────────────────────────────────────────────────────

type Captured = {
  providerName?: string;
  providerConfig?: any;
  /** Every registerProvider call, in order — the extension makes several. */
  providers: { name: string; config: any }[];
  tool?: any;
  commands: Record<string, any>;
  entries: any[];
  handlers: Record<string, any[]>;
};

const captured: Captured = {
  providers: [],
  commands: {},
  entries: [],
  handlers: {},
};

const piStub = {
  registerProvider: (name: string, cfg: any) => {
    captured.providers.push({ name, config: cfg });
    if (name === "glean") {
      captured.providerName = name;
      captured.providerConfig = cfg;
    }
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
  const widgets: Record<string, string[] | undefined> = {};
  // Every setWidget call in order, so tests can assert the progress widget was
  // shown *and* torn down rather than only inspecting the final state.
  const widgetCalls: { key: string; content: string[] | undefined }[] = [];
  let footerFactory: any = null;
  const ui = {
    notify: (message: string, level: string) => notes.push({ message, level }),
    setStatus: (key: string, text: string | undefined) => {
      statuses[key] = text;
    },
    setWidget: (key: string, content: string[] | undefined) => {
      widgets[key] = content;
      widgetCalls.push({ key, content });
    },
    setFooter: (factory: any) => {
      footerFactory = factory;
    },
  };
  return {
    notes,
    statuses,
    widgets,
    widgetCalls,
    mode: "tui",
    cwd: "/tmp/project",
    model: { id: "glean-assistant", provider: "glean" },
    ui,
    // Hand-off commands read the session branch and its name.
    sessionManager: {
      getBranch: () => [],
      getSessionName: () => undefined,
    },
    signal: undefined,
    getFooter: () => footerFactory,
    ...overrides,
  } as any;
}

/** Session entry doubles for the transcript builder. */
function msgEntry(message: any, id = "e1") {
  return { type: "message", id, parentId: null, timestamp: "", message } as any;
}
function customMessageEntry(
  customType: string,
  content: string,
  id = "c1",
) {
  return {
    type: "custom_message",
    id,
    parentId: null,
    timestamp: "",
    customType,
    content,
    display: true,
  } as any;
}

/** Fake theme + footerData for rendering a captured footer factory. */
function renderFooter(
  factory: any,
  providerCount = 2,
  branch: string | null = null,
  extensionStatuses: Map<string, string> = new Map(),
) {
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
  const footerData = {
    getGitBranch: () => branch,
    getAvailableProviderCount: () => providerCount,
    getExtensionStatuses: () => extensionStatuses,
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
  modelOverrides: Record<string, unknown> = {},
) {
  const model = {
    id: "glean-assistant",
    api: "glean-chat",
    provider: "glean",
    baseUrl,
    ...modelOverrides,
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
    assert.deepEqual(reasoning.enum, ["ADVANCED", "AUTO"]);
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

// ── API registration ──────────────────────────────────────────────────────────

describe("api registration", () => {
  it("registers glean-chat in pi's api registry", async () => {
    // What lets a models.json provider entry name "api": "glean-chat": pi
    // resolves an api it does not know through this registry at stream time.
    const { getApiProvider } = await import("@earendil-works/pi-ai/compat");
    const api = getApiProvider("glean-chat" as any);
    assert.ok(api, "glean-chat should be registered");
    assert.equal(typeof api!.stream, "function");
    assert.equal(typeof api!.streamSimple, "function");
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

  it("toggles to the other mode when given no argument", async () => {
    const ctx = makeCommandCtx();
    // Start from a known state: advanced -> auto -> advanced.
    await captured.commands["glean-mode"].handler("advanced", ctx);
    await captured.commands["glean-mode"].handler("", ctx);
    await runStream({ messages: [userMsg("hi")] });
    assert.deepEqual(lastRequestBody.agentConfig, { agent: "AUTO" });

    await captured.commands["glean-mode"].handler("", ctx);
    await runStream({ messages: [userMsg("hi")] });
    assert.deepEqual(lastRequestBody.agentConfig, { agent: "ADVANCED" });
  });

  it("rejects an invalid mode without changing state", async () => {
    const ctx = makeCommandCtx();
    await captured.commands["glean-mode"].handler("advanced", ctx);
    await captured.commands["glean-mode"].handler("turbo", ctx);
    assert.ok(
      ctx.notes.some(
        (n: any) => n.level === "error" && n.message.includes("turbo"),
      ),
    );
    await runStream({ messages: [userMsg("hi")] });
    assert.deepEqual(lastRequestBody.agentConfig, { agent: "ADVANCED" });
  });

  it("rejects the retired fast mode", async () => {
    const ctx = makeCommandCtx();
    await captured.commands["glean-mode"].handler("advanced", ctx);
    await captured.commands["glean-mode"].handler("fast", ctx);
    assert.ok(
      ctx.notes.some(
        (n: any) => n.level === "error" && n.message.includes("fast"),
      ),
    );
    await runStream({ messages: [userMsg("hi")] });
    assert.deepEqual(lastRequestBody.agentConfig, { agent: "ADVANCED" });
  });

  it("persists the selected mode via appendEntry", async () => {
    const ctx = makeCommandCtx();
    const before = captured.entries.length;
    await captured.commands["glean-mode"].handler("advanced", ctx);
    const added = captured.entries.slice(before);
    assert.ok(added.some((e: any) => e.reasoningMode === "ADVANCED"));
  });

  it("takes the agent from the model's samplingParams", async () => {
    // How a models.json entry pins one model to one agent, so `glean-advanced`
    // and `glean-auto` can be separate selectable models.
    const ctx = makeCommandCtx();
    await captured.commands["glean-mode"].handler("auto", ctx);
    await runStream({ messages: [userMsg("hi")] }, { apiKey: "test-token" }, {
      samplingParams: { agent: "ADVANCED" },
    });
    assert.deepEqual(lastRequestBody.agentConfig, { agent: "ADVANCED" });
  });

  it("lets per-request samplingParams override the model's", async () => {
    await runStream(
      { messages: [userMsg("hi")] },
      { apiKey: "test-token", samplingParams: { agent: "auto" } },
      { samplingParams: { agent: "ADVANCED" } },
    );
    assert.deepEqual(lastRequestBody.agentConfig, { agent: "AUTO" });
  });

  it("maps the thinking level through thinkingLevelMap", async () => {
    const ctx = makeCommandCtx();
    await captured.commands["glean-mode"].handler("auto", ctx);
    await runStream(
      { messages: [userMsg("hi")] },
      { apiKey: "test-token", reasoning: "high" },
      { thinkingLevelMap: { low: "AUTO", high: "ADVANCED" } },
    );
    assert.deepEqual(lastRequestBody.agentConfig, { agent: "ADVANCED" });
  });

  it("falls back to the session mode when a model names an unknown agent", async () => {
    // A stale FAST in someone's models.json must not reach the retired agent.
    const ctx = makeCommandCtx();
    await captured.commands["glean-mode"].handler("advanced", ctx);
    await runStream({ messages: [userMsg("hi")] }, { apiKey: "test-token" }, {
      samplingParams: { agent: "FAST" },
    });
    assert.deepEqual(lastRequestBody.agentConfig, { agent: "ADVANCED" });
  });

  it("renders the active model's own agent in the footer", async () => {
    const ctx = makeCommandCtx();
    await captured.commands["glean-mode"].handler("auto", ctx);
    await fireEvent(
      "model_select",
      {
        model: {
          id: "glean-advanced",
          provider: "glean-corp",
          api: "glean-chat",
          samplingParams: { agent: "ADVANCED" },
        },
      },
      ctx,
    );
    // Recognized by api, not provider id, so a models.json provider gets the
    // Glean footer too — showing its own agent rather than the session mode.
    const lines = renderFooter(ctx.getFooter());
    assert.ok(lines[1].includes("(glean-corp) glean-advanced • advanced"));
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
    await captured.commands["glean-mode"].handler("auto", ctx);
    assert.ok(renderFooter(ctx.getFooter())[1].includes("\u2022 auto"));
    await captured.commands["glean-mode"].handler("advanced", ctx);
    assert.ok(renderFooter(ctx.getFooter())[1].includes("\u2022 advanced"));
  });

  it("renders extension statuses as a third line", async () => {
    const ctx = makeCommandCtx();
    await fireEvent(
      "model_select",
      { model: { id: "glean-assistant", provider: "glean" } },
      ctx,
    );

    // No statuses: the footer stays two lines, as before.
    assert.equal(renderFooter(ctx.getFooter()).length, 2);

    // With statuses: sorted by key, joined, collapsed to one line.
    const lines = renderFooter(
      ctx.getFooter(),
      2,
      null,
      new Map([
        ["z-other", "second"],
        ["glean-progress", "⠻ Saving session to Glean\n(3s)"],
      ]),
    );
    assert.equal(lines.length, 3);
    assert.equal(lines[2], "⠻ Saving session to Glean (3s) second");
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
      ["advanced", "auto"],
    );
    assert.ok(!all.some((i: any) => i.value === "fast"));
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

// ── Tool streaming ────────────────────────────────────────────────────────────

describe("tool streaming", () => {
  /** Run the registered glean_chat tool, capturing partial updates. */
  async function runTool(params: any, signal?: AbortSignal) {
    const updates: string[] = [];
    const result = await captured.tool.execute(
      "call-1",
      params,
      signal,
      (partial: any) => {
        updates.push(partial.content.map((c: any) => c.text).join(""));
      },
      undefined,
    );
    return { updates, result, text: result.content.map((c: any) => c.text).join("") };
  }

  /** Responder writing ND-JSON lines with a delay before each. */
  function delayedResponder(lines: unknown[], delayMs = 120) {
    return ({ res }: { body: any; res: import("node:http").ServerResponse }) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      let i = 0;
      const tick = () => {
        if (i >= lines.length) {
          res.end();
          return;
        }
        res.write(JSON.stringify(lines[i++]) + "\n");
        setTimeout(tick, delayMs);
      };
      // Delay the first line too, so it clears the partial-update throttle.
      setTimeout(tick, delayMs);
    };
  }

  it("pushes partial results as content arrives", async () => {
    respond = delayedResponder([
      gleanMsg("c1", "CONTENT", "Hello"),
      gleanMsg("c1", "CONTENT", " world"),
    ]);
    const { updates, text } = await runTool({
      message: "q",
      new_conversation: true,
    });
    assert.equal(text, "Hello world");
    // Initial placeholder, then a growing answer.
    assert.match(updates[0], /Querying Glean/);
    assert.ok(updates.includes("Hello"), `updates: ${JSON.stringify(updates)}`);
    assert.ok(updates.includes("Hello world"));
  });

  it("shows the latest status line until the answer starts", async () => {
    respond = delayedResponder([
      gleanMsg("u1", "UPDATE", "Searching Confluence"),
      gleanMsg("c1", "CONTENT", "Answer"),
    ]);
    const { updates, text } = await runTool({
      message: "q",
      new_conversation: true,
    });
    assert.ok(updates.includes("Searching Confluence"));
    assert.equal(text, "Answer");
  });

  it("streams via the chat endpoint and threads chatId across calls", async () => {
    respond = ({ res }) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.write(
        JSON.stringify({ chatId: "chat-42", ...gleanMsg("c1", "CONTENT", "a") }) +
          "\n",
      );
      res.end();
    };
    await runTool({ message: "first", new_conversation: true });
    assert.equal(lastRequestBody.stream, true);
    assert.equal(lastRequestBody.chatId, undefined);
    assert.equal(lastRequestBody.messages[0].fragments[0].text, "first");
    assert.ok(captured.entries.some((e) => e.chatId === "chat-42"));

    await runTool({ message: "second" });
    assert.equal(lastRequestBody.chatId, "chat-42");
  });

  it("honors the per-call reasoning override", async () => {
    respond = ndjsonResponder([gleanMsg("c1", "CONTENT", "a")]);
    await runTool({ message: "q", reasoning: "ADVANCED", new_conversation: true });
    assert.deepEqual(lastRequestBody.agentConfig, { agent: "ADVANCED" });
  });

  it("ignores a retired FAST override and uses the session mode", async () => {
    await captured.commands["glean-mode"].handler("auto", makeCommandCtx());
    respond = ndjsonResponder([gleanMsg("c1", "CONTENT", "a")]);
    await runTool({ message: "q", reasoning: "FAST", new_conversation: true });
    assert.deepEqual(lastRequestBody.agentConfig, { agent: "AUTO" });
  });

  it("appends a deduplicated Sources block", async () => {
    respond = ndjsonResponder([
      gleanMsg("c1", "CONTENT", "answer", {
        fragments: [
          { text: "answer" },
          {
            citation: {
              sourceDocument: { title: "Handbook", url: "https://w/hb" },
            },
          },
        ],
      }),
      gleanMsg("c2", "CONTENT", undefined, {
        citations: [
          {
            sourceDocument: { title: "Handbook", url: "https://w/hb" },
          },
        ],
      }),
    ]);
    const { text } = await runTool({ message: "q", new_conversation: true });
    assert.match(text, /\*\*Sources:\*\*/);
    assert.equal(text.match(/https:\/\/w\/hb/g)?.length, 1);
  });

  it("returns an error result on HTTP failure", async () => {
    respond = ({ res }) => {
      res.writeHead(429, { "Content-Type": "text/plain" });
      res.end("slow down");
    };
    const { result, text } = await runTool({
      message: "q",
      new_conversation: true,
    });
    assert.equal(result.isError, true);
    assert.match(text, /429/);
    assert.match(text, /rate limited/i);
  });

  it("keeps the partial answer when aborted", async () => {
    const controller = new AbortController();
    respond = ({ res }) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.write(JSON.stringify(gleanMsg("c1", "CONTENT", "partial")) + "\n");
      setTimeout(() => controller.abort(), 50);
      setTimeout(() => res.end(), 5000).unref();
    };
    const { result, text } = await runTool(
      { message: "q", new_conversation: true },
      controller.signal,
    );
    assert.equal(result.isError, true);
    assert.match(text, /aborted/i);
    assert.match(text, /partial/);
  });

  it("renders a compact tail while partial and the full text when settled", () => {
    const theme = { fg: (_c: string, t: string) => t };
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const result = { content: [{ type: "text", text: lines }], details: {} };
    const ctx: any = { lastComponent: undefined, isError: false };

    const partial = captured.tool.renderResult(
      result,
      { expanded: false, isPartial: true },
      theme,
      ctx,
    );
    const partialText = partial.render(80).join("\n");
    assert.ok(!partialText.includes("line 0"), partialText);
    assert.ok(partialText.includes("line 19"));

    const settled = captured.tool.renderResult(
      result,
      { expanded: false, isPartial: false },
      theme,
      { ...ctx, lastComponent: partial },
    );
    const settledText = settled.render(80).join("\n");
    assert.ok(settledText.includes("line 0"));
    assert.ok(settledText.includes("line 19"));
  });
});

// ── Transcript building ───────────────────────────────────────────────────────

describe("formatProgressLine", () => {
  it("renders spinner, label and elapsed seconds", () => {
    assert.equal(
      formatProgressLine("Saving session to Glean", "", 9_400, "⠹"),
      "⠹ Saving session to Glean (9s)",
    );
  });

  it("appends the live phase text when present", () => {
    assert.equal(
      formatProgressLine("Saving to Glean", "searching Confluence", 0, "⠋"),
      "⠋ Saving to Glean · searching Confluence (0s)",
    );
  });

  it("collapses multi-line phase text to a single line", () => {
    assert.equal(
      formatProgressLine("Saving", "  reading\n\n12 documents  ", 1_000, "⠙"),
      "⠙ Saving · reading 12 documents (1s)",
    );
  });

  it("truncates to the given width", () => {
    const line = formatProgressLine("Saving", "x".repeat(200), 0, "⠋", 20);
    assert.equal(line.length, 20);
    assert.ok(line.endsWith("…"));
  });
});

describe("buildTranscript", () => {
  it("renders user and assistant turns in order", () => {
    const { text, turns } = buildTranscript([
      msgEntry({ role: "user", content: "how do I deploy?", timestamp: 0 }, "a"),
      msgEntry(
        {
          role: "assistant",
          content: [{ type: "text", text: "run make deploy" }],
          timestamp: 0,
        },
        "b",
      ),
    ]);
    assert.equal(turns, 2);
    assert.equal(
      text,
      "## You\n\nhow do I deploy?\n\n## Assistant\n\nrun make deploy",
    );
  });

  it("collapses tool calls to one-line markers and drops tool results", () => {
    const { text } = buildTranscript([
      msgEntry(
        {
          role: "assistant",
          content: [
            { type: "text", text: "checking" },
            { type: "thinking", thinking: "SECRET THINKING" },
            {
              type: "toolCall",
              id: "t1",
              name: "bash",
              arguments: { command: "npm test\n--verbose" },
            },
          ],
          timestamp: 0,
        },
        "a",
      ),
      msgEntry(
        {
          role: "toolResult",
          toolCallId: "t1",
          toolName: "bash",
          content: [{ type: "text", text: "TOOL OUTPUT" }],
          isError: false,
          timestamp: 0,
        },
        "b",
      ),
    ]);
    assert.match(text, /_\[tool: bash — npm test --verbose\]_/);
    assert.ok(!text.includes("TOOL OUTPUT"));
    assert.ok(!text.includes("SECRET THINKING"));
  });

  it("truncates long tool arguments to a single line", () => {
    const { text } = buildTranscript([
      msgEntry(
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "t1",
              name: "read",
              arguments: { file_path: "x".repeat(200) },
            },
          ],
          timestamp: 0,
        },
        "a",
      ),
    ]);
    const marker = /_\[tool: read — (.+)\]_/.exec(text)![1];
    assert.equal(marker.length, 80);
    assert.ok(marker.endsWith("…"));
  });

  it("includes extension-injected messages and summaries", () => {
    const { text } = buildTranscript([
      {
        type: "compaction",
        id: "z",
        parentId: null,
        timestamp: "",
        summary: "we set up auth",
        firstKeptEntryId: "a",
        tokensBefore: 1,
      } as any,
      customMessageEntry("glean-response", "**Glean answer:** use SSO"),
    ]);
    assert.match(text, /## Earlier context \(summarized\)\n\nwe set up auth/);
    assert.match(text, /## Glean\n\n\*\*Glean answer:\*\* use SSO/);
  });

  it("drops the oldest turns first when over the cap", () => {
    const entries = ["first", "second", "third"].map((t, i) =>
      msgEntry({ role: "user", content: t, timestamp: 0 }, `e${i}`),
    );
    const { text, turns, truncated } = buildTranscript(entries, {
      maxChars: 40,
    });
    assert.equal(truncated, true);
    assert.ok(!text.includes("first"));
    assert.ok(text.includes("second"));
    assert.ok(text.includes("third"));
    assert.equal(turns, 2);
    assert.match(text, /^_\[earlier turns omitted\]_/);
  });

  it("reports nothing to save for an empty branch", () => {
    assert.deepEqual(buildTranscript([]), {
      text: "",
      turns: 0,
      truncated: false,
    });
  });
});

// ── Hand-off commands ─────────────────────────────────────────────────────────

describe("hand-off", () => {
  const branch = [
    msgEntry({ role: "user", content: "how do I deploy?", timestamp: 0 }, "a"),
    msgEntry(
      {
        role: "assistant",
        content: [{ type: "text", text: "run make deploy" }],
        timestamp: 0,
      },
      "b",
    ),
  ];

  function handoffCtx(overrides: Record<string, any> = {}) {
    return makeCommandCtx({
      sessionManager: {
        getBranch: () => branch,
        getSessionName: () => "deploy work",
      },
      ...overrides,
    });
  }

  /** Respond with a chatId + a one-line answer. */
  function savedResponder(chatId: string) {
    return ({ res }: { body: any; res: import("node:http").ServerResponse }) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.write(
        JSON.stringify({
          chatId,
          ...gleanMsg("c1", "CONTENT", "You were deploying."),
        }) + "\n",
      );
      res.end();
    };
  }

  let sentMessages: any[];
  beforeEach(() => {
    sentMessages = [];
    piStub.sendMessage = (msg: any) => sentMessages.push(msg);
  });
  afterEach(() => {
    piStub.sendMessage = () => {};
  });

  it("registers the hand-off commands", () => {
    for (const name of ["glean-save", "glean-url", "glean-load"])
      assert.equal(typeof captured.commands[name]?.handler, "function");
  });

  it("/glean-save sends the transcript once with saveChat and reports the URL", async () => {
    respond = savedResponder("chat-saved-1");
    const ctx = handoffCtx();
    await captured.commands["glean-save"].handler("--new", ctx);

    assert.equal(lastRequestBody.saveChat, true);
    assert.equal(lastRequestBody.chatId, undefined);
    assert.equal(lastRequestBody.messages.length, 1);
    const sent = lastRequestBody.messages[0];
    assert.equal(sent.author, "USER");
    const text = sent.fragments.map((f: any) => f.text).join("");
    assert.match(text, /## You\n\nhow do I deploy\?/);
    assert.match(text, /## Assistant\n\nrun make deploy/);
    assert.match(text, /Session: deploy work/);
    assert.match(text, /Summarize where we left off/);

    // The link and Glean's recap are injected into the session.
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].customType, "glean-handoff");
    assert.match(sentMessages[0].content, /\*\*Saved to Glean:\*\*/);
    assert.match(sentMessages[0].content, /chat\/chat-saved-1/);
    assert.match(sentMessages[0].content, /You were deploying\./);
    assert.ok(
      captured.entries.some(
        (e) => e.chatId === "chat-saved-1" && e.saved === true,
      ),
    );
  });

  it("/glean-save appends to the current thread unless --new", async () => {
    respond = savedResponder("chat-saved-1");
    await captured.commands["glean-save"].handler("", handoffCtx());
    assert.equal(lastRequestBody.chatId, "chat-saved-1");
  });

  it("/glean-save uses trailing text as the instruction", async () => {
    respond = savedResponder("chat-saved-1");
    await captured.commands["glean-save"].handler(
      "--new what did I miss?",
      handoffCtx(),
    );
    const text = lastRequestBody.messages[0].fragments
      .map((f: any) => f.text)
      .join("");
    assert.match(text, /what did I miss\?$/);
    assert.ok(!text.includes("Summarize where we left off"));
  });

  it("/glean-save refuses an empty session", async () => {
    const ctx = handoffCtx({
      sessionManager: { getBranch: () => [], getSessionName: () => undefined },
    });
    await captured.commands["glean-save"].handler("--new", ctx);
    assert.equal(lastRequestBody, undefined);
    assert.match(ctx.notes.at(-1).message, /Nothing to save/);
  });

  it("/glean-url reports the link only for a saved chat", async () => {
    // Fresh transient thread: the tool threads a chatId but never saved it.
    respond = savedResponder("chat-transient");
    await captured.tool.execute(
      "call-x",
      { message: "q", new_conversation: true },
      undefined,
      undefined,
      undefined,
    );
    const transient = handoffCtx();
    await captured.commands["glean-url"].handler("", transient);
    assert.match(transient.notes.at(-1).message, /never saved/);

    // After /glean-save the same command yields a link.
    respond = savedResponder("chat-saved-2");
    await captured.commands["glean-save"].handler("--new", handoffCtx());
    const saved = handoffCtx();
    await captured.commands["glean-url"].handler("", saved);
    assert.match(saved.notes.at(-1).message, /\/chat\/chat-saved-2/);
  });

  it("/glean-load pulls a web chat in and adopts its thread", async () => {
    respond = ({ res }) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          chatResult: {
            chat: {
              id: "web-chat-9",
              name: "Deploy questions",
              messages: [
                {
                  author: "USER",
                  messageType: "CONTENT",
                  fragments: [{ text: "what about staging?" }],
                },
                {
                  author: "GLEAN_AI",
                  messageType: "CONTENT",
                  fragments: [
                    {
                      text: "staging deploys from main",
                      citation: {
                        sourceDocument: {
                          title: "Runbook",
                          url: "https://w/rb",
                        },
                      },
                    },
                  ],
                },
              ],
            },
          },
        }),
      );
    };
    const ctx = handoffCtx();
    await captured.commands["glean-load"].handler(
      "https://acme.glean.com/chat/web-chat-9",
      ctx,
    );

    assert.equal(lastRequestBody.id, "web-chat-9");
    assert.equal(sentMessages.length, 1);
    const content = sentMessages[0].content;
    assert.match(content, /Loaded Glean chat: Deploy questions/);
    assert.match(content, /## You \(in Glean\)\n\nwhat about staging\?/);
    assert.match(content, /## Glean\n\nstaging deploys from main/);
    assert.match(content, /\[Runbook\]\(https:\/\/w\/rb\)/);
    assert.ok(
      captured.entries.some(
        (e) => e.chatId === "web-chat-9" && e.saved === true,
      ),
    );

    // Follow-up tool calls continue the loaded chat.
    respond = savedResponder("web-chat-9");
    await captured.tool.execute(
      "call-y",
      { message: "follow up" },
      undefined,
      undefined,
      undefined,
    );
    assert.equal(lastRequestBody.chatId, "web-chat-9");
  });

  describe("progress indicator", () => {
    /** Content of the last non-clearing progress widget update, if any. */
    function lastProgressLine(ctx: any): string | undefined {
      const shown = ctx.widgetCalls.filter(
        (c: any) => c.key === "glean-progress" && c.content !== undefined,
      );
      return shown.at(-1)?.content[0];
    }

    it("/glean-save shows a progress widget and clears it when done", async () => {
      respond = ({ res }) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.write(
          JSON.stringify({
            chatId: "chat-progress-1",
            ...gleanMsg("u1", "UPDATE", "searching Confluence"),
          }) + "\n",
        );
        res.write(
          JSON.stringify(gleanMsg("c1", "CONTENT", "You were deploying.")) +
            "\n",
        );
        res.end();
      };
      const ctx = handoffCtx();
      await captured.commands["glean-save"].handler("--new", ctx);

      const forWidget = ctx.widgetCalls.filter(
        (c: any) => c.key === "glean-progress",
      );
      assert.ok(forWidget.length > 1, "progress widget was never rendered");
      assert.ok(
        forWidget.some((c: any) =>
          c.content?.[0]?.includes("Saving session to Glean"),
        ),
      );
      // Glean's own phase text reaches the line.
      assert.ok(
        forWidget.some((c: any) =>
          c.content?.[0]?.includes("searching Confluence"),
        ),
      );
      // ...and it is torn down afterwards, in both surfaces.
      assert.equal(forWidget.at(-1).content, undefined);
      assert.equal(ctx.widgets["glean-progress"], undefined);
      assert.equal(ctx.statuses["glean-progress"], "");
    });

    it("/glean-save clears the progress widget on error", async () => {
      respond = ({ res }) => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("boom");
      };
      const ctx = handoffCtx();
      await captured.commands["glean-save"].handler("--new", ctx);

      assert.match(ctx.notes.at(-1).message, /Glean error/);
      assert.equal(ctx.widgets["glean-progress"], undefined);
      assert.equal(ctx.statuses["glean-progress"], "");
    });

    it("/glean-load shows and clears its own progress line", async () => {
      respond = ({ res }) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            chatResult: {
              chat: {
                id: "web-chat-p",
                messages: [
                  {
                    author: "GLEAN_AI",
                    messageType: "CONTENT",
                    fragments: [{ text: "hi" }],
                  },
                ],
              },
            },
          }),
        );
      };
      const ctx = handoffCtx();
      await captured.commands["glean-load"].handler("web-chat-p", ctx);

      assert.match(lastProgressLine(ctx) ?? "", /Loading Glean chat/);
      assert.equal(ctx.widgets["glean-progress"], undefined);
    });

    it("/glean shows and clears its own progress line", async () => {
      // /glean goes through the SDK (non-streaming), so answer with plain JSON.
      respond = ({ res }) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            chatId: "chat-progress-2",
            messages: [
              {
                author: "GLEAN_AI",
                messageType: "CONTENT",
                fragments: [{ text: "an answer" }],
              },
            ],
          }),
        );
      };
      const ctx = handoffCtx();
      await captured.commands["glean"].handler("what is up?", ctx);

      assert.match(lastProgressLine(ctx) ?? "", /Querying Glean/);
      assert.equal(ctx.widgets["glean-progress"], undefined);
    });
  });

  it("/glean-load rejects input with no chat id", async () => {
    const ctx = handoffCtx();
    await captured.commands["glean-load"].handler("  ", ctx);
    assert.match(ctx.notes.at(-1).message, /Usage: \/glean-load/);
  });

  it("parses chat ids from bare ids and URLs", () => {
    assert.equal(parseChatId("abc123"), "abc123");
    assert.equal(parseChatId("https://acme.glean.com/chat/abc123"), "abc123");
    assert.equal(
      parseChatId("https://acme.glean.com/chat/agents/abc123?x=1"),
      "abc123",
    );
    assert.equal(parseChatId("not a chat id"), undefined);
    assert.equal(parseChatId(""), undefined);
  });
});

// ── saveChat opt-in ───────────────────────────────────────────────────────────

describe("GLEAN_SAVE_CHATS", () => {
  afterEach(() => {
    delete process.env.GLEAN_SAVE_CHATS;
  });

  async function askTool() {
    respond = ndjsonResponder([
      { chatId: "chat-optin", ...gleanMsg("c1", "CONTENT", "a") },
    ]);
    await captured.tool.execute(
      "call-z",
      { message: "q", new_conversation: true },
      undefined,
      undefined,
      undefined,
    );
  }

  it("omits saveChat by default", async () => {
    await askTool();
    assert.equal(lastRequestBody.saveChat, undefined);
  });

  it("sets saveChat when enabled", async () => {
    process.env.GLEAN_SAVE_CHATS = "1";
    await askTool();
    assert.equal(lastRequestBody.saveChat, true);
    assert.ok(
      captured.entries.some(
        (e) => e.chatId === "chat-optin" && e.saved === true,
      ),
    );
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

// ── Configuration resolution ──────────────────────────────────────────────────

/**
 * Env vars and ~/.pi/agent/auth.json both configure the backend. The file path is
 * what makes the extension usable outside an interactive shell: the model surface
 * registers only when a URL resolves, so an env-only lookup reported
 * `Model "glean" not found` under cron, launchd and `env -i` even with a valid
 * credential already stored in auth.json.
 */
describe("configuration resolution", () => {
  const KEYS = [
    "GLEAN_BACKEND_URL",
    "GLEAN_INSTANCE",
    "GLEAN_API_TOKEN",
    "GLEAN_WEB_URL",
    "HOME",
  ] as const;
  let saved: Record<string, string | undefined>;
  let home: string;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])) as any;
    for (const k of KEYS) delete process.env[k];
    home = mkdtempSync(join(tmpdir(), "glean-cfg-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
    rmSync(home, { recursive: true, force: true });
  });

  /** Write a `glean` entry into $HOME/.pi/agent/auth.json. */
  function writeAuth(glean: unknown) {
    const dir = join(home, ".pi", "agent");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ glean }));
  }

  it("resolves the URL from GLEAN_BACKEND_URL", () => {
    process.env.GLEAN_BACKEND_URL = "https://acme-be.glean.com";
    assert.equal(resolveGleanBaseUrl(), "https://acme-be.glean.com");
  });

  it("derives the URL from GLEAN_INSTANCE", () => {
    process.env.GLEAN_INSTANCE = "acme";
    assert.equal(resolveGleanBaseUrl(), "https://acme-be.glean.com");
  });

  it("resolves the URL from auth.json env.GLEAN_BACKEND_URL with no env vars", () => {
    writeAuth({ type: "oauth", access: "t", env: { GLEAN_BACKEND_URL: "https://from-file-be.glean.com" } });
    assert.equal(resolveGleanBaseUrl(), "https://from-file-be.glean.com");
  });

  it("derives the URL from auth.json env.GLEAN_INSTANCE", () => {
    writeAuth({ type: "api_key", key: "k", env: { GLEAN_INSTANCE: "acme" } });
    assert.equal(resolveGleanBaseUrl(), "https://acme-be.glean.com");
  });

  it("accepts a bare backendUrl / instance on the auth entry", () => {
    writeAuth({ type: "api_key", key: "k", backendUrl: "https://bare-be.glean.com" });
    assert.equal(resolveGleanBaseUrl(), "https://bare-be.glean.com");
    writeAuth({ type: "api_key", key: "k", instance: "bare" });
    assert.equal(resolveGleanBaseUrl(), "https://bare-be.glean.com");
  });

  it("prefers env over auth.json", () => {
    writeAuth({ type: "api_key", key: "k", env: { GLEAN_BACKEND_URL: "https://file-be.glean.com" } });
    process.env.GLEAN_BACKEND_URL = "https://env-be.glean.com";
    assert.equal(resolveGleanBaseUrl(), "https://env-be.glean.com");
  });

  it("returns undefined when nothing configures a URL", () => {
    assert.equal(resolveGleanBaseUrl(), undefined);
    writeAuth({ type: "api_key", key: "k" });
    assert.equal(resolveGleanBaseUrl(), undefined);
  });

  it("normalizes trailing slashes and a /rest/api/v1 suffix", () => {
    process.env.GLEAN_BACKEND_URL = "https://acme-be.glean.com/rest/api/v1";
    assert.equal(resolveGleanBaseUrl(), "https://acme-be.glean.com");
    process.env.GLEAN_BACKEND_URL = "https://acme-be.glean.com///";
    assert.equal(resolveGleanBaseUrl(), "https://acme-be.glean.com");
  });

  it("defaults chat links to app.glean.com regardless of the backend host", () => {
    // The UI is served from one host; a tenant-derived https://acme.glean.com
    // does not resolve to the chat page.
    process.env.GLEAN_BACKEND_URL = "https://acme-be.glean.com";
    assert.equal(resolveGleanWebUrl(), "https://app.glean.com");
    assert.equal(gleanChatUrl("c1"), "https://app.glean.com/chat/c1");
  });

  it("prefers GLEAN_WEB_URL, then auth.json, over the default", () => {
    writeAuth({
      type: "api_key",
      key: "k",
      env: { GLEAN_WEB_URL: "https://from-file.glean.com/" },
    });
    assert.equal(resolveGleanWebUrl(), "https://from-file.glean.com");
    process.env.GLEAN_WEB_URL = "https://from-env.glean.com//";
    assert.equal(resolveGleanWebUrl(), "https://from-env.glean.com");
  });

  it("reads the file fresh each call, so /login and OAuth refresh are picked up", () => {
    writeAuth({ type: "api_key", key: "first" });
    assert.equal(resolveGleanToken(), "first");
    writeAuth({ type: "api_key", key: "second" });
    assert.equal(resolveGleanToken(), "second");
  });

  it("still prefers an explicit token, then env, then the file", () => {
    writeAuth({ type: "api_key", key: "from-file" });
    assert.equal(resolveGleanToken(), "from-file");
    process.env.GLEAN_API_TOKEN = "from-env";
    assert.equal(resolveGleanToken(), "from-env");
    assert.equal(resolveGleanToken("explicit"), "explicit");
  });

  it("ignores an expired OAuth entry but accepts env.GLEAN_API_TOKEN from the file", () => {
    writeAuth({ type: "oauth", access: "stale", expires: 1 });
    assert.equal(resolveGleanToken(), "");
    writeAuth({ type: "oauth", access: "stale", expires: 1, env: { GLEAN_API_TOKEN: "fallback" } });
    assert.equal(resolveGleanToken(), "fallback");
  });
});

// ── models.json ───────────────────────────────────────────────────────────────
//
// A user declaring Glean models in ~/.pi/agent/models.json. The extension reads
// the file as it loads (before any ExtensionContext exists), so each case points
// HOME at a temp dir, writes a models.json, and re-runs the extension factory
// against a fresh stub.

describe("models.json providers", () => {
  let savedHome: string | undefined;
  let home: string;

  /** Load the extension against a fresh stub with the given models.json. */
  async function loadWith(modelsJson: unknown) {
    const dir = join(home, ".pi", "agent");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "models.json"), JSON.stringify(modelsJson));
    const registered: { name: string; config: any }[] = [];
    const stub = {
      ...piStub,
      registerProvider: (name: string, config: any) =>
        registered.push({ name, config }),
    } as any;
    const ext = await import("./index.ts");
    ext.default(stub);
    return registered;
  }

  beforeEach(() => {
    savedHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "glean-models-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("keeps models declared under the glean provider alongside the built-in", async () => {
    // A provider config from an extension replaces the model list wholesale, so
    // without the merge these would vanish.
    const registered = await loadWith({
      providers: {
        glean: {
          models: [
            { id: "glean-advanced", samplingParams: { agent: "ADVANCED" } },
          ],
        },
      },
    });
    const glean = registered.find((p) => p.name === "glean")!;
    assert.deepEqual(
      glean.config.models.map((m: any) => m.id),
      ["glean-assistant", "glean-advanced"],
    );
    const advanced = glean.config.models[1];
    assert.deepEqual(advanced.samplingParams, { agent: "ADVANCED" });
    // Fields models.json leaves out are filled from the built-in, which pi
    // requires but models.json treats as optional.
    assert.equal(advanced.name, "glean-advanced");
    assert.equal(advanced.contextWindow, 128000);
  });

  it("lets a models.json entry override the built-in model by id", async () => {
    const registered = await loadWith({
      providers: {
        glean: { models: [{ id: "glean-assistant", contextWindow: 32000 }] },
      },
    });
    const glean = registered.find((p) => p.name === "glean")!;
    assert.equal(glean.config.models.length, 1);
    assert.equal(glean.config.models[0].contextWindow, 32000);
    // Overriding a field must not cost the model its display name.
    assert.equal(glean.config.models[0].name, "Glean Assistant");
  });

  it("lends the oauth flow to a user-declared provider id", async () => {
    // models.json cannot express an OAuth method (its `oauth` field only takes
    // "radius"), so /login glean-corp only works because we register one.
    const registered = await loadWith({
      providers: {
        "glean-corp": {
          api: "glean-chat",
          baseUrl: "https://corp-be.glean.com",
          models: [{ id: "glean-advanced" }],
        },
      },
    });
    const corp = registered.find((p) => p.name === "glean-corp");
    assert.ok(corp, "glean-corp should be registered");
    assert.equal(typeof corp!.config.oauth.login, "function");
    assert.equal(corp!.config.api, "glean-chat");
    assert.equal(typeof corp!.config.streamSimple, "function");
    // Neither may be set: both would override what the user wrote.
    assert.equal(corp!.config.models, undefined);
    assert.equal(corp!.config.baseUrl, undefined);
  });

  it("ignores providers that do not use the glean-chat api", async () => {
    const registered = await loadWith({
      providers: {
        "my-proxy": {
          api: "openai-completions",
          baseUrl: "https://proxy.example.com",
        },
      },
    });
    assert.equal(
      registered.find((p) => p.name === "my-proxy"),
      undefined,
    );
  });

  it("recognizes the api declared at model level", async () => {
    const registered = await loadWith({
      providers: {
        "glean-eu": {
          baseUrl: "https://eu-be.glean.com",
          models: [{ id: "glean-assistant", api: "glean-chat" }],
        },
      },
    });
    assert.ok(registered.find((p) => p.name === "glean-eu"));
  });

  it("survives a malformed models.json", async () => {
    const dir = join(home, ".pi", "agent");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "models.json"), "{ not json");
    const registered: { name: string; config: any }[] = [];
    const ext = await import("./index.ts");
    ext.default({
      ...piStub,
      registerProvider: (name: string, config: any) =>
        registered.push({ name, config }),
    } as any);
    // The built-in surface still registers; pi reports the parse error itself.
    assert.ok(registered.find((p) => p.name === "glean"));
  });

  it("binds each provider's oauth flow to its own backend", async () => {
    // pi hands the login function no provider context, so the URL has to be
    // captured at registration — otherwise a second tenant authenticates
    // against whatever GLEAN_BACKEND_URL happens to say.
    const registered = await loadWith({
      providers: {
        "glean-corp": { api: "glean-chat", baseUrl },
      },
    });
    const corp = registered.find((p) => p.name === "glean-corp")!;
    const savedBackend = process.env.GLEAN_BACKEND_URL;
    process.env.GLEAN_BACKEND_URL = "http://127.0.0.1:1"; // nothing listening
    try {
      const creds = await corp.config.oauth.login({
        onAuth: ({ url }: { url: string }) => {
          const authUrl = new URL(url);
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
    } finally {
      if (savedBackend === undefined) delete process.env.GLEAN_BACKEND_URL;
      else process.env.GLEAN_BACKEND_URL = savedBackend;
    }
  });
});
