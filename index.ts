/**
 * glean-chat — pi coding agent extension
 *
 * Three surfaces:
 *
 *   1. glean_chat tool  — LLM-callable; consults Glean mid-task.
 *                         Threads conversations via chatId across tool calls.
 *
 *   2. /glean command   — interactive query with no LLM round-trip.
 *                         Answer injected as a displayed session message.
 *                         /glean --new <question> resets the thread.
 *                         /glean-mode [fast|advanced|auto] sets the reasoning
 *                         mode used by all surfaces (default via
 *                         GLEAN_REASONING_MODE, else auto).
 *
 *   3. glean model      — "glean / Glean Assistant" selectable via /model.
 *                         Streams via ND-JSON (stream: true). No tool calling,
 *                         no system prompt, no usage data. Disable with
 *                         GLEAN_ENABLE_MODEL_SURFACE=0.
 *
 * Required env vars:
 *   GLEAN_BACKEND_URL  — e.g. https://mycompany-be.glean.com
 *                        (or set GLEAN_INSTANCE as fallback)
 *   GLEAN_INSTANCE     — instance name, e.g. "mycompany"
 *
 * Token: /login glean (OAuth via Glean's authorization server + your SSO,
 * persisted in ~/.pi/agent/auth.json), or paste an API key at /login, or
 * export GLEAN_API_TOKEN.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { Glean } from "@gleanwork/api-client";
import type { ChatMessage } from "@gleanwork/api-client/models/components";

// ── Client ────────────────────────────────────────────────────────────────────

/**
 * Resolve the Glean API token with the following precedence:
 *   1. Explicit argument (passed by the caller)
 *   2. GLEAN_API_TOKEN env var
 *   3. ~/.pi/agent/auth.json  glean entry (api_key, or unexpired oauth access)
 */
function resolveGleanToken(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.GLEAN_API_TOKEN) return process.env.GLEAN_API_TOKEN;
  try {
    const authPath = join(homedir(), ".pi", "agent", "auth.json");
    const auth = JSON.parse(readFileSync(authPath, "utf-8")) as Record<
      string,
      unknown
    >;
    const glean = auth?.glean as Record<string, unknown> | undefined;
    if (
      glean?.type === "api_key" &&
      typeof glean?.key === "string" &&
      glean.key
    )
      return glean.key;
    if (
      glean?.type === "oauth" &&
      typeof glean?.access === "string" &&
      glean.access &&
      (typeof glean?.expires !== "number" || glean.expires > Date.now())
    )
      return glean.access;
  } catch {
    // auth.json absent or unreadable — fall through
  }
  return "";
}

/**
 * Resolve the token via pi's auth storage when a context is available.
 * This path refreshes OAuth tokens automatically; falls back to env/auth.json.
 */
async function resolveTokenViaPi(
  ctx?: Pick<ExtensionContext, "modelRegistry">,
): Promise<string> {
  try {
    const key = await ctx?.modelRegistry?.getApiKeyForProvider?.("glean");
    if (key) return key;
  } catch {
    // provider not registered or resolution failed — fall through
  }
  return resolveGleanToken();
}

// Captured on session_start; lets tool/command surfaces resolve tokens via
// pi's auth storage (OAuth-aware, auto-refreshing).
let piContext: Pick<ExtensionContext, "modelRegistry"> | undefined;

function makeClient(): Glean {
  const serverURL = process.env.GLEAN_BACKEND_URL;
  const instance = process.env.GLEAN_INSTANCE;
  return new Glean({
    // Async provider: resolved per request, so OAuth refresh via pi's auth
    // storage is picked up without rebuilding the client.
    apiToken: () => resolveTokenViaPi(piContext),
    ...(serverURL ? { serverURL } : instance ? { instance } : {}),
  });
}

// Lazily created; reset on session_start so token/URL changes after /reload
// are picked up.
let _client: Glean | undefined;

function getClient(): Glean {
  return (_client ??= makeClient());
}

// ── Session state ─────────────────────────────────────────────────────────────

interface GleanState {
  chatId?: string; // tool + /glean command thread
  reasoningMode?: ReasoningMode; // agentic engine reasoning effort
}

let state: GleanState = {};

const STATE_ENTRY_TYPE = "glean-chat-state" as const;

// ── Reasoning mode ────────────────────────────────────────────────────────────
//
// Selects the Glean agent that executes a chat request (agentConfig.agent).
// Only the agentic-engine agents are exposed here; they require the agentic
// engine to be enabled in the Glean deployment.
//   FAST     — faster, lower-quality results.
//   ADVANCED — thinks longer, more LLM calls, higher-quality results.
//   AUTO     — routes between reasoning efforts based on the question/context.

