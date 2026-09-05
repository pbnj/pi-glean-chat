/**
 * glean-chat — pi coding agent extension
 *
 * Three surfaces:
 *
 *   1. glean_chat tool  — LLM-callable; consults Glean mid-task.
 *                         Threads conversations via chatId across tool calls.
 *                         Streams the answer into the TUI via onUpdate.
 *
 *   2. /glean command   — interactive query with no LLM round-trip.
 *                         Answer injected as a displayed session message.
 *                         /glean --new <question> resets the thread.
 *                         /glean-mode [advanced|auto] sets the reasoning
 *                         mode used by all surfaces (default via
 *                         GLEAN_REASONING_MODE, else auto).
 *
 *   3. glean model      — "glean / Glean Assistant" selectable via /model.
 *                         Streams via ND-JSON (stream: true). No tool calling,
 *                         no system prompt, no usage data. Disable with
 *                         GLEAN_ENABLE_MODEL_SURFACE=0.
 *
 *                         The same surface is available to models.json: this
 *                         extension registers the `glean-chat` api with pi, so
 *                         a provider entry naming it routes through Glean too.
 *                         Such models pick their agent from
 *                         samplingParams.agent / thinkingLevelMap, and get the
 *                         OAuth login lent to their provider id.
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
  ProviderConfig,
  ProviderModelConfig,
  SessionEntry,
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
// The api-registry lives on the /compat subpath: the package root is core-only
// and does not re-export it. pi aliases both specifiers to its own pi-ai
// instance when loading extensions, so this registers into the very registry
// pi's provider composer reads from.
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { Glean } from "@gleanwork/api-client";
import type { ChatMessage } from "@gleanwork/api-client/models/components";

// ── Client ────────────────────────────────────────────────────────────────────

/**
 * The `glean` entry from ~/.pi/agent/auth.json, or undefined.
 *
 * Read on demand rather than cached: `/login` and OAuth refresh rewrite this file
 * mid-session, and a stale copy would pin an expired token.
 */
function readGleanAuthEntry(): Record<string, unknown> | undefined {
  try {
    const authPath = join(homedir(), ".pi", "agent", "auth.json");
    const auth = JSON.parse(readFileSync(authPath, "utf-8")) as Record<
      string,
      unknown
    >;
    return auth?.glean as Record<string, unknown> | undefined;
  } catch {
    // auth.json absent or unreadable
    return undefined;
  }
}

/**
 * A per-provider env override from auth.json, e.g.
 *   "glean": { "type": "oauth", …, "env": { "GLEAN_BACKEND_URL": "https://…" } }
 *
 * This mirrors how pi already stores provider-local settings (the `llama.cpp`
 * entry carries `env.LLAMA_BASE_URL`), so configuration lives beside the
 * credential instead of depending on the shell that launched pi.
 */
function authEnv(
  entry: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  const env = entry?.env as Record<string, unknown> | undefined;
  const value = env?.[name];
  return typeof value === "string" && value ? value : undefined;
}

// ── models.json ───────────────────────────────────────────────────────────────
//
// The pi `api` id this extension implements. Registered in pi's api registry
// (see the entry point) so a models.json provider entry can name it directly:
//
//   "providers": { "glean-corp": { "api": "glean-chat", "baseUrl": …, … } }
//
// pi resolves an unknown api through that registry at stream time, so any
// provider id — not just the `glean` one this extension registers itself — can
// route through Glean Chat.
const GLEAN_API = "glean-chat" as Api;

/** A model as it may appear in models.json: every field but `id` is optional. */
type ModelsJsonModel = Partial<ProviderModelConfig> & {
  id: string;
  samplingParams?: Record<string, unknown>;
};

/** A provider entry as it may appear in models.json. */
interface ModelsJsonProvider {
  name?: string;
  baseUrl?: string;
  api?: string;
  models?: ModelsJsonModel[];
}

/**
 * `providers` from ~/.pi/agent/models.json, or {}.
 *
 * Read directly rather than through pi, for the same reason `readGleanAuthEntry`
 * reads auth.json directly: provider registration happens as the extension
 * loads, before any ExtensionContext (and so any model registry) exists.
 */
function readModelsJsonProviders(): Record<string, ModelsJsonProvider> {
  try {
    const path = join(homedir(), ".pi", "agent", "models.json");
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      providers?: Record<string, ModelsJsonProvider>;
    };
    return parsed?.providers ?? {};
  } catch {
    // models.json absent, unreadable, or malformed — pi reports the parse error
    // itself; there is nothing useful this extension can add.
    return {};
  }
}

/** True when a models.json entry routes any of its models through Glean Chat. */
function usesGleanApi(entry: ModelsJsonProvider): boolean {
  return (
    entry.api === GLEAN_API ||
    (entry.models ?? []).some((model) => model.api === GLEAN_API)
  );
}

/** The backend URL a models.json entry talks to, provider level then model. */
function entryBaseUrl(entry: ModelsJsonProvider): string | undefined {
  return (
    entry.baseUrl ?? entry.models?.find((model) => model.baseUrl)?.baseUrl
  );
}

/** A registered model, plus the sampling params pi's public type omits. */
type GleanModelConfig = ProviderModelConfig & {
  samplingParams?: Record<string, unknown>;
};

/**
 * The built-in model plus any the user declared for the same provider in
 * models.json, with a matching `id` replacing the built-in rather than
 * duplicating it.
 *
 * The merge is necessary because a provider config supplied by an extension
 * *replaces* the model list wholesale — without it, declaring models under the
 * `glean` provider in models.json would silently drop them. Fields models.json
 * leaves out fall back to the built-in's, which pi requires but models.json
 * treats as optional.
 */
function mergeModelsJsonModels(
  builtIn: GleanModelConfig,
  entry: ModelsJsonProvider | undefined,
): GleanModelConfig[] {
  const models: GleanModelConfig[] = [builtIn];
  for (const model of entry?.models ?? []) {
    if (!model?.id) continue;
    const merged: GleanModelConfig = { ...builtIn, ...model };
    // Unnamed models fall back to their id, as pi's own models.json loader
    // does — except when overriding the built-in, whose name is worth keeping.
    if (!model.name && model.id !== builtIn.id) merged.name = model.id;
    const existing = models.findIndex((m) => m.id === merged.id);
    if (existing >= 0) models[existing] = merged;
    else models.push(merged);
  }
  return models;
}

