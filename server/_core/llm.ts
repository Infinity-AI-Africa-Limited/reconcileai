/**
 * LLM Provider — Dual-Mode
 * ─────────────────────────────────────────────────────────────────────────────
 * This module supports two operating modes, selected automatically at runtime
 * based on the environment variables present:
 *
 *  MODE 1 — Manus Forge (development / Manus-hosted)
 *    Required:  BUILT_IN_FORGE_API_KEY  (injected automatically by Manus)
 *    Optional:  BUILT_IN_FORGE_API_URL  (defaults to https://forge.manus.im)
 *    Model:     gemini-2.5-flash (Manus-managed)
 *
 *  MODE 2 — Direct provider (production / Rocket.new / self-hosted)
 *    Required:  DIRECT_LLM_API_KEY      (your own Anthropic or OpenAI key)
 *    Optional:  DIRECT_LLM_API_URL      (defaults to OpenAI-compatible endpoint)
 *               DIRECT_LLM_MODEL        (defaults to gpt-4o)
 *
 *    Three LLM postures are supported under Mode 2:
 *      (a) Internet Anthropic Claude — default cloud option (api.anthropic.com).
 *      (b) Local Anthropic-Messages-compatible endpoint — set DIRECT_LLM_API_URL
 *          to an in-VPC gateway + DIRECT_LLM_PROVIDER=anthropic.
 *      (c) Local OpenAI-compatible endpoint (Ollama / vLLM) — set DIRECT_LLM_API_URL
 *          to the local server + DIRECT_LLM_PROVIDER=openai.
 *    In DEPLOYMENT_MODE=on_premise, only (b) and (c) are permitted; (a) and Forge
 *    are blocked by the egress guard so transaction data never leaves the box.
 *
 * Selection logic:
 *   If DIRECT_LLM_API_KEY is set and non-empty → use direct provider (Mode 2)
 *   Otherwise                                  → use Manus Forge (Mode 1)
 *   (on_premise mode disables Forge — a local direct provider is required.)
 *
 * Zero code changes are needed between environments — only environment
 * variables differ. All callers use `invokeLLM()` identically in both modes.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { ENV } from "./env";
import { assertEgressAllowed, isOnPremise } from "./egress";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Role = "system" | "user" | "assistant" | "tool" | "function";

export type TextContent = {
  type: "text";
  text: string;
};

export type ImageContent = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
};

export type FileContent = {
  type: "file_url";
  file_url: {
    url: string;
    mime_type?: "audio/mpeg" | "audio/wav" | "application/pdf" | "audio/mp4" | "video/mp4";
  };
};

export type MessageContent = string | TextContent | ImageContent | FileContent;

export type Message = {
  role: Role;
  content: MessageContent | MessageContent[];
  name?: string;
  tool_call_id?: string;
};

export type Tool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type ToolChoicePrimitive = "none" | "auto" | "required";
export type ToolChoiceByName = { name: string };
export type ToolChoiceExplicit = {
  type: "function";
  function: {
    name: string;
  };
};

export type ToolChoice =
  | ToolChoicePrimitive
  | ToolChoiceByName
  | ToolChoiceExplicit;

export type InvokeParams = {
  messages: Message[];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  tool_choice?: ToolChoice;
  maxTokens?: number;
  max_tokens?: number;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type InvokeResult = {
  id: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: Role;
      content: string | Array<TextContent | ImageContent | FileContent>;
      tool_calls?: ToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type JsonSchema = {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
};

export type OutputSchema = JsonSchema;

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: JsonSchema };

// ─── Provider resolution ─────────────────────────────────────────────────────

type ProviderKind = "forge" | "openai" | "anthropic";

type ProviderConfig = {
  mode: "forge" | "direct";
  kind: ProviderKind;
  apiUrl: string;
  apiKey: string;
  model: string;
};

/**
 * Decide whether the direct provider speaks Anthropic's Messages API or an
 * OpenAI-compatible Chat Completions API. Explicit DIRECT_LLM_PROVIDER wins;
 * otherwise auto-detect from the model name ("claude…") or the URL host.
 */
function detectDirectKind(): "openai" | "anthropic" {
  const explicit = ENV.directLlmProvider;
  if (explicit === "anthropic") return "anthropic";
  if (explicit === "openai") return "openai";
  const model = ENV.directLlmModel.trim().toLowerCase();
  const url = ENV.directLlmApiUrl.trim().toLowerCase();
  if (model.startsWith("claude") || url.includes("anthropic")) return "anthropic";
  return "openai";
}

