import { describe, expect, it } from "vitest";
import {
  buildAnthropicPayload,
  mapAnthropicResponse,
  type AnthropicResponse,
} from "./_core/llm";

describe("buildAnthropicPayload", () => {
  it("extracts system prompts, keeps user/assistant turns, and defaults max_tokens", () => {
    const { payload, forcedEmit } = buildAnthropicPayload(
      {
        messages: [
          { role: "system", content: "You are a reconciliation analyst." },
          { role: "user", content: "Classify this exception." },
          { role: "assistant", content: "Sure." },
        ],
      },
      "claude-sonnet-4-5"
    );

    expect(forcedEmit).toBe(false);
    expect(payload.model).toBe("claude-sonnet-4-5");
    expect(payload.system).toBe("You are a reconciliation analyst.");
    expect(payload.max_tokens).toBe(4096); // required by Anthropic; sensible default
    expect(payload.messages).toEqual([
      { role: "user", content: "Classify this exception." },
      { role: "assistant", content: "Sure." },
    ]);
    // System messages must NOT leak into the messages array.
    expect((payload.messages as Array<{ role: string }>).some((m) => m.role === "system")).toBe(false);
  });

  it("honours an explicit maxTokens", () => {
    const { payload } = buildAnthropicPayload(
      { messages: [{ role: "user", content: "hi" }], maxTokens: 1234 },
      "claude-sonnet-4-5"
    );
    expect(payload.max_tokens).toBe(1234);
  });

  it("maps response_format json_schema onto a forced emit_result tool", () => {
    const schema = {
      type: "object",
      properties: { severity: { type: "string" }, confidence: { type: "number" } },
      required: ["severity"],
    };

    const { payload, forcedEmit } = buildAnthropicPayload(
      {
        messages: [{ role: "user", content: "Analyse." }],
        response_format: {
          type: "json_schema",
          json_schema: { name: "analysis", schema },
        },
      },
      "claude-sonnet-4-5"
    );

    expect(forcedEmit).toBe(true);
    expect(payload.tool_choice).toEqual({ type: "tool", name: "emit_result" });
    const tools = payload.tools as Array<{ name: string; input_schema: unknown }>;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("emit_result");
    expect(tools[0].input_schema).toEqual(schema);
  });

  it("maps json_object onto a generic object emit_result tool", () => {
    const { payload, forcedEmit } = buildAnthropicPayload(
      {
        messages: [{ role: "user", content: "Give me JSON." }],
        response_format: { type: "json_object" },
      },
      "claude-sonnet-4-5"
    );
    expect(forcedEmit).toBe(true);
    const tools = payload.tools as Array<{ name: string; input_schema: { type: string } }>;
    expect(tools[0].name).toBe("emit_result");
    expect(tools[0].input_schema.type).toBe("object");
  });
});

describe("mapAnthropicResponse", () => {
  const usage = { input_tokens: 120, output_tokens: 30 };

  it("serialises the forced tool input into message.content (so JSON.parse keeps working)", () => {
    const data: AnthropicResponse = {
      id: "msg_1",
      model: "claude-sonnet-4-5",
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "tu_1", name: "emit_result", input: { severity: "high", confidence: 0.92 } },
      ],
      usage,
    };

    const result = mapAnthropicResponse(data, /* forcedEmit */ true, "fallback-model");

    expect(result.id).toBe("msg_1");
    expect(result.model).toBe("claude-sonnet-4-5");
    const content = result.choices[0].message.content as string;
    expect(JSON.parse(content)).toEqual({ severity: "high", confidence: 0.92 });
    expect(result.usage).toEqual({
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
    });
  });

  it("concatenates text blocks and maps stop_reason for plain responses", () => {
    const data: AnthropicResponse = {
      id: "msg_2",
      model: "claude-sonnet-4-5",
      stop_reason: "end_turn",
      content: [
        { type: "text", text: "Part one. " },
        { type: "text", text: "Part two." },
      ],
      usage,
    };

    const result = mapAnthropicResponse(data, /* forcedEmit */ false, "fallback-model");

    expect(result.choices[0].message.content).toBe("Part one. Part two.");
    expect(result.choices[0].message.tool_calls).toBeUndefined();
    expect(result.choices[0].finish_reason).toBe("stop");
  });

  it("exposes real tool_use blocks as OpenAI-shaped tool_calls when not forced", () => {
    const data: AnthropicResponse = {
      id: "msg_3",
      model: "claude-sonnet-4-5",
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu_9", name: "lookup", input: { q: "abc" } }],
    };

    const result = mapAnthropicResponse(data, false, "fallback-model");
    const toolCalls = result.choices[0].message.tool_calls;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls?.[0]).toMatchObject({
      id: "tu_9",
      type: "function",
      function: { name: "lookup", arguments: JSON.stringify({ q: "abc" }) },
    });
    expect(result.choices[0].finish_reason).toBe("tool_calls");
  });

  it("falls back to the provided model when the response omits one", () => {
    const data = {
      id: "msg_4",
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "truncated" }],
    } as unknown as AnthropicResponse;

    const result = mapAnthropicResponse(data, false, "claude-sonnet-4-5");
    expect(result.model).toBe("claude-sonnet-4-5");
    expect(result.choices[0].finish_reason).toBe("length");
    expect(result.usage).toBeUndefined();
  });
});
