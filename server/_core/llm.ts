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
 * Selection logic:
 *   If DIRECT_LLM_API_KEY is set and non-empty → use direct provider (Mode 2)
 *   Otherwise                                  → use Manus Forge (Mode 1)
 *
 * Zero code changes are needed between environments — only environment
 * variables differ. All callers use `invokeLLM()` identically in both modes.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { ENV } from "./env";

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

type ProviderConfig = {
  mode: "forge" | "direct";
  apiUrl: string;
  apiKey: string;
  model: string;
};

function resolveProvider(): ProviderConfig {
  const directKey = ENV.directLlmApiKey;

  if (directKey && directKey.trim().length > 0) {
    // Mode 2: Direct provider (Anthropic / OpenAI / any OpenAI-compatible API)
    const apiUrl =
      ENV.directLlmApiUrl && ENV.directLlmApiUrl.trim().length > 0
        ? `${ENV.directLlmApiUrl.replace(/\/$/, "")}/v1/chat/completions`
        : "https://api.openai.com/v1/chat/completions";

    const model =
      ENV.directLlmModel && ENV.directLlmModel.trim().length > 0
        ? ENV.directLlmModel
        : "gpt-4o";

    return { mode: "direct", apiUrl, apiKey: directKey, model };
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

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Invoke the configured LLM provider.
 *
 * Automatically selects Manus Forge or a direct provider (Anthropic / OpenAI)
 * based on environment variables — no code changes needed between environments.
 */
export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  const provider = resolveProvider();

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

  const response = await fetch(provider.apiUrl, {
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