/**
 * Resolve the exact endpoint, tolerating every shape the docs have used:
 *   ""                                    → default base + correct path
 *   "https://api.anthropic.com"           → + "/v1/messages"
 *   "https://api.anthropic.com/v1"        → strip "/v1", + "/v1/messages"
 *   "https://api.anthropic.com/v1/messages" → used as-is
 *   "https://api.openai.com/v1/chat/completions" → used as-is
 */
function resolveDirectEndpoint(rawUrl: string, kind: "openai" | "anthropic"): string {
  const path = kind === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
  const trimmed = rawUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    const base = kind === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com";
    return base + path;
  }
  if (/\/(messages|chat\/completions)$/.test(trimmed)) return trimmed;
  const base = trimmed.replace(/\/v1$/, "");
  return base + path;
}

function resolveProvider(): ProviderConfig {
  const directKey = ENV.directLlmApiKey;

  if (directKey && directKey.trim().length > 0) {
    // Mode 2: Direct provider (Anthropic native, or OpenAI-compatible API)
    const kind = detectDirectKind();
    const apiUrl = resolveDirectEndpoint(ENV.directLlmApiUrl, kind);

    const model =
      ENV.directLlmModel && ENV.directLlmModel.trim().length > 0
        ? ENV.directLlmModel.trim()
        : kind === "anthropic"
          ? "claude-3-5-sonnet-latest"
          : "gpt-4o";

    return { mode: "direct", kind, apiUrl, apiKey: directKey, model };
  }

  // On-premise mode forbids Manus Forge — it would route prompts to forge.manus.im.
  // A local direct provider (Anthropic-compatible or OpenAI-compatible) is required.
  if (isOnPremise()) {
    throw new Error(
      "On-premise mode requires a local LLM. Set DIRECT_LLM_API_KEY and point " +
      "DIRECT_LLM_API_URL at an in-infrastructure endpoint (Anthropic-Messages-compatible " +
      "with DIRECT_LLM_PROVIDER=anthropic, or OpenAI-compatible such as Ollama/vLLM with " +
      "DIRECT_LLM_PROVIDER=openai). Manus Forge and internet Anthropic are disabled in this mode."
    );
  }

  // Mode 1: Manus Forge (default)
  if (!ENV.forgeApiKey || ENV.forgeApiKey.trim().length === 0) {
    throw new Error(
      "No LLM API key configured. " +
      "Set BUILT_IN_FORGE_API_KEY (Manus Forge) or DIRECT_LLM_API_KEY (direct provider)."
    );
  }

  const apiUrl =
    ENV.forgeApiUrl && ENV.forgeApiUrl.trim().length > 0
      ? `${ENV.forgeApiUrl.replace(/\/$/, "")}/v1/chat/completions`
      : "https://forge.manus.im/v1/chat/completions";

  return {
    mode: "forge",
    kind: "forge",
    apiUrl,
    apiKey: ENV.forgeApiKey,
    model: "gemini-2.5-flash",
  };
}

// ─── Message normalisation ────────────────────────────────────────────────────

const ensureArray = (
  value: MessageContent | MessageContent[]
): MessageContent[] => (Array.isArray(value) ? value : [value]);

const normalizeContentPart = (
  part: MessageContent
): TextContent | ImageContent | FileContent => {
  if (typeof part === "string") return { type: "text", text: part };
  if (part.type === "text") return part;
  if (part.type === "image_url") return part;
  if (part.type === "file_url") return part;
  throw new Error("Unsupported message content part");
};

const normalizeMessage = (message: Message) => {
  const { role, name, tool_call_id } = message;

  if (role === "tool" || role === "function") {
    const content = ensureArray(message.content)
      .map(part => (typeof part === "string" ? part : JSON.stringify(part)))
      .join("\n");
    return { role, name, tool_call_id, content };
  }

  const contentParts = ensureArray(message.content).map(normalizeContentPart);

  // Collapse single-text content to a plain string for maximum compatibility
  if (contentParts.length === 1 && contentParts[0].type === "text") {
    return { role, name, content: contentParts[0].text };
  }

  return { role, name, content: contentParts };
};