/**
 * Resolve the Glean API token with the following precedence:
 *   1. Explicit argument (passed by the caller)
 *   2. GLEAN_API_TOKEN env var
 *   3. ~/.pi/agent/auth.json  glean entry (api_key, or unexpired oauth access,
 *      or an env.GLEAN_API_TOKEN override)
 */
export function resolveGleanToken(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.GLEAN_API_TOKEN) return process.env.GLEAN_API_TOKEN;
  const glean = readGleanAuthEntry();
  if (glean?.type === "api_key" && typeof glean?.key === "string" && glean.key)
    return glean.key;
  if (
    glean?.type === "oauth" &&
    typeof glean?.access === "string" &&
    glean.access &&
    (typeof glean?.expires !== "number" || glean.expires > Date.now())
  )
    return glean.access;
  return authEnv(glean, "GLEAN_API_TOKEN") ?? "";
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
  // Same resolution as the model surface (env, then auth.json), so the tool and
  // the provider can never disagree about which backend they are talking to.
  const serverURL = resolveGleanBaseUrl();
  const instance =
    process.env.GLEAN_INSTANCE ??
    authEnv(readGleanAuthEntry(), "GLEAN_INSTANCE");
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
  /**
   * True once the thread has been persisted server-side (`saveChat: true`), and
   * so is visible and resumable on glean.com. Transient chats also have a
   * chatId, but no web page — /glean-url needs to tell the two apart.
   */
  saved?: boolean;
}

let state: GleanState = {};

const STATE_ENTRY_TYPE = "glean-chat-state" as const;

// Streaming tool-result tuning: how often partial results are pushed to the
// TUI, and how many trailing lines the collapsed partial view shows.
const TOOL_UPDATE_INTERVAL_MS = 80;
const TOOL_PARTIAL_TAIL_LINES = 8;

// ── Reasoning mode ────────────────────────────────────────────────────────────
//
// Selects the Glean agent that executes a chat request (agentConfig.agent).
// Only the agentic-engine agents are exposed here; they require the agentic
// engine to be enabled in the Glean deployment.
//   ADVANCED — thinks longer, more LLM calls, higher-quality results.
//   AUTO     — routes between reasoning efforts based on the question/context.
//
// Glean's FAST agent is deliberately not exposed: it is unreliable and returns
// erroneous answers often enough that no caller should be able to select it.

type ReasoningMode = "ADVANCED" | "AUTO";

const REASONING_MODES: readonly ReasoningMode[] = ["ADVANCED", "AUTO"];

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

/**
 * Active mode: session override (via /glean-mode) or the env/default.
 *
 * The session value is re-validated because it is restored verbatim from
 * session entries, which may have been written by a build that still offered
 * the retired FAST mode.
 */
function currentReasoningMode(): ReasoningMode {
  const session = state.reasoningMode
    ? normalizeReasoningMode(state.reasoningMode)
    : undefined;
  return session ?? defaultReasoningMode();
}

/**
 * agentConfig payload applied to a Glean chat request. An explicit `override`
 * (e.g. a per-call `reasoning` tool argument) wins over the session/env mode,
 * but only if it names a mode we still support — a model that invents FAST
 * falls back to the session default rather than reaching the retired agent.
 */
function reasoningAgentConfig(override?: string): { agent: ReasoningMode } {
  const explicit = override ? normalizeReasoningMode(override) : undefined;
  return { agent: explicit ?? currentReasoningMode() };
}

/** `samplingParams.agent` as a mode, if it names one we support. */
function samplingAgent(
  params: Record<string, unknown> | undefined,
): ReasoningMode | undefined {
  const agent = params?.agent;
  return typeof agent === "string" ? normalizeReasoningMode(agent) : undefined;
}

/**
 * The Glean agent for a model-surface request, most specific source first:
 *
 *   1. `options.samplingParams.agent`   — per-request override
 *   2. `model.samplingParams.agent`     — pins one models.json model to an agent,
 *                                         so `glean-advanced` and `glean-auto`
 *                                         can be separate entries
 *   3. `model.thinkingLevelMap[level]`  — lets pi's thinking-level UI drive the
 *                                         agent on a model declared reasoning
 *   4. the session / env mode           — what /glean-mode sets
 *
 * Every candidate goes through normalizeReasoningMode, so a typo or a retired
 * FAST falls through to the next source rather than reaching Glean.
 */
function modelReasoningMode(
  model: Pick<Model<Api>, "samplingParams" | "thinkingLevelMap">,
  options?: SimpleStreamOptions,
): ReasoningMode {
  // pi drops the level entirely when thinking is off, so an absent `reasoning`
  // simply falls through to the session mode.
  const level = options?.reasoning;
  const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
  return (
    samplingAgent(options?.samplingParams) ??
    samplingAgent(model.samplingParams) ??
    (mapped ? normalizeReasoningMode(mapped) : undefined) ??
    currentReasoningMode()
  );
}

// State captured from session/model events so the custom footer can render the
// active Glean model and reasoning mode. When the Glean model is selected we
// replace pi's footer entirely (Glean exposes no token/context/cost data, so
// there is nothing to reimplement); switching to any other model restores the
// built-in footer.
let activeIsGlean = false;
let gleanFooterActive = false;
type FooterModel = Pick<Model<Api>, "samplingParams" | "thinkingLevelMap"> & {
  id: string;
  provider: string;
};
let footerModel: FooterModel = {
  id: "glean-assistant",
  provider: "glean",
};
let footerCwd = process.cwd();

// Minimal structural type for a TUI footer component (pi's Component type is
// not re-exported from the package root).
type FooterComponent = { render(width: number): string[]; dispose?(): void };

/**
 * The slice of pi's ReadonlyFooterDataProvider the custom footer reads. Spelled
 * structurally because the concrete type is not re-exported from the package
 * root; `getExtensionStatuses` is what `ctx.ui.setStatus()` writes into.
 */
type FooterData = {
  getGitBranch(): string | null;
  getAvailableProviderCount(): number;
  getExtensionStatuses?(): ReadonlyMap<string, string>;
};

/**
 * True when a model routes through Glean Chat.
 *
 * Keyed on the api rather than the provider id, so a provider a user declared in
 * models.json under any name gets the Glean footer too. The provider-id check
 * stays as a fallback for the extension's own registration, whose models carry
 * the api only after pi has composed them.
 */