type ReasoningMode = "FAST" | "ADVANCED" | "AUTO";

const REASONING_MODES: readonly ReasoningMode[] = ["FAST", "ADVANCED", "AUTO"];

/** Parse a user-supplied string into a ReasoningMode (case-insensitive). */
function normalizeReasoningMode(input: string): ReasoningMode | undefined {
  const v = input.trim().toUpperCase();
  return (REASONING_MODES as readonly string[]).includes(v)
    ? (v as ReasoningMode)
    : undefined;
}

/** Default mode from GLEAN_REASONING_MODE env var, else AUTO. */
function defaultReasoningMode(): ReasoningMode {
  return (
    normalizeReasoningMode(process.env.GLEAN_REASONING_MODE ?? "") ?? "AUTO"
  );
}

/** Active mode: session override (via /glean-mode) or the env/default. */
function currentReasoningMode(): ReasoningMode {
  return state.reasoningMode ?? defaultReasoningMode();
}

/**
 * agentConfig payload applied to a Glean chat request. An explicit `override`
 * (e.g. a per-call `reasoning` tool argument) wins over the session/env mode.
 */
function reasoningAgentConfig(override?: ReasoningMode): { agent: ReasoningMode } {
  return { agent: override ?? currentReasoningMode() };
}

// State captured from session/model events so the custom footer can render the
// active Glean model and reasoning mode. When the Glean model is selected we
// replace pi's footer entirely (Glean exposes no token/context/cost data, so
// there is nothing to reimplement); switching to any other model restores the
// built-in footer.
let activeIsGlean = false;
let gleanFooterActive = false;
let footerModel: { id: string; provider: string } = {
  id: "glean-assistant",
  provider: "glean",
};
let footerCwd = process.cwd();

// Minimal structural type for a TUI footer component (pi's Component type is
// not re-exported from the package root).
type FooterComponent = { render(width: number): string[]; dispose?(): void };

/** True when a model belongs to the Glean provider. */
function isGleanModel(model: { provider?: string } | undefined): boolean {
  return model?.provider === "glean";
}

/** Visible width of a string, ignoring ANSI SGR escape codes. */
function visibleWidth(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "").length;
}

/** Truncate a plain (uncolored) string to width, adding an ellipsis if needed. */
function truncatePlain(s: string, width: number): string {
  if (width <= 0) return "";
  return s.length > width ? s.slice(0, Math.max(0, width - 1)) + "\u2026" : s;
}

/** Replace the home-directory prefix with ~ for compact display. */
function formatCwd(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (!home) return cwd;
  if (cwd === home) return "~";
  if (cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
  return cwd;
}

/**
 * Build a custom footer for the Glean model: a dim pwd line plus a right-aligned
 * `(provider) model • <reasoning>` line, mirroring pi's built-in footer layout
 * minus the token/context stats Glean does not provide. Reads the reasoning mode
 * live, so /glean-mode changes are reflected on the next render.
 */
function makeGleanFooter(
  theme: { fg(color: string, text: string): string },
  footerData: {
    getGitBranch(): string | null;
    getAvailableProviderCount(): number;
  },
): FooterComponent {
  return {
    render(width: number): string[] {
      let pwd = formatCwd(footerCwd);
      const branch = footerData.getGitBranch?.();
      if (branch) pwd = `${pwd} (${branch})`;
      const pwdLine = theme.fg("dim", truncatePlain(pwd, width));

      const showProvider = (footerData.getAvailableProviderCount?.() ?? 1) > 1;
      const modelSeg = showProvider
        ? `(${footerModel.provider}) ${footerModel.id}`
        : footerModel.id;
      const right = truncatePlain(
        `${modelSeg} • ${currentReasoningMode().toLowerCase()}`,
        width,
      );
      const pad = " ".repeat(Math.max(0, width - visibleWidth(right)));
      const modelLine = theme.fg("dim", pad + right);

      return [pwdLine, modelLine];
    },
  };
}

/**
 * Install the custom footer when the Glean model is active, or restore pi's
 * built-in footer when switching away. Only acts in TUI mode; no-ops elsewhere.
 */
function applyGleanFooter(
  ui: ExtensionUIContext | undefined,
  mode: string | undefined,
): void {
  if (!ui?.setFooter) return;
  if (mode && mode !== "tui") return;
  if (activeIsGlean) {
    ui.setFooter((_tui, theme, footerData) =>
      makeGleanFooter(theme as any, footerData as any),
    );
    gleanFooterActive = true;
  } else if (gleanFooterActive) {
    ui.setFooter(undefined); // restore built-in footer
    gleanFooterActive = false;
  }
}

// ── Response helpers ──────────────────────────────────────────────────────────

/**
 * Extract the GLEAN_AI answer text from a Glean messages array.
 *
 * Glean returns many non-USER messages with different messageTypes
 * (UPDATE, HEADING, CONTEXT, CONTROL_*, SERVER_TOOL, WARNING, DEBUG, CONTENT).
 * The actual answer lives in CONTENT messages, and may be split across several
 * of them. Reading only the last non-USER message breaks whenever the final
 * message is a non-CONTENT (status/control/citation) message — yielding an
 * empty answer with only a Sources block. This mirrors the streaming path by
 * concatenating every CONTENT message's text.
 */
function extractAiText(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.author === "USER") continue;
    if ((msg.messageType ?? "CONTENT") !== "CONTENT") continue;
    const text = (msg.fragments ?? []).map((f) => f.text ?? "").join("");
    if (text) parts.push(text);
  }
  // Fallback: if no CONTENT messages carried text (unusual message shapes),
  // fall back to the last non-USER message so we never silently drop an answer.
  if (!parts.length) {
    const aiMsgs = messages.filter((m) => m.author !== "USER");
    const last = aiMsgs[aiMsgs.length - 1];
    return last ? (last.fragments ?? []).map((f) => f.text ?? "").join("") : "";
  }
  return parts.join("\n\n");
}