const normalizeToolChoice = (
  toolChoice: ToolChoice | undefined,
  tools: Tool[] | undefined
): "none" | "auto" | ToolChoiceExplicit | undefined => {
  if (!toolChoice) return undefined;
  if (toolChoice === "none" || toolChoice === "auto") return toolChoice;

  if (toolChoice === "required") {
    if (!tools || tools.length === 0)
      throw new Error("tool_choice 'required' was provided but no tools were configured");
    if (tools.length > 1)
      throw new Error("tool_choice 'required' needs a single tool or specify the tool name explicitly");
    return { type: "function", function: { name: tools[0].function.name } };
  }

  if ("name" in toolChoice) {
    return { type: "function", function: { name: toolChoice.name } };
  }

  return toolChoice;
};

const normalizeResponseFormat = ({
  responseFormat,
  response_format,
  outputSchema,
  output_schema,
}: {
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
}):
  | { type: "json_schema"; json_schema: JsonSchema }
  | { type: "text" }
  | { type: "json_object" }
  | undefined => {
  const explicitFormat = responseFormat || response_format;
  if (explicitFormat) {
    if (explicitFormat.type === "json_schema" && !explicitFormat.json_schema?.schema)
      throw new Error("responseFormat json_schema requires a defined schema object");
    return explicitFormat;
  }

  const schema = outputSchema || output_schema;
  if (!schema) return undefined;
  if (!schema.name || !schema.schema)
    throw new Error("outputSchema requires both name and schema");

  return {
    type: "json_schema",
    json_schema: {
      name: schema.name,
      schema: schema.schema,
      ...(typeof schema.strict === "boolean" ? { strict: schema.strict } : {}),
    },
  };
};

// ─── Transient-failure retry ───────────────────────────────────────────────────

// Statuses worth retrying: rate-limit (429), Anthropic "overloaded" (529), and
// gateway/upstream blips (500/502/503/504). A scanned-PDF extraction must not die
// because api.anthropic.com's Cloudflare front returned a one-off 502.
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * fetch() with bounded exponential backoff (+jitter) on transient upstream
 * failures and network errors. Non-transient responses (2xx, 4xx) return
 * immediately. After exhausting retries on a transient status, returns the last
 * response unconsumed so the caller surfaces the upstream error as usual.
 */
async function fetchLLM(url: string, init: RequestInit, retries = 3): Promise<Response> {
  let lastResponse: Response | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (TRANSIENT_STATUS.has(res.status) && attempt < retries) {
        // Discard the failed body so the socket can be reused; keep the latest
        // around only to return if every attempt fails.
        if (lastResponse) lastResponse.body?.cancel().catch(() => {});
        lastResponse = res;
        await sleep(500 * 2 ** attempt + Math.floor(Math.random() * 250));
        continue;
      }
      return res;
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(500 * 2 ** attempt + Math.floor(Math.random() * 250));
    }
  }
  return lastResponse as Response;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Invoke the configured LLM provider.
 *
 * Automatically selects Manus Forge or a direct provider (Anthropic / OpenAI)
 * based on environment variables — no code changes needed between environments.
 */
export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  const provider = resolveProvider();

  // Anthropic speaks the Messages API, not OpenAI Chat Completions — translate.
  if (provider.kind === "anthropic") {
    return invokeAnthropic(params, provider);
  }

  const {
    messages,
    tools,
    toolChoice,
    tool_choice,
    outputSchema,
    output_schema,
    responseFormat,
    response_format,
  } = params;

  const payload: Record<string, unknown> = {
    model: provider.model,
    messages: messages.map(normalizeMessage),
  };

  if (tools && tools.length > 0) {
    payload.tools = tools;
  }

  const normalizedToolChoice = normalizeToolChoice(toolChoice || tool_choice, tools);
  if (normalizedToolChoice) {
    payload.tool_choice = normalizedToolChoice;
  }

  // Forge-specific parameters (ignored by direct providers)
  if (provider.mode === "forge") {
    payload.max_tokens = 32768;
    payload.thinking = { budget_tokens: 128 };
  } else {
    // Direct provider: respect caller's max_tokens or use a sensible default
    payload.max_tokens = params.maxTokens ?? params.max_tokens ?? 4096;
  }

  const normalizedResponseFormat = normalizeResponseFormat({
    responseFormat,
    response_format,
    outputSchema,
    output_schema,
  });
  if (normalizedResponseFormat) {
    payload.response_format = normalizedResponseFormat;
  }

  // Data residency: in on-premise mode this throws unless apiUrl is local/allowlisted.
  assertEgressAllowed(provider.apiUrl, "LLM call");

  const response = await fetchLLM(provider.apiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `LLM invoke failed [${provider.mode}/${provider.model}]: ` +
      `${response.status} ${response.statusText} – ${errorText}`
    );
  }

  return (await response.json()) as InvokeResult;
}