function isGleanModel(
  model: { provider?: string; api?: string } | undefined,
): boolean {
  return model?.api === GLEAN_API || model?.provider === "glean";
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
 *
 * Extension statuses (`ctx.ui.setStatus()`) get a third line, as in pi's
 * built-in footer — without it, replacing the footer would silently swallow
 * every status this extension reports while a command is running.
 */
function makeGleanFooter(
  theme: { fg(color: string, text: string): string },
  footerData: FooterData,
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
        `${modelSeg} • ${modelReasoningMode(footerModel).toLowerCase()}`,
        width,
      );
      const pad = " ".repeat(Math.max(0, width - visibleWidth(right)));
      const modelLine = theme.fg("dim", pad + right);

      const lines = [pwdLine, modelLine];

      // Extension statuses, sorted by key so the order is stable across renders.
      const statuses = footerData.getExtensionStatuses?.() ?? new Map();
      if (statuses.size) {
        const statusLine = [...statuses.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, text]) => text.replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .join(" ");
        if (statusLine)
          lines.push(theme.fg("dim", truncatePlain(statusLine, width)));
      }

      return lines;
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
      makeGleanFooter(theme as any, footerData as FooterData),
    );
    gleanFooterActive = true;
  } else if (gleanFooterActive) {
    ui.setFooter(undefined); // restore built-in footer
    gleanFooterActive = false;
  }
}

// ── Progress indicator ────────────────────────────────────────────────────────
//
// The /glean* commands are synchronous from the user's point of view: nothing
// reaches the conversation until the whole answer has streamed, which on a big
// transcript with ADVANCED reasoning is tens of seconds of silence. A spinner
// above the editor — carrying Glean's own progress lines and an elapsed counter
// — is the only signal that the command is alive.

const PROGRESS_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PROGRESS_TICK_MS = 100;
const PROGRESS_WIDGET_KEY = "glean-progress";
const PROGRESS_DEFAULT_WIDTH = 80;

/**
 * One line of progress: `⠹ Saving to Glean · searching Confluence (9s)`.
 *
 * Pure, so it can be tested without a TUI. `status` is Glean's live phase text,
 * which arrives as arbitrary multi-line markdown — it is collapsed to one line
 * and the whole line is truncated to `width`.
 */
export function formatProgressLine(
  label: string,
  status: string,
  elapsedMs: number,
  frame: string,
  width = PROGRESS_DEFAULT_WIDTH,
): string {
  const phase = status.replace(/\s+/g, " ").trim();
  const elapsed = `(${Math.floor(Math.max(0, elapsedMs) / 1000)}s)`;
  const line = [frame, label, phase ? `· ${phase}` : "", elapsed]
    .filter(Boolean)
    .join(" ");
  return truncatePlain(line, width);
}

interface Progress {
  /** Replace the phase text shown after the label. */
  status(text: string): void;
  /** Stop animating and clear the widget/status. Idempotent. */
  stop(): void;
}

/**
 * Start an animated progress line for a long-running command.
 *
 * Renders into a widget above the editor (interactive mode) *and* mirrors the
 * text through `setStatus`, so RPC/print modes and pi's built-in footer still
 * report something. `setWidget` is optional-called: not every mode provides it.
 */