/**
 * Build a deduplicated markdown citations block.
 * Citations live on fragment.citation.sourceDocument (inline, current API)
 * and on the deprecated top-level message.citations array.
 */
function formatCitations(messages: ChatMessage[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];

  function add(title: string | undefined, url: string | undefined) {
    if (url && !seen.has(url)) {
      seen.add(url);
      lines.push(`- [${title ?? url}](${url})`);
    }
  }

  for (const msg of messages) {
    // Inline citations (current API): fragment.citation.sourceDocument
    for (const frag of msg.fragments ?? []) {
      const doc = frag.citation?.sourceDocument;
      if (doc) add(doc.title, doc.url);
    }
    // Deprecated top-level citations (still populated for back-compat)
    for (const cit of msg.citations ?? []) {
      const doc = cit.sourceDocument;
      if (doc) add(doc.title, doc.url);
    }
  }

  return lines.length ? "\n\n**Sources:**\n" + lines.join("\n") : "";
}

// ── OAuth (Glean Authorization Server) ──────────────────────────────────────
//
// Authorization Code + PKCE against Glean's OAuth 2.1 server (OAuth 2.1
// requires PKCE; Glean advertises S256). The client is registered via
// Dynamic Client Registration (RFC 7591) as a public client
// (token_endpoint_auth_method: none). Requires the Glean admin to have
// enabled the OAuth Authorization Server; falls back to API-key login
// otherwise. Scopes: chat (Chat API) + offline_access (refresh token).
//
// The registered client_id is persisted on the credentials object so
// refreshToken() can reuse it (OAuthCredentials allows extra fields).

const OAUTH_SCOPES = "chat offline_access";
const OAUTH_CALLBACK_PATH = "/callback";

interface OAuthServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