/**
 * Returns the active provider mode for observability / health checks.
 * "forge"  → Manus Forge API (BUILT_IN_FORGE_API_KEY)
 * "direct" → Direct provider  (DIRECT_LLM_API_KEY)
 */
export function getLlmProviderInfo(): {
  mode: "forge" | "direct";
  model: string;
  apiUrl: string;
} {
  const { mode, model, apiUrl } = resolveProvider();
  return { mode, model, apiUrl };
}

// ─── Anthropic Messages API adapter ────────────────────────────────────────────
//
// Translates the OpenAI-shaped InvokeParams into Anthropic's native Messages API
// and maps the response back into the OpenAI-shaped InvokeResult, so every
// existing caller of invokeLLM() keeps working byte-for-byte unchanged.
//
// Key differences handled here:
//  • system prompts are a top-level `system` field, not a message with role "system"
//  • `max_tokens` is required
//  • structured output (response_format / outputSchema) has no direct equivalent —
//    we synthesise a single forced tool ("emit_result") whose input_schema is the
//    requested JSON schema, then return the tool input as the message content so
//    callers that JSON.parse(choices[0].message.content) keep working.

const ANTHROPIC_VERSION = "2023-06-01";
const EMIT_TOOL_NAME = "emit_result";

type AnthropicTextBlock = { type: "text"; text: string };
type AnthropicToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

export type AnthropicResponse = {
  id: string;
  model: string;
  stop_reason: string | null;
  content: AnthropicContentBlock[];
  usage?: { input_tokens: number; output_tokens: number };
};

function extractPlainText(content: MessageContent | MessageContent[]): string {
  return ensureArray(content)
    .map((part) => {
      if (typeof part === "string") return part;
      if (part.type === "text") return part.text;
      return "";
    })
    .join("\n")
    .trim();
}

/** Parse a `data:<media>;base64,<data>` URL into its parts, or null if not one. */
function parseDataUrl(url: string): { mediaType: string; base64: string } | null {
  // [\s\S] instead of the dotAll `s` flag (which needs an es2018+ target).
  const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
  if (!m) return null;
  return { mediaType: m[1], base64: m[2] };
}

function toAnthropicContent(
  content: MessageContent | MessageContent[]
): string | Array<Record<string, unknown>> {
  const parts = ensureArray(content).map(normalizeContentPart);
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts.map((p) => {
    if (p.type === "text") return { type: "text", text: p.text };
    if (p.type === "image_url") {
      const data = parseDataUrl(p.image_url.url);
      return data
        ? { type: "image", source: { type: "base64", media_type: data.mediaType, data: data.base64 } }
        : { type: "image", source: { type: "url", url: p.image_url.url } };
    }
    // PDF documents: Anthropic supports a `document` block (base64 or URL source).
    // Claude reads the PDF natively, including scanned/image-only statements.
    const fileUrl = (p as FileContent).file_url.url;
    const mime = (p as FileContent).file_url.mime_type;
    if (mime === "application/pdf" || /\.pdf($|\?)/i.test(fileUrl) || /^data:application\/pdf;/.test(fileUrl)) {
      const data = parseDataUrl(fileUrl);
      return data
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: data.base64 } }
        : { type: "document", source: { type: "url", url: fileUrl } };
    }
    // Any other attachment type — degrade to a text note.
    return { type: "text", text: `[attachment: ${fileUrl}]` };
  });
}

/**
 * Build the Anthropic Messages API request body from OpenAI-shaped params.
 * Exported for unit testing (no network). Returns `forcedEmit` so the response
 * mapper knows to read the result from the forced tool call.
 */