function startProgress(
  ui: Pick<ExtensionUIContext, "setStatus"> &
    Partial<Pick<ExtensionUIContext, "setWidget">>,
  label: string,
): Progress {
  const started = Date.now();
  let phase = "";
  let tick = 0;
  let stopped = false;

  const paint = () => {
    const line = formatProgressLine(
      label,
      phase,
      Date.now() - started,
      PROGRESS_FRAMES[tick++ % PROGRESS_FRAMES.length],
    );
    ui.setWidget?.(PROGRESS_WIDGET_KEY, [line]);
    ui.setStatus(PROGRESS_WIDGET_KEY, line);
  };

  paint();
  const timer = setInterval(paint, PROGRESS_TICK_MS);
  // Never let a pending repaint keep the process alive.
  (timer as { unref?: () => void }).unref?.();

  return {
    status(text: string) {
      if (stopped) return;
      phase = text;
      paint();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      ui.setWidget?.(PROGRESS_WIDGET_KEY, undefined);
      ui.setStatus(PROGRESS_WIDGET_KEY, "");
    },
  };
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
  backendUrl?: string,
): Promise<OAuthCredentials> {
  const baseUrl = backendUrl ?? resolveGleanBaseUrl();
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
  backendUrl?: string,
): Promise<OAuthCredentials> {
  const baseUrl = backendUrl ?? resolveGleanBaseUrl();
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

/**
 * OAuth config bound to one backend URL.
 *
 * The URL has to be captured here, at registration: pi hands the login function
 * only its callbacks — no provider, no model — so a flow shared between two
 * tenants has no way to ask which one it is authenticating against. Omit the
 * argument to keep the env / auth.json resolution.
 */
function makeGleanOAuth(
  backendUrl?: string,
): NonNullable<ProviderConfig["oauth"]> {
  return {
    name: "Glean (SSO via OAuth)",
    login: (callbacks) => loginGlean(callbacks, backendUrl),
    refreshToken: (credentials) => refreshGleanToken(credentials, backendUrl),
    getApiKey: (credentials) => credentials.access,
  };
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

/**
 * Resolve the Glean backend base URL, normalized (no trailing /), with the same
 * precedence the token uses:
 *   1. GLEAN_BACKEND_URL / GLEAN_INSTANCE env vars
 *   2. ~/.pi/agent/auth.json  glean entry: env.GLEAN_BACKEND_URL,
 *      env.GLEAN_INSTANCE, backendUrl, or instance
 *
 * The file fallback matters because the model surface is registered only when a
 * URL resolves (see the entry point). Env-only resolution meant pi worked in an
 * interactive shell and reported `Model "glean" not found` anywhere the profile
 * had not been sourced -- cron, launchd, a bare `env -i` -- even with a perfectly
 * good credential sitting in auth.json.
 */
export function resolveGleanBaseUrl(): string | undefined {
  let url = process.env.GLEAN_BACKEND_URL;
  let instance = process.env.GLEAN_INSTANCE;
  if (!url && !instance) {
    const glean = readGleanAuthEntry();
    url =
      authEnv(glean, "GLEAN_BACKEND_URL") ??
      (typeof glean?.backendUrl === "string" ? glean.backendUrl : undefined);
    instance =
      authEnv(glean, "GLEAN_INSTANCE") ??
      (typeof glean?.instance === "string" ? glean.instance : undefined);
  }
  if (!url && instance) url = `https://${instance}-be.glean.com`;
  if (!url) return undefined;
  url = url.replace(/\/+$/, "");
  url = url.replace(/\/rest\/api\/v1$/, "");
  return url;
}

/**
 * The Glean web app. Chat pages live at <host>/chat/<chatId>; the UI is served
 * from this single host rather than a per-tenant one (a tenant-derived host such
 * as https://<instance>.glean.com does not resolve to the chat page).
 */
const GLEAN_WEB_URL_DEFAULT = "https://app.glean.com";

/**
 * Resolve the Glean *web app* base URL — where a saved chat is readable in a
 * browser — normalized (no trailing /):
 *   1. GLEAN_WEB_URL env var
 *   2. ~/.pi/agent/auth.json  glean entry: env.GLEAN_WEB_URL
 *   3. app.glean.com
 *
 * Glean's API exposes no link to a Chat, so the default is a convention, not a
 * documented contract. Override it with GLEAN_WEB_URL if a tenant differs.
 */
export function resolveGleanWebUrl(): string {
  const explicit =
    process.env.GLEAN_WEB_URL ?? authEnv(readGleanAuthEntry(), "GLEAN_WEB_URL");
  return (explicit || GLEAN_WEB_URL_DEFAULT).replace(/\/+$/, "");
}

/** Browser link for a saved Glean chat. */
export function gleanChatUrl(chatId: string): string {
  return `${resolveGleanWebUrl()}/chat/${chatId}`;
}

/** Extract a chat id from a bare id or any Glean URL containing /chat/<id>. */
export function parseChatId(input: string): string | undefined {
  const raw = input.trim();
  if (!raw) return undefined;
  const fromUrl = /\/chat\/(?:agents\/)?([A-Za-z0-9_-]+)/.exec(raw);
  if (fromUrl) return fromUrl[1];
  return /^[A-Za-z0-9_-]+$/.test(raw) ? raw : undefined;
}

/**
 * Whether requests from the tool and /glean should be persisted as Glean chats.
 *
 * Off by default: every question the LLM asks mid-task would otherwise land in
 * the user's Glean chat history. /glean-save always saves regardless.
 */
function shouldSaveChat(): boolean {
  const v = (process.env.GLEAN_SAVE_CHATS ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
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
  chatId?: string;
  messages?: RawGleanMessage[];
}

/** A Glean chat message payload as sent on the wire. */
interface GleanRequestMessage {
  author: "USER" | "GLEAN_AI";
  messageType: "CONTENT";
  fragments: { text: string }[];
}

/**
 * Flatten a pi message's content to plain text: text parts only, joined by
 * newlines. Images, thinking blocks, and tool calls are dropped — Glean takes
 * prose. Shared by the model surface and the transcript builder.
 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => (c as { type?: string })?.type === "text")
    .map((c) => (c as { text?: string }).text ?? "")
    .join("\n");
}

/**
 * Map pi Context → Glean ChatMessage[].
 * Only user/assistant text survives; system prompt and tool traffic dropped.
 * Consecutive same-author messages are merged (Glean expects alternation).
 * Returned array is ordered MOST RECENT FIRST — the Glean Chat API contract
 * is "a list of chat messages, from most recent to least recent".
 */
function buildGleanMessages(context: Context): GleanRequestMessage[] {
  const out: GleanRequestMessage[] = [];

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
      push("USER", textOf(msg.content));
    } else if (msg.role === "assistant") {
      push("GLEAN_AI", textOf(msg.content));
    }
    // toolResult messages are dropped — Glean has no tool concept.
  }

  // Glean expects a USER-authored current question. Chronologically that is
  // the last message; ensure it exists, then reverse to most-recent-first.
  if (!out.length || out[out.length - 1].author !== "USER")
    push("USER", "(continue)");

  return out.reverse();
}

// ── Transcript (session → markdown) ──────────────────────────────────────────
//
// Renders the local pi conversation as markdown so it can be handed to Glean as
// a single USER message (see /glean-save). Prose is what Glean can act on, so
// tool traffic collapses to one-line markers rather than being reproduced: the
// point is for Glean — and the human reading it on glean.com — to know what was
// asked, answered, and touched, not to replay the tool output.

/** Default cap on transcript size; overridable per call and by env var. */
const TRANSCRIPT_MAX_CHARS = 60_000;

function defaultTranscriptMaxChars(): number {
  const raw = Number.parseInt(process.env.GLEAN_TRANSCRIPT_MAX_CHARS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : TRANSCRIPT_MAX_CHARS;
}

/** One-line, length-capped summary of a tool call's arguments. */
function summarizeToolArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  // The salient argument first — these cover pi's built-in tools; anything else
  // falls back to a compact JSON rendering.
  const salient = [
    "command",
    "file_path",
    "path",
    "pattern",
    "query",
    "message",
    "prompt",
  ];
  const key = salient.find((k) => typeof args[k] === "string" && args[k]);
  const value = key ? String(args[key]) : JSON.stringify(args);
  const oneLine = (value ?? "").replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? oneLine.slice(0, 79) + "…" : oneLine;
}

/** Markdown for one session entry, or "" when the entry carries nothing useful. */
function renderEntry(entry: SessionEntry): string {
  if (entry.type === "custom_message") {
    // Extension-injected messages — including this extension's own
    // `glean-response` answers — are part of the conversation the user sees.
    const text = textOf((entry as { content?: unknown }).content);
    if (!text.trim()) return "";
    const customType = (entry as { customType?: string }).customType ?? "";
    const heading = customType.startsWith("glean") ? "Glean" : "Note";
    return `## ${heading}\n\n${text.trim()}`;
  }

  if (entry.type === "compaction" || entry.type === "branch_summary") {
    const summary = (entry as { summary?: string }).summary ?? "";
    return summary.trim()
      ? `## Earlier context (summarized)\n\n${summary.trim()}`
      : "";
  }

  if (entry.type !== "message") return "";
  const msg = (entry as { message?: any }).message;
  if (!msg) return "";

  if (msg.role === "user") {
    const text = textOf(msg.content).trim();
    return text ? `## You\n\n${text}` : "";
  }

  if (msg.role === "assistant") {
    const parts: string[] = [];
    const text = textOf(msg.content).trim();
    if (text) parts.push(text);
    for (const c of Array.isArray(msg.content) ? msg.content : []) {
      if (c?.type !== "toolCall") continue;
      const args = summarizeToolArgs(c.arguments);
      parts.push(`_[tool: ${c.name}${args ? ` — ${args}` : ""}]_`);
    }
    return parts.length ? `## Assistant\n\n${parts.join("\n\n")}` : "";
  }

  if (msg.role === "bashExecution") {
    const command = String(msg.command ?? "").trim();
    return command ? `## You\n\n_[shell: ${command}]_` : "";
  }

  // toolResult and everything else is dropped.
  return "";
}

/**
 * Render session entries as a markdown transcript.
 *
 * `entries` should be the current branch (`sessionManager.getBranch()`), in
 * order. When the transcript exceeds `maxChars`, the OLDEST turns are dropped
 * first — a hand-off cares about where the conversation ended up.
 */
export function buildTranscript(
  entries: SessionEntry[],
  opts?: { maxChars?: number },
): { text: string; turns: number; truncated: boolean } {
  const maxChars = opts?.maxChars ?? defaultTranscriptMaxChars();
  const blocks: string[] = [];
  for (const entry of entries) {
    const block = renderEntry(entry);
    if (block) blocks.push(block);
  }

  const SEP = "\n\n";
  const OMITTED = "_[earlier turns omitted]_";
  let kept = blocks;
  let truncated = false;
  const size = () =>
    kept.reduce((n, b) => n + b.length, 0) +
    Math.max(0, kept.length - 1) * SEP.length;

  if (Number.isFinite(maxChars)) {
    while (kept.length && size() > maxChars) {
      kept = kept.slice(1);
      truncated = true;
    }
  }

  const body = kept.join(SEP);
  return {
    text: truncated ? `${OMITTED}${SEP}${body}` : body,
    turns: kept.length,
    truncated,
  };
}

// ── Shared streaming core ─────────────────────────────────────────────────────
//
// One ND-JSON reader for every surface. `streamGleanChat` performs the request
// and yields normalized events; each consumer decides how to present them:
//   - the model surface (`streamGlean`) maps them onto pi assistant-message
//     events (thinking / text deltas),
//   - the `glean_chat` tool maps them onto `onUpdate` partial tool results so
//     the answer renders in the TUI as it arrives.

type GleanStreamEvent =
  | { type: "chat_id"; chatId: string }
  | { type: "thinking"; text: string; messageId?: string }
  | { type: "content"; text: string; messageId?: string }
  | { type: "citation"; url: string; title: string };

interface GleanStreamRequest {
  token: string;
  baseUrl: string;
  messages: GleanRequestMessage[];
  agentConfig: { agent: ReasoningMode };
  /** Continue an existing Glean conversation thread. */
  chatId?: string;
  /**
   * Persist the interaction as a Chat the user owns, making it readable and
   * resumable on glean.com. Omitted (not sent as false) when not requested, so
   * the wire format stays identical to previous releases by default.
   */
  saveChat?: boolean;
  signal?: AbortSignal | null;
}

/** Parse one ND-JSON line into stream events. Throws on ERROR messages. */
function* parseGleanLine(line: string): Generator<GleanStreamEvent> {
  let parsed: RawGleanChatResponse;
  try {
    parsed = JSON.parse(line) as RawGleanChatResponse;
  } catch {
    return; // tolerate keep-alives / non-JSON lines
  }

  if (parsed.chatId) yield { type: "chat_id", chatId: parsed.chatId };

  for (const msg of parsed.messages ?? []) {
    if (msg.author === "USER") continue;

    // Citations live inline on fragments (current API) and on the deprecated
    // top-level array; emit both, consumers deduplicate by URL.
    for (const frag of msg.fragments ?? []) {
      const doc = frag.citation?.sourceDocument;
      if (doc?.url) yield { type: "citation", url: doc.url, title: doc.title ?? doc.url };
    }
    for (const cit of msg.citations ?? []) {
      const doc = cit.sourceDocument;
      if (doc?.url) yield { type: "citation", url: doc.url, title: doc.title ?? doc.url };
    }

    const mt = msg.messageType ?? "CONTENT";
    const text = (msg.fragments ?? []).map((f) => f.text ?? "").join("");
    if (mt === "ERROR") {
      throw new Error(text || "Glean returned an error message");
    } else if (mt === "UPDATE" || mt === "HEADING") {
      if (text) yield { type: "thinking", text, messageId: msg.messageId };
    } else if (mt === "CONTENT") {
      if (text) yield { type: "content", text, messageId: msg.messageId };
    }
    // CONTROL_*, DEBUG*, WARNING, CONTEXT, SERVER_TOOL — ignored
  }
}

/**
 * POST /rest/api/v1/chat with `stream: true` and yield normalized events as the
 * ND-JSON body arrives (one ChatResponse per line).
 */
async function* streamGleanChat(
  req: GleanStreamRequest,
): AsyncGenerator<GleanStreamEvent> {
  const response = await fetch(`${req.baseUrl.replace(/\/+$/, "")}/rest/api/v1/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${req.token}`,
    },
    body: JSON.stringify({
      messages: req.messages,
      agentConfig: req.agentConfig,
      ...(req.chatId ? { chatId: req.chatId } : {}),
      ...(req.saveChat ? { saveChat: true } : {}),
      stream: true,
    }),
    signal: req.signal ?? null,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const hint =
      response.status === 401
        ? " (check GLEAN_API_TOKEN is a valid Client token with CHAT scope)"
        : response.status === 429
          ? " (rate limited — retry shortly)"
          : "";
    throw new Error(
      `Glean API error ${response.status}${hint}: ${body.slice(0, 500)}`,
    );
  }
  if (!response.body) throw new Error("Glean API returned no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) yield* parseGleanLine(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield* parseGleanLine(buffer.trim());
  } finally {
    // Early `break` in a consumer (abort, error) must not leak the connection.
    await reader.cancel().catch(() => {});
  }
}