async function fetchOAuthMetadata(baseUrl: string): Promise<OAuthServerMetadata> {
  const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
  if (!res.ok)
    throw new Error(
      `Glean OAuth server metadata unavailable (${res.status}). ` +
        "Ask your Glean admin to enable the OAuth Authorization Server, " +
        "or use an API key instead.",
    );
  return (await res.json()) as OAuthServerMetadata;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const verifier = base64url(raw);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/** Register a public client via DCR for the given redirect URI. */
async function registerOAuthClient(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<string> {
  const res = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "pi-glean-chat",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: OAUTH_SCOPES,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Glean OAuth client registration failed (${res.status}): ${body.slice(0, 300)}. ` +
        "Dynamic Client Registration may be restricted on this tenant — " +
        "use an API key instead, or ask your admin for a static client.",
    );
  }
  const data = (await res.json()) as { client_id?: string };
  if (!data.client_id) throw new Error("DCR response missing client_id");
  return data.client_id;
}

/** Wait for the OAuth redirect on a loopback server; resolves with the code. */
function waitForCallback(
  port: number,
  expectedState: string,
): { promise: Promise<string>; close: () => void } {
  let close = () => {};
  const promise = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        close();
        reject(new Error("OAuth login timed out after 5 minutes"));
      },
      5 * 60 * 1000,
    );
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== OAUTH_CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (err || !code || state !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h3>Login failed. Return to pi for details.</h3>");
        clearTimeout(timeout);
        close();
        reject(
          new Error(
            err
              ? `OAuth error: ${err} ${url.searchParams.get("error_description") ?? ""}`
              : "OAuth callback missing code or state mismatch",
          ),
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h3>Signed in to Glean. You can close this tab.</h3>");
      clearTimeout(timeout);
      close();
      resolve(code);
    });
    close = () => server.close();
    server.listen(port, "127.0.0.1");
    server.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
  });
  return { promise, close };
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

async function exchangeToken(
  tokenEndpoint: string,
  params: Record<string, string>,
): Promise<TokenResponse> {
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Glean token request failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return (await res.json()) as TokenResponse;
}

function credentialsFromTokens(
  tokens: TokenResponse,
  clientId: string,
  previousRefresh?: string,
): OAuthCredentials {
  return {
    access: tokens.access_token,
    refresh: tokens.refresh_token ?? previousRefresh ?? "",
    // Refresh 5 minutes early; default to 55 minutes if expires_in absent.
    expires: Date.now() + ((tokens.expires_in ?? 3600) - 300) * 1000,
    clientId,
  };
}

async function loginGlean(
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  const baseUrl = resolveGleanBaseUrl();
  if (!baseUrl)
    throw new Error("Set GLEAN_BACKEND_URL or GLEAN_INSTANCE before /login glean");

  const meta = await fetchOAuthMetadata(baseUrl);
  if (!meta.registration_endpoint)
    throw new Error(
      "Glean OAuth server does not expose Dynamic Client Registration — " +
        "use an API key instead, or ask your admin for a static client.",
    );

  // Random loopback port: register, then authorize.
  const port = 49152 + Math.floor(Math.random() * 16000);
  const redirectUri = `http://127.0.0.1:${port}${OAUTH_CALLBACK_PATH}`;
  const clientId = await registerOAuthClient(meta.registration_endpoint, redirectUri);

  const { verifier, challenge } = await generatePKCE();
  const stateParam = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const authUrl = new URL(meta.authorization_endpoint);
  authUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: OAUTH_SCOPES,
    state: stateParam,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  const callback = waitForCallback(port, stateParam);
  callbacks.onAuth({ url: authUrl.toString() });
  const code = await callback.promise;

  const tokens = await exchangeToken(meta.token_endpoint, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
  return credentialsFromTokens(tokens, clientId);
}

async function refreshGleanToken(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  const baseUrl = resolveGleanBaseUrl();
  if (!baseUrl) throw new Error("GLEAN_BACKEND_URL / GLEAN_INSTANCE not set");
  const clientId = typeof credentials.clientId === "string" ? credentials.clientId : "";
  if (!credentials.refresh || !clientId)
    throw new Error("No refresh token or client_id — run /login glean again");
  const meta = await fetchOAuthMetadata(baseUrl);
  const tokens = await exchangeToken(meta.token_endpoint, {
    grant_type: "refresh_token",
    refresh_token: credentials.refresh,
    client_id: clientId,
  });
  return credentialsFromTokens(tokens, clientId, credentials.refresh);
}

// ── Model surface (provider) ──────────────────────────────────────────────────
//
// Registers `glean / Glean Assistant` as a selectable pi model. Routes the
// conversation through Glean Chat (/rest/api/v1/chat, stream: true, ND-JSON).
//
// Limitations (inherent to the Glean Chat API):
//   - No tool calling: Glean never emits toolUse; agentic loop is unavailable.
//   - System prompt, tool schemas, and tool results are stripped from context.
//   - No token usage data; cost stays zero.

/** Resolve the Glean backend base URL from env, normalized (no trailing /). */
function resolveGleanBaseUrl(): string | undefined {
  let url = process.env.GLEAN_BACKEND_URL;
  if (!url && process.env.GLEAN_INSTANCE)
    url = `https://${process.env.GLEAN_INSTANCE}-be.glean.com`;
  if (!url) return undefined;
  url = url.replace(/\/+$/, "");
  url = url.replace(/\/rest\/api\/v1$/, "");
  return url;
}

interface RawSourceDocument {
  title?: string;
  url?: string;
}
interface RawFragment {
  text?: string;
  citation?: { sourceDocument?: RawSourceDocument };
}
interface RawGleanMessage {
  author?: string;
  messageId?: string;
  messageType?: string;
  fragments?: RawFragment[];
  citations?: { sourceDocument?: RawSourceDocument }[];
}
interface RawGleanChatResponse {
  messages?: RawGleanMessage[];
}

/**
 * Map pi Context → Glean ChatMessage[].
 * Only user/assistant text survives; system prompt and tool traffic dropped.
 * Consecutive same-author messages are merged (Glean expects alternation).
 * Returned array is ordered MOST RECENT FIRST — the Glean Chat API contract
 * is "a list of chat messages, from most recent to least recent".
 */
function buildGleanMessages(context: Context): {
  author: "USER" | "GLEAN_AI";
  messageType: "CONTENT";
  fragments: { text: string }[];
}[] {
  const out: {
    author: "USER" | "GLEAN_AI";
    messageType: "CONTENT";
    fragments: { text: string }[];
  }[] = [];

  function push(author: "USER" | "GLEAN_AI", text: string) {
    if (!text.trim()) return;
    const last = out[out.length - 1];
    if (last && last.author === author) {
      last.fragments.push({ text: "\n\n" + text });
    } else {
      out.push({ author, messageType: "CONTENT", fragments: [{ text }] });
    }
  }

  for (const msg of context.messages) {
    if (msg.role === "user") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .filter((c) => c.type === "text")
              .map((c) => (c as { text: string }).text)
              .join("\n");
      push("USER", text);
    } else if (msg.role === "assistant") {
      const text = msg.content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join("\n");
      push("GLEAN_AI", text);
    }
    // toolResult messages are dropped — Glean has no tool concept.
  }

  // Glean expects a USER-authored current question. Chronologically that is
  // the last message; ensure it exists, then reverse to most-recent-first.
  if (!out.length || out[out.length - 1].author !== "USER")
    push("USER", "(continue)");

  return out.reverse();
}

function streamGlean(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    // Block state: Glean streams fragments as per-token deltas scoped to a
    // messageId; a change of messageId marks a new message. Thinking blocks
    // hold UPDATE/HEADING progress; one text block accumulates all CONTENT.
    let thinkingIndex = -1;
    let textIndex = -1;
    let thinkingMsgId: string | undefined;
    let textMsgId: string | undefined;
    const citations = new Map<string, string>(); // url -> title

    function collectCitations(msg: RawGleanMessage) {
      for (const frag of msg.fragments ?? []) {
        const doc = frag.citation?.sourceDocument;
        if (doc?.url && !citations.has(doc.url))
          citations.set(doc.url, doc.title ?? doc.url);
      }
      for (const cit of msg.citations ?? []) {
        const doc = cit.sourceDocument;
        if (doc?.url && !citations.has(doc.url))
          citations.set(doc.url, doc.title ?? doc.url);
      }
    }

    function endThinking() {
      if (thinkingIndex < 0) return;
      const block = output.content[thinkingIndex];
      if (block.type === "thinking") {
        stream.push({
          type: "thinking_end",
          contentIndex: thinkingIndex,
          content: block.thinking,
          partial: output,
        });
      }
      thinkingIndex = -1;
      thinkingMsgId = undefined;
    }

    function pushThinkingDelta(delta: string) {
      if (!delta) return;
      endText(); // keep blocks in chronological order when interleaved
      if (thinkingIndex < 0) {
        output.content.push({ type: "thinking", thinking: "" });
        thinkingIndex = output.content.length - 1;
        stream.push({
          type: "thinking_start",
          contentIndex: thinkingIndex,
          partial: output,
        });
      }
      const block = output.content[thinkingIndex];
      if (block.type === "thinking") block.thinking += delta;
      stream.push({
        type: "thinking_delta",
        contentIndex: thinkingIndex,
        delta,
        partial: output,
      });
    }

    function pushTextDelta(delta: string) {
      if (!delta) return;
      endThinking();
      if (textIndex < 0) {
        output.content.push({ type: "text", text: "" });
        textIndex = output.content.length - 1;
        stream.push({
          type: "text_start",
          contentIndex: textIndex,
          partial: output,
        });
      }
      const block = output.content[textIndex];
      if (block.type === "text") block.text += delta;
      stream.push({
        type: "text_delta",
        contentIndex: textIndex,
        delta,
        partial: output,
      });
    }

    function endText() {
      if (textIndex < 0) return;
      const block = output.content[textIndex];
      if (block.type === "text") {
        stream.push({
          type: "text_end",
          contentIndex: textIndex,
          content: block.text,
          partial: output,
        });
      }
      textIndex = -1;
    }

    function processLine(line: string) {
      let parsed: RawGleanChatResponse;
      try {
        parsed = JSON.parse(line) as RawGleanChatResponse;
      } catch {
        return; // tolerate keep-alives / non-JSON lines
      }
      for (const msg of parsed.messages ?? []) {
        if (msg.author === "USER") continue;
        collectCitations(msg);
        const mt = msg.messageType ?? "CONTENT";
        const text = (msg.fragments ?? []).map((f) => f.text ?? "").join("");
        if (mt === "ERROR") {
          throw new Error(text || "Glean returned an error message");
        } else if (mt === "UPDATE" || mt === "HEADING") {
          if (!text) continue;
          // New message (or first): separate from previous thinking content.
          const isNew =
            thinkingIndex < 0 ||
            (msg.messageId !== undefined && msg.messageId !== thinkingMsgId);
          pushThinkingDelta(isNew && thinkingIndex >= 0 ? "\n" + text : text);
          if (msg.messageId !== undefined) thinkingMsgId = msg.messageId;
        } else if (mt === "CONTENT") {
          if (!text) continue;
          // New CONTENT message: paragraph break from previous content.
          const isNew =
            textIndex >= 0 &&
            msg.messageId !== undefined &&
            msg.messageId !== textMsgId;
          pushTextDelta(isNew ? "\n\n" + text : text);
          if (msg.messageId !== undefined) textMsgId = msg.messageId;
        }
        // CONTROL_*, DEBUG*, WARNING, CONTEXT, SERVER_TOOL — ignored
      }
    }

    try {
      stream.push({ type: "start", partial: output });

      const token = options?.apiKey ?? resolveGleanToken();
      if (!token)
        throw new Error(
          "No Glean API token. Set GLEAN_API_TOKEN or store glean.key in ~/.pi/agent/auth.json",
        );

      const baseUrl = (model.baseUrl ?? resolveGleanBaseUrl() ?? "").replace(
        /\/+$/,
        "",
      );
      if (!baseUrl)
        throw new Error(
          "No Glean backend URL. Set GLEAN_BACKEND_URL or GLEAN_INSTANCE",
        );

      const response = await fetch(`${baseUrl}/rest/api/v1/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          messages: buildGleanMessages(context),
          agentConfig: reasoningAgentConfig(),
          stream: true,
        }),
        signal: options?.signal ?? null,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const hint =
          response.status === 401
            ? " (check GLEAN_API_TOKEN is a valid Client token with CHAT scope)"
            : "";
        throw new Error(
          `Glean API error ${response.status}${hint}: ${body.slice(0, 500)}`,
        );
      }
      if (!response.body) throw new Error("Glean API returned no body");

      // ND-JSON: one ChatResponse per line.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) processLine(line);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) processLine(buffer.trim());

      endThinking();

      // Append citations as a trailing Sources block.
      if (citations.size) {
        const sources =
          "\n\n**Sources:**\n" +
          [...citations.entries()]
            .map(([url, title]) => `- [${title}](${url})`)
            .join("\n");
        pushTextDelta(sources);
      }
      endText();

      if (!output.content.length)
        output.content.push({ type: "text", text: "(no response)" });

      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error) {
      endThinking();
      endText();
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage =
        error instanceof Error ? error.message : String(error);
      stream.push({
        type: "error",
        reason: output.stopReason as "aborted" | "error",
        error: output,
      });
      stream.end();
    }
  })();

  return stream;
}

// ── Extension entry point ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Model surface: glean / Glean Assistant. Registered only when a backend
  // URL is configured; disable explicitly with GLEAN_ENABLE_MODEL_SURFACE=0.
  const modelBaseUrl = resolveGleanBaseUrl();
  if (process.env.GLEAN_ENABLE_MODEL_SURFACE !== "0" && modelBaseUrl) {
    pi.registerProvider("glean", {
      name: "Glean",
      baseUrl: modelBaseUrl,
      apiKey: "$GLEAN_API_TOKEN",
      api: "glean-chat" as Api,
      models: [
        {
          id: "glean-assistant",
          name: "Glean Assistant",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        },
      ],
      oauth: {
        name: "Glean (SSO via OAuth)",
        login: loginGlean,
        refreshToken: refreshGleanToken,
        getApiKey: (credentials) => credentials.access,
      },
      streamSimple: streamGlean,
    });
  }

  // Restore conversation state from session; reset client so token/URL
  // changes take effect after /reload. Capture ctx for OAuth-aware token
  // resolution in the tool/command surfaces.
  pi.on("session_start", async (_event, ctx) => {
    piContext = ctx;
    footerCwd = ctx.cwd ?? process.cwd();
    activeIsGlean = isGleanModel(ctx.model);
    if (ctx.model) footerModel = { id: ctx.model.id, provider: ctx.model.provider };
    _client = undefined;
    state = { chatId: undefined };
    for (const entry of ctx.sessionManager.getEntries()) {
      if (
        entry.type === "custom" &&
        (entry as any).customType === STATE_ENTRY_TYPE
      ) {
        Object.assign(state, (entry as any).data ?? {});
      }
    }
    applyGleanFooter(ctx.ui, ctx.mode);
  });

  // Replace the footer with the Glean model + reasoning mode while the Glean
  // model is selected; restore pi's built-in footer on switching away.
  pi.on("model_select", async (event, ctx) => {
    footerCwd = ctx.cwd ?? footerCwd;
    activeIsGlean = isGleanModel(event.model);
    if (event.model)
      footerModel = { id: event.model.id, provider: event.model.provider };
    applyGleanFooter(ctx.ui, ctx.mode);
  });

  // ── Tool: glean_chat ────────────────────────────────────────────────────────

  pi.registerTool({
    name: "glean_chat",
    label: "Glean Chat",
    description:
      "Query Glean AI for both INTERNAL and EXTERNAL knowledge. Glean AI can " +
      "search private/internal resources (Confluence, Jira, Linear, Slack, " +
      "private GitHub repos, runbooks, policies, ADRs, and anything else " +
      "indexed in Glean) AND public resources on the internet (docs, web " +
      "pages, public GitHub repos). Prefer asking Glean a specific question " +
      "about a page rather than requesting a raw dump — e.g. ask 'review " +
      "https://registry.terraform.io/providers/Scalr/scalr/latest/docs/resources/environment_hook " +
      "and tell me how to import that resource' instead of 'print the last " +
      "100 lines of <url>'. If you truly need exact content, ask explicitly, " +
      "e.g. 'print the raw contents of <url>' or 'print the first 100 lines " +
      "of <url>'. Conversations are threaded — follow-up calls continue the " +
      "same chat session unless new_conversation is true. Pass reasoning: " +
      "ADVANCED for deep-research questions or reasoning: FAST for quick " +
      "answers.",
    promptSnippet:
      "Query Glean AI for internal AND external knowledge (private company " +
      "resources and public internet)",
    promptGuidelines: [
      "Use glean_chat for internal company knowledge (docs, runbooks, " +
        "policies, ADRs, Jira/Linear tickets, Confluence pages, Slack, private " +
        "GitHub repos) as well as external/public knowledge on the internet " +
        "(public docs, web pages, public GitHub repos).",
      "Use glean_chat when the user asks what the wiki or internal docs say " +
        "about a topic, or when you need company-specific context not available " +
        "in your training data.",
      "Prefer asking Glean a specific question about a page rather than " +
        "requesting a raw dump — e.g. 'review <url> and tell me how to import " +
        "that resource' instead of 'print the last 100 lines of <url>'. When " +
        "you genuinely need exact content, ask explicitly, e.g. 'print the raw " +
        "contents of <url>' or 'print the first 100 lines of <url>'.",
      "Set reasoning: ADVANCED for deep-research or multi-step questions that " +
        "benefit from longer thinking, and reasoning: FAST for simple lookups " +
        "where a quick answer is enough; omit it to use the session default.",
    ],
    parameters: Type.Object({
      message: Type.String({
        description: "The question to ask Glean AI.",
      }),
      new_conversation: Type.Optional(
        Type.Boolean({
          description:
            "Start a fresh conversation thread (clears chatId). Default false.",
        }),
      ),
      reasoning: Type.Optional(
        Type.Union(
          REASONING_MODES.map((m) => Type.Literal(m)),
          {
            description:
              "Reasoning effort for this query. ADVANCED thinks longer with " +
              "more LLM calls for deep-research questions; FAST returns quick, " +
              "lower-effort answers; AUTO lets Glean route automatically. " +
              "Defaults to the session/env reasoning mode.",
          },
        ),
      ),
    }),

    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const token = await resolveTokenViaPi(ctx ?? piContext);
      if (!token) {
        return {
          content: [
            {
              type: "text",
              text:
                "No Glean credentials. " +
                "Run /login and select glean (OAuth or API key), " +
                "or export GLEAN_API_TOKEN.",
            },
          ],
          details: {},
          isError: true,
        };
      }

      if (params.new_conversation) state.chatId = undefined;

      onUpdate?.({
        content: [{ type: "text", text: "Querying Glean..." }],
        details: {},
      });

      try {
        const response = await getClient().client.chat.create(
          {
            messages: [
              { author: "USER", fragments: [{ text: params.message }] },
            ],
            agentConfig: reasoningAgentConfig(params.reasoning),
            ...(state.chatId ? { chatId: state.chatId } : {}),
          },
          undefined, // locale
          undefined, // timezoneOffset
        );

        if (response.chatId) {
          state.chatId = response.chatId;
          pi.appendEntry(STATE_ENTRY_TYPE, { chatId: response.chatId });
        }

        const messages = response.messages ?? [];
        const text = extractAiText(messages);
        const citations = formatCitations(messages);

        return {
          content: [
            { type: "text", text: text + citations || "(no response)" },
          ],
          details: {
            chatId: response.chatId,
            followUpPrompts: response.followUpPrompts ?? [],
          },
        };
      } catch (err: any) {
        const status: number | undefined = err?.statusCode;
        const message: string = err?.message ?? String(err);
        const hint =
          status === 401
            ? " Check that GLEAN_API_TOKEN is a valid Client token."
            : status === 429
              ? " Rate limited — retry shortly."
              : "";
        return {
          content: [
            {
              type: "text",
              text: `Glean error${status ? ` (${status})` : ""}: ${message}${hint}`,
            },
          ],
          details: {},
          isError: true,
        };
      }
    },
  });

  // ── Command: /glean ─────────────────────────────────────────────────────────

  pi.registerCommand("glean", {
    description:
      "Query Glean AI. Usage: /glean <question>  |  /glean --new <question>",
    handler: async (args, ctx) => {
      const raw = args?.trim() ?? "";
      if (!raw) {
        ctx.ui.notify(
          "Usage: /glean <question>  |  /glean --new <question>",
          "info",
        );
        return;
      }

      let message = raw;
      let forceNew = false;
      if (message.startsWith("--new ")) {
        forceNew = true;
        message = message.slice(6).trim();
      }
      if (!message) {
        ctx.ui.notify("Provide a question after /glean [--new]", "info");
        return;
      }

      const token = await resolveTokenViaPi(ctx ?? piContext);
      if (!token) {
        ctx.ui.notify(
          "No Glean credentials — run /login and select glean, or export GLEAN_API_TOKEN",
          "error",
        );
        return;
      }

      if (forceNew) state.chatId = undefined;

      ctx.ui.setStatus("glean", "Querying Glean...");
      try {
        const response = await getClient().client.chat.create(
          {
            messages: [{ author: "USER", fragments: [{ text: message }] }],
            agentConfig: reasoningAgentConfig(),
            ...(state.chatId ? { chatId: state.chatId } : {}),
          },
          undefined, // locale
          undefined, // timezoneOffset
        );

        if (response.chatId) {
          state.chatId = response.chatId;
          pi.appendEntry(STATE_ENTRY_TYPE, { chatId: response.chatId });
        }

        const messages = response.messages ?? [];
        const text = extractAiText(messages);
        const citations = formatCitations(messages);
        const fullText = text + citations || "(no response)";

        // Inject the answer as a displayed session message so the LLM
        // (and the user in the conversation view) can read it.
        pi.sendMessage(
          {
            customType: "glean-response",
            content: `**Glean answer to:** ${message}\n\n${fullText}`,
            display: true,
          },
          { triggerTurn: false },
        );
      } catch (err: any) {
        ctx.ui.notify(
          `Glean error: ${(err?.message as string) ?? String(err)}`,
          "error",
        );
      } finally {
        ctx.ui.setStatus("glean", "");
      }
    },
  });

  // ── Command: /glean-mode ───────────────────────────────────────────────────

  pi.registerCommand("glean-mode", {
    description:
      "View, set, or toggle the Glean reasoning mode. " +
      "Usage: /glean-mode [fast|advanced|auto]  (no arg cycles to the next mode)",
    getArgumentCompletions: (prefix) => {
      const p = prefix.trim().toLowerCase();
      return REASONING_MODES.filter((m) =>
        m.toLowerCase().startsWith(p),
      ).map((m) => ({
        value: m.toLowerCase(),
        label: m.toLowerCase(),
        description:
          m === "FAST"
            ? "Faster, lower-quality results"
            : m === "ADVANCED"
              ? "Thinks longer, higher-quality results"
              : "Routes reasoning effort automatically",
      }));
    },
    handler: async (args, ctx) => {
      const arg = args?.trim() ?? "";

      let mode: ReasoningMode;
      if (!arg) {
        // No argument: cycle to the next mode.
        const idx = REASONING_MODES.indexOf(currentReasoningMode());
        mode = REASONING_MODES[(idx + 1) % REASONING_MODES.length];
      } else {
        const parsed = normalizeReasoningMode(arg);
        if (!parsed) {
          ctx.ui.notify(
            `Invalid mode "${arg}". Use one of: ${REASONING_MODES.map((m) =>
              m.toLowerCase(),
            ).join(", ")}.`,
            "error",
          );
          return;
        }
        mode = parsed;
      }

      state.reasoningMode = mode;
      pi.appendEntry(STATE_ENTRY_TYPE, { reasoningMode: mode });
      // Re-render the custom footer so the new mode shows immediately.
      applyGleanFooter(ctx.ui, ctx.mode);
      ctx.ui.notify(`Glean reasoning mode: ${mode}`, "info");
    },
  });
}