export function buildAnthropicPayload(
  params: InvokeParams,
  model: string
): { payload: Record<string, unknown>; forcedEmit: boolean } {
  const systemTexts: string[] = [];
  const messages: Array<{ role: "user" | "assistant"; content: string | Array<Record<string, unknown>> }> = [];

  for (const m of params.messages) {
    if (m.role === "system") {
      const text = extractPlainText(m.content);
      if (text) systemTexts.push(text);
      continue;
    }
    if (m.role === "tool" || m.role === "function") {
      // No current caller uses tool results; carry the text as a user turn.
      const text = ensureArray(m.content)
        .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
        .join("\n");
      messages.push({ role: "user", content: text });
      continue;
    }
    messages.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: toAnthropicContent(m.content),
    });
  }

  const payload: Record<string, unknown> = {
    model,
    max_tokens: params.maxTokens ?? params.max_tokens ?? 4096,
    messages,
  };
  if (systemTexts.length > 0) payload.system = systemTexts.join("\n\n");

  // Structured output → forced single-tool call.
  const rf = normalizeResponseFormat({
    responseFormat: params.responseFormat,
    response_format: params.response_format,
    outputSchema: params.outputSchema,
    output_schema: params.output_schema,
  });

  let forcedEmit = false;
  if (rf && (rf.type === "json_schema" || rf.type === "json_object")) {
    forcedEmit = true;
    const inputSchema =
      rf.type === "json_schema"
        ? (rf.json_schema.schema as Record<string, unknown>)
        : { type: "object", additionalProperties: true };
    payload.tools = [
      {
        name: EMIT_TOOL_NAME,
        description: "Return the result strictly as structured data matching the schema.",
        input_schema: inputSchema,
      },
    ];
    payload.tool_choice = { type: "tool", name: EMIT_TOOL_NAME };
  } else if (params.tools && params.tools.length > 0) {
    // Pass-through for callers that supply real tools.
    payload.tools = params.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters ?? { type: "object" },
    }));
    const tc = normalizeToolChoice(params.toolChoice || params.tool_choice, params.tools);
    if (tc === "auto") payload.tool_choice = { type: "auto" };
    else if (tc && typeof tc === "object") payload.tool_choice = { type: "tool", name: tc.function.name };
  }

  return { payload, forcedEmit };
}

function mapStopReason(stop: string | null): string {
  switch (stop) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return stop ?? "stop";
  }
}

/**
 * Map an Anthropic Messages response into the OpenAI-shaped InvokeResult.
 * Exported for unit testing. When `forcedEmit`, the structured tool input is
 * serialised into `choices[0].message.content`.
 */
export function mapAnthropicResponse(
  data: AnthropicResponse,
  forcedEmit: boolean,
  fallbackModel: string
): InvokeResult {
  const blocks = Array.isArray(data.content) ? data.content : [];
  const textBlocks = blocks.filter((b): b is AnthropicTextBlock => b.type === "text");
  const toolUseBlocks = blocks.filter((b): b is AnthropicToolUseBlock => b.type === "tool_use");

  let content = "";
  let toolCalls: ToolCall[] | undefined;

  if (forcedEmit) {
    const emit = toolUseBlocks.find((b) => b.name === EMIT_TOOL_NAME) ?? toolUseBlocks[0];
    content = emit ? JSON.stringify(emit.input) : textBlocks.map((b) => b.text).join("");
  } else {
    content = textBlocks.map((b) => b.text).join("");
    if (toolUseBlocks.length > 0) {
      toolCalls = toolUseBlocks.map((b) => ({
        id: b.id,
        type: "function" as const,
        function: { name: b.name, arguments: JSON.stringify(b.input) },
      }));
    }
  }

  return {
    id: data.id,
    created: Math.floor(Date.now() / 1000),
    model: data.model ?? fallbackModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: mapStopReason(data.stop_reason),
      },
    ],
    usage: data.usage
      ? {
          prompt_tokens: data.usage.input_tokens,
          completion_tokens: data.usage.output_tokens,
          total_tokens: data.usage.input_tokens + data.usage.output_tokens,
        }
      : undefined,
  };
}

async function invokeAnthropic(
  params: InvokeParams,
  provider: ProviderConfig
): Promise<InvokeResult> {
  const { payload, forcedEmit } = buildAnthropicPayload(params, provider.model);

  // Data residency: in on-premise mode this throws unless apiUrl is local/allowlisted
  // (a local Anthropic-Messages-compatible gateway is allowed; api.anthropic.com is not).
  assertEgressAllowed(provider.apiUrl, "LLM call");

  const response = await fetchLLM(provider.apiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": provider.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `LLM invoke failed [anthropic/${provider.model}]: ` +
        `${response.status} ${response.statusText} – ${errorText}`
    );
  }

  const data = (await response.json()) as AnthropicResponse;
  return mapAnthropicResponse(data, forcedEmit, provider.model);
}