/** Render a deduplicated citations map as a trailing markdown Sources block. */
function sourcesBlock(citations: Map<string, string>): string {
  if (!citations.size) return "";
  return (
    "\n\n**Sources:**\n" +
    [...citations.entries()].map(([url, title]) => `- [${title}](${url})`).join("\n")
  );
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

    function processEvent(event: GleanStreamEvent) {
      switch (event.type) {
        case "citation":
          if (!citations.has(event.url)) citations.set(event.url, event.title);
          break;
        case "thinking": {
          // New message (or first): separate from previous thinking content.
          const isNew =
            thinkingIndex < 0 ||
            (event.messageId !== undefined && event.messageId !== thinkingMsgId);
          pushThinkingDelta(
            isNew && thinkingIndex >= 0 ? "\n" + event.text : event.text,
          );
          if (event.messageId !== undefined) thinkingMsgId = event.messageId;
          break;
        }
        case "content": {
          // New CONTENT message: paragraph break from previous content.
          const isNew =
            textIndex >= 0 &&
            event.messageId !== undefined &&
            event.messageId !== textMsgId;
          pushTextDelta(isNew ? "\n\n" + event.text : event.text);
          if (event.messageId !== undefined) textMsgId = event.messageId;
          break;
        }
        case "chat_id":
          break; // the model surface is stateless; chatId is unused here
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

      for await (const event of streamGleanChat({
        token,
        baseUrl,
        messages: buildGleanMessages(context),
        agentConfig: { agent: modelReasoningMode(model, options) },
        signal: options?.signal ?? null,
      })) {
        processEvent(event);
      }

      endThinking();

      // Append citations as a trailing Sources block.
      pushTextDelta(sourcesBlock(citations));
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
  // Teach pi how to talk `glean-chat`, unconditionally: a models.json entry
  // carries its own baseUrl and credentials, so neither an env backend URL nor
  // the model surface being enabled is a precondition. pi looks this up lazily,
  // at stream time, keyed by the api id.
  try {
    registerApiProvider(
      { api: GLEAN_API, stream: streamGlean, streamSimple: streamGlean },
      "pi-glean-chat",
    );
  } catch (err) {
    // An older pi without the api registry: the extension's own provider
    // registration still works, only models.json entries are unavailable.
    console.error(
      `glean-chat: could not register the api implementation — models.json ` +
        `providers using "api": "${GLEAN_API}" will not work. ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const modelsJson = readModelsJsonProviders();

  // Model surface: glean / Glean Assistant. Registered only when a backend
  // URL is configured; disable explicitly with GLEAN_ENABLE_MODEL_SURFACE=0.
  const modelBaseUrl = resolveGleanBaseUrl();
  if (process.env.GLEAN_ENABLE_MODEL_SURFACE !== "0" && modelBaseUrl) {
    const gleanAssistant: ProviderModelConfig = {
      id: "glean-assistant",
      name: "Glean Assistant",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    };
    pi.registerProvider("glean", {
      name: "Glean",
      baseUrl: modelBaseUrl,
      apiKey: "$GLEAN_API_TOKEN",
      api: GLEAN_API,
      models: mergeModelsJsonModels(gleanAssistant, modelsJson.glean),
      oauth: makeGleanOAuth(modelBaseUrl),
      streamSimple: streamGlean,
    });
  }

  // Lend the OAuth flow to provider ids the user declared in models.json.
  // models.json cannot express an OAuth method of its own (its `oauth` field
  // only accepts "radius"), but pi composes auth per provider id from the
  // extension layer — so registering the method here is what makes
  // `/login <id>` work for a second tenant. No `models` or `baseUrl`: supplying
  // either would override what the user wrote in models.json.
  for (const [id, entry] of Object.entries(modelsJson)) {
    if (id === "glean" || !usesGleanApi(entry)) continue;
    pi.registerProvider(id, {
      api: GLEAN_API,
      streamSimple: streamGlean,
      oauth: makeGleanOAuth(entryBaseUrl(entry)),
    });
  }

  // Restore conversation state from session; reset client so token/URL
  // changes take effect after /reload. Capture ctx for OAuth-aware token
  // resolution in the tool/command surfaces.
  pi.on("session_start", async (_event, ctx) => {
    piContext = ctx;
    footerCwd = ctx.cwd ?? process.cwd();
    activeIsGlean = isGleanModel(ctx.model);
    if (ctx.model) footerModel = ctx.model;
    _client = undefined;
    state = { chatId: undefined, saved: undefined };
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
    if (event.model) footerModel = event.model;
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
      "ADVANCED for deep-research questions.",
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
        "benefit from longer thinking; omit it to use the session default.",
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
      // Emitted as `{ type: "string", enum: [...] }` rather than TypeBox's
      // `Type.Union([Type.Literal(...)])`, which produces `anyOf` + `const`.
      // Both are valid JSON Schema and equivalent for cloud providers, but
      // several OpenAI-compatible servers (llama.cpp, vLLM and other
      // grammar-constrained local runtimes) only implement the `enum` keyword
      // and fail the whole request when a tool schema contains `anyOf`.
      // `enum` is the portable spelling, so keep it for every model.
      reasoning: Type.Optional(
        Type.Unsafe<ReasoningMode>({
          type: "string",
          enum: [...REASONING_MODES],
          description:
            "Reasoning effort for this query. ADVANCED thinks longer with " +
            "more LLM calls for deep-research questions; AUTO lets Glean " +
            "route automatically. Defaults to the session/env reasoning mode.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
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

      const baseUrl = resolveGleanBaseUrl();
      if (!baseUrl) {
        return {
          content: [
            {
              type: "text",
              text:
                "No Glean backend URL. " +
                "Set GLEAN_BACKEND_URL (e.g. https://acme-be.glean.com) " +
                "or GLEAN_INSTANCE.",
            },
          ],
          details: {},
          isError: true,
        };
      }

      if (params.new_conversation) {
        state.chatId = undefined;
        state.saved = false;
      }

      // Streaming state. `answer` accumulates CONTENT text; `status` holds the
      // most recent UPDATE/HEADING line, shown until the answer starts.
      const citations = new Map<string, string>(); // url -> title
      let answer = "";
      let status = "";
      let contentMsgId: string | undefined;

      let lastUpdate = 0;
      const emit = (force = false) => {
        const now = Date.now();
        if (!force && now - lastUpdate < TOOL_UPDATE_INTERVAL_MS) return;
        lastUpdate = now;
        onUpdate?.({
          content: [
            { type: "text", text: answer || status || "Querying Glean\u2026" },
          ],
          details: { chatId: state.chatId, streaming: true },
        });
      };
      emit(true);

      try {
        for await (const event of streamGleanChat({
          token,
          baseUrl,
          messages: [
            {
              author: "USER",
              messageType: "CONTENT",
              fragments: [{ text: params.message }],
            },
          ],
          agentConfig: reasoningAgentConfig(params.reasoning),
          chatId: state.chatId,
          saveChat: shouldSaveChat(),
          signal,
        })) {
          switch (event.type) {
            case "chat_id":
              if (event.chatId !== state.chatId) {
                state.chatId = event.chatId;
                state.saved = shouldSaveChat();
                pi.appendEntry(STATE_ENTRY_TYPE, {
                  chatId: event.chatId,
                  saved: state.saved,
                });
              }
              break;
            case "thinking":
              status = event.text.trim();
              emit();
              break;
            case "content": {
              // New CONTENT message: paragraph break from previous content.
              const isNew =
                answer.length > 0 &&
                event.messageId !== undefined &&
                event.messageId !== contentMsgId;
              answer += (isNew ? "\n\n" : "") + event.text;
              if (event.messageId !== undefined) contentMsgId = event.messageId;
              emit();
              break;
            }
            case "citation":
              if (!citations.has(event.url))
                citations.set(event.url, event.title);
              break;
          }
        }

        const text = answer + sourcesBlock(citations);
        return {
          content: [{ type: "text", text: text || "(no response)" }],
          details: { chatId: state.chatId },
        };
      } catch (err: any) {
        const message: string = err?.message ?? String(err);
        return {
          content: [
            {
              type: "text",
              text: signal?.aborted
                ? `Glean query aborted.${answer ? `\n\nPartial answer:\n${answer}` : ""}`
                : `Glean error: ${message}`,
            },
          ],
          details: {},
          isError: true,
        };
      }
    },

    // While streaming, render only a tail of the answer (or the latest status
    // line) so the tool row stays compact; once settled or expanded, render
    // the whole answer.
    renderResult(result, { expanded, isPartial }, theme, context) {
      const text = (result.content ?? [])
        .filter((c: { type: string }) => c.type === "text")
        .map((c: { text?: string }) => (c as { text?: string }).text ?? "")
        .join("\n");
      const component =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);

      let body = text;
      if (isPartial && !expanded) {
        const lines = text.split("\n");
        const tail = lines.slice(-TOOL_PARTIAL_TAIL_LINES);
        body = (lines.length > tail.length ? "\u2026\n" : "") + tail.join("\n");
      }

      component.setText(
        theme.fg(
          isPartial ? "muted" : context.isError ? "error" : "toolOutput",
          body,
        ),
      );
      return component;
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

      if (forceNew) {
        state.chatId = undefined;
        state.saved = false;
      }

      const progress = startProgress(ctx.ui, "Querying Glean");
      try {
        const response = await getClient().client.chat.create(
          {
            messages: [{ author: "USER", fragments: [{ text: message }] }],
            agentConfig: reasoningAgentConfig(),
            ...(state.chatId ? { chatId: state.chatId } : {}),
            ...(shouldSaveChat() ? { saveChat: true } : {}),
          },
          undefined, // locale
          undefined, // timezoneOffset
        );

        if (response.chatId) {
          state.chatId = response.chatId;
          state.saved = state.saved || shouldSaveChat();
          pi.appendEntry(STATE_ENTRY_TYPE, {
            chatId: response.chatId,
            saved: state.saved,
          });
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
        progress.stop();
      }
    },
  });

  // ── Hand-off: /glean-save, /glean-url, /glean-load ─────────────────────────
  //
  // Glean chats created through the API are transient unless `saveChat` is set:
  // they have a chatId but no page on glean.com. These three commands make the
  // round trip explicit — push the local session up as a saved chat, get its
  // link, and pull a web chat back down into pi.

  /**
   * Copy a chat link to the clipboard; best-effort, never throws.
   *
   * Goes through `pi.exec` rather than pi's `copyToClipboard` helper to avoid
   * importing the whole pi package for one string. Links are built from config
   * plus an opaque `[A-Za-z0-9_-]` chat id, so single-quoting is sufficient.
   */
  async function copyLink(url: string): Promise<boolean> {
    const copier =
      process.platform === "darwin"
        ? "pbcopy"
        : "wl-copy 2>/dev/null || xclip -selection clipboard";
    try {
      const result = await pi.exec?.("sh", [
        "-c",
        `printf %s '${url.replace(/'/g, "")}' | ${copier}`,
      ]);
      return result?.code === 0;
    } catch {
      return false;
    }
  }

  /** Record a chatId known to be persisted server-side. */
  function adoptSavedChat(chatId: string): void {
    state.chatId = chatId;
    state.saved = true;
    pi.appendEntry(STATE_ENTRY_TYPE, { chatId, saved: true });
  }

  pi.registerCommand("glean-save", {
    description:
      "Save this session's history to Glean for hand-off to glean.com. " +
      "Usage: /glean-save [--new] [--full] [instructions]",
    getArgumentCompletions: (prefix) =>
      ["--new", "--full"]
        .filter((f) => f.startsWith(prefix.trim()))
        .map((f) => ({
          value: f,
          label: f,
          description:
            f === "--new"
              ? "Start a fresh Glean chat instead of appending to the current thread"
              : "Send the whole transcript, ignoring the size cap",
        })),
    handler: async (args, ctx) => {
      let rest = args?.trim() ?? "";
      let forceNew = false;
      let full = false;
      // Leading flags only, in any order; everything after them is the
      // instruction. Matched on a word boundary so `--newish` is not `--new`.
      for (;;) {
        const flag = /^(--new|--full)(?:\s+|$)/.exec(rest);
        if (!flag) break;
        if (flag[1] === "--new") forceNew = true;
        else full = true;
        rest = rest.slice(flag[0].length).trim();
      }

      const token = await resolveTokenViaPi(ctx ?? piContext);
      if (!token) {
        ctx.ui.notify(
          "No Glean credentials — run /login and select glean, or export GLEAN_API_TOKEN",
          "error",
        );
        return;
      }
      const baseUrl = resolveGleanBaseUrl();
      if (!baseUrl) {
        ctx.ui.notify(
          "No Glean backend URL. Set GLEAN_BACKEND_URL or GLEAN_INSTANCE.",
          "error",
        );
        return;
      }

      const transcript = buildTranscript(ctx.sessionManager.getBranch(), {
        ...(full ? { maxChars: Number.POSITIVE_INFINITY } : {}),
      });
      if (!transcript.turns) {
        ctx.ui.notify("Nothing to save — this session has no history yet.", "info");
        return;
      }

      if (forceNew) {
        state.chatId = undefined;
        state.saved = false;
      }

      // One USER message carrying the whole transcript: Glean answers once, and
      // we do not depend on it persisting caller-supplied GLEAN_AI turns (which
      // the API does not document).
      const sessionName = ctx.sessionManager.getSessionName();
      const header = [
        "This is a transcript of a coding session I had with a local AI agent (pi).",
        sessionName ? `Session: ${sessionName}` : "",
        `Working directory: ${ctx.cwd}`,
        transcript.truncated
          ? "The oldest turns were dropped to fit; the transcript starts mid-conversation."
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      const instruction =
        rest ||
        "Summarize where we left off in a few lines, so I can continue this work here.";
      const message = `${header}\n\n---\n\n${transcript.text}\n\n---\n\n${instruction}`;

      const progress = startProgress(ctx.ui, "Saving session to Glean");
      let answer = "";
      const citations = new Map<string, string>();
      try {
        for await (const event of streamGleanChat({
          token,
          baseUrl,
          messages: [
            { author: "USER", messageType: "CONTENT", fragments: [{ text: message }] },
          ],
          agentConfig: reasoningAgentConfig(),
          chatId: state.chatId,
          saveChat: true,
          signal: ctx.signal ?? null,
        })) {
          switch (event.type) {
            case "chat_id":
              adoptSavedChat(event.chatId);
              break;
            case "thinking":
              progress.status(event.text.trim());
              break;
            case "content":
              // Glean stops emitting UPDATEs once it starts writing; keep the
              // line honest about what it is waiting on.
              if (!answer) progress.status("writing answer");
              answer += event.text;
              break;
            case "citation":
              if (!citations.has(event.url)) citations.set(event.url, event.title);
              break;
          }
        }
      } catch (err: any) {
        progress.stop();
        ctx.ui.notify(
          `Glean error: ${(err?.message as string) ?? String(err)}`,
          "error",
        );
        return;
      }

      if (!state.chatId) {
        progress.stop();
        ctx.ui.notify(
          "Glean did not return a chatId — the session was not saved.",
          "error",
        );
        return;
      }

      // The clipboard hop shells out, so keep the spinner up until it settles.
      progress.status("copying link");
      const url = gleanChatUrl(state.chatId);
      const copied = await copyLink(url).finally(() => progress.stop());
      const link = `**Saved to Glean:** ${url}`;
      const note = transcript.truncated
        ? `\n\n_${transcript.turns} turns sent; older ones were dropped to fit._`
        : "";

      pi.sendMessage(
        {
          customType: "glean-handoff",
          content: `${link}${note}\n\n${answer + sourcesBlock(citations)}`,
          display: true,
        },
        { triggerTurn: false },
      );
      ctx.ui.notify(
        `Saved to Glean${copied ? " (link copied)" : ""}: ${url}`,
        "info",
      );
    },
  });

  pi.registerCommand("glean-url", {
    description: "Print (and copy) the glean.com link for the current Glean chat",
    handler: async (_args, ctx) => {
      if (!state.chatId) {
        ctx.ui.notify(
          "No Glean chat yet — run /glean-save, or ask something with /glean.",
          "info",
        );
        return;
      }
      if (!state.saved) {
        ctx.ui.notify(
          `Chat ${state.chatId} was never saved server-side, so it has no page ` +
            "on glean.com. Run /glean-save (or set GLEAN_SAVE_CHATS=1).",
          "info",
        );
        return;
      }
      const url = gleanChatUrl(state.chatId);
      const copied = await copyLink(url);
      ctx.ui.notify(`${url}${copied ? " (copied)" : ""}`, "info");
    },
  });

  pi.registerCommand("glean-load", {
    description:
      "Load a Glean chat into this session and continue it. " +
      "Usage: /glean-load <chatId | glean.com chat URL>",
    handler: async (args, ctx) => {
      const chatId = parseChatId(args ?? "");
      if (!chatId) {
        ctx.ui.notify(
          "Usage: /glean-load <chatId | https://…/chat/<chatId>>",
          "info",
        );
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

      const progress = startProgress(ctx.ui, "Loading Glean chat");
      try {
        // GetChatResponse → { chatResult: { chat: { messages } } }.
        const response = await getClient().client.chat.retrieve({ id: chatId });
        const chat = response?.chatResult?.chat;
        const messages: ChatMessage[] = chat?.messages ?? [];
        if (!messages.length) {
          ctx.ui.notify(
            `Glean chat ${chatId} has no messages (or is not accessible).`,
            "error",
          );
          return;
        }

        // Render both sides: extractAiText/formatCitations deliberately skip
        // USER messages, so walk the array once here for the interleaved view.
        const blocks: string[] = [];
        for (const msg of messages) {
          const text = (msg.fragments ?? []).map((f) => f.text ?? "").join("");
          if (!text.trim()) continue;
          if (msg.author === "USER") {
            blocks.push(`## You (in Glean)\n\n${text.trim()}`);
          } else if ((msg.messageType ?? "CONTENT") === "CONTENT") {
            blocks.push(`## Glean\n\n${text.trim()}`);
          }
        }

        const title = chat?.name ? `: ${chat.name}` : "";
        pi.sendMessage(
          {
            customType: "glean-handoff",
            content:
              `**Loaded Glean chat${title}** (${gleanChatUrl(chatId)})\n\n` +
              blocks.join("\n\n") +
              formatCitations(messages),
            display: true,
          },
          { triggerTurn: false },
        );

        // Adopt the thread so glean_chat and /glean continue this same chat.
        adoptSavedChat(chatId);
        ctx.ui.notify(
          `Loaded Glean chat ${chatId} — /glean and glean_chat now continue it.`,
          "info",
        );
      } catch (err: any) {
        ctx.ui.notify(
          `Glean error: ${(err?.message as string) ?? String(err)}`,
          "error",
        );
      } finally {
        progress.stop();
      }
    },
  });

  // ── Command: /glean-mode ───────────────────────────────────────────────────

  pi.registerCommand("glean-mode", {
    description:
      "View, set, or toggle the Glean reasoning mode. " +
      "Usage: /glean-mode [advanced|auto]  (no arg toggles to the other mode)",
    getArgumentCompletions: (prefix) => {
      const p = prefix.trim().toLowerCase();
      return REASONING_MODES.filter((m) =>
        m.toLowerCase().startsWith(p),
      ).map((m) => ({
        value: m.toLowerCase(),
        label: m.toLowerCase(),
        description:
          m === "ADVANCED"
            ? "Thinks longer, higher-quality results"
            : "Routes reasoning effort automatically",
      }));
    },
    handler: async (args, ctx) => {
      const arg = args?.trim() ?? "";

      let mode: ReasoningMode;
      if (!arg) {
        // No argument: toggle to the other mode.
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
