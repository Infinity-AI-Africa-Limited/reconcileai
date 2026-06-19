import { describe, it, expect } from "vitest";
import { buildAnthropicPayload, type InvokeParams } from "./_core/llm";

function userContent(params: InvokeParams) {
  const { payload } = buildAnthropicPayload(params, "claude-sonnet-4-5");
  const msgs = payload.messages as Array<{ role: string; content: unknown }>;
  return msgs[0].content as Array<Record<string, any>>;
}

describe("Anthropic adapter — document/image blocks", () => {
  it("emits a base64 document block for a PDF data URL", () => {
    const content = userContent({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Extract the transactions" },
            { type: "file_url", file_url: { url: "data:application/pdf;base64,QUJDRA==", mime_type: "application/pdf" } },
          ],
        },
      ],
    });
    const doc = content.find((c) => c.type === "document");
    expect(doc).toBeTruthy();
    expect(doc!.source).toEqual({ type: "base64", media_type: "application/pdf", data: "QUJDRA==" });
  });

  it("emits a URL document block for an http(s) PDF link", () => {
    const content = userContent({
      messages: [
        { role: "user", content: [{ type: "file_url", file_url: { url: "https://x.test/statement.pdf", mime_type: "application/pdf" } }] },
      ],
    });
    const doc = content.find((c) => c.type === "document");
    expect(doc!.source).toEqual({ type: "url", url: "https://x.test/statement.pdf" });
  });

  it("emits a base64 image block for an image data URL", () => {
    const content = userContent({
      messages: [
        { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
      ],
    });
    const img = content.find((c) => c.type === "image");
    expect(img!.source).toEqual({ type: "base64", media_type: "image/png", data: "AAAA" });
  });

  it("still supports structured output (forced emit tool) alongside a document", () => {
    const { payload, forcedEmit } = buildAnthropicPayload(
      {
        messages: [
          { role: "user", content: [{ type: "file_url", file_url: { url: "data:application/pdf;base64,QQ==", mime_type: "application/pdf" } }] },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "rows", schema: { type: "object", properties: {}, additionalProperties: true } },
        },
      },
      "claude-sonnet-4-5",
    );
    expect(forcedEmit).toBe(true);
    expect((payload.tools as any[])[0].name).toBeTruthy();
  });
});
