import { describe, it, expect } from "vitest";
import { appRouter } from "./routers";

describe("Documentation S3 Download", () => {
  it("should serve Quick Start Guide markdown from S3", async () => {
    const caller = appRouter.createCaller({ user: null });
    const result = await caller.docs.download({ filename: "ReconcileAI_Quick_Start.md" });
    
    expect(result).toBeDefined();
    expect(result.filename).toBe("ReconcileAI_Quick_Start.md");
    expect(result.contentType).toBe("text/markdown");
    expect(result.content).toContain("# ReconcileAI Quick Start Guide");
    expect(result.url).toContain("https://files.manuscdn.com");
  });

  it("should serve Quick Start Guide Word document from S3", async () => {
    const caller = appRouter.createCaller({ user: null });
    const result = await caller.docs.download({ filename: "ReconcileAI_Quick_Start.docx" });
    
    expect(result).toBeDefined();
    expect(result.filename).toBe("ReconcileAI_Quick_Start.docx");
    expect(result.contentType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.url).toContain("https://files.manuscdn.com");
  });

  it("should serve User Guide markdown from S3", async () => {
    const caller = appRouter.createCaller({ user: null });
    const result = await caller.docs.download({ filename: "ReconcileAI_User_Guide.md" });
    
    expect(result).toBeDefined();
    expect(result.filename).toBe("ReconcileAI_User_Guide.md");
    expect(result.contentType).toBe("text/markdown");
    expect(result.content).toContain("# ReconcileAI User Guide");
    expect(result.url).toContain("https://files.manuscdn.com");
  });

  it("should serve User Guide Word document from S3", async () => {
    const caller = appRouter.createCaller({ user: null });
    const result = await caller.docs.download({ filename: "ReconcileAI_User_Guide.docx" });
    
    expect(result).toBeDefined();
    expect(result.filename).toBe("ReconcileAI_User_Guide.docx");
    expect(result.contentType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.url).toContain("https://files.manuscdn.com");
  });

  it("should serve Administrator Guide markdown from S3", async () => {
    const caller = appRouter.createCaller({ user: null });
    const result = await caller.docs.download({ filename: "ReconcileAI_Admin_Guide.md" });
    
    expect(result).toBeDefined();
    expect(result.filename).toBe("ReconcileAI_Admin_Guide.md");
    expect(result.contentType).toBe("text/markdown");
    expect(result.content).toContain("# ReconcileAI Administrator Guide");
    expect(result.url).toContain("https://files.manuscdn.com");
  });

  it("should serve Administrator Guide Word document from S3", async () => {
    const caller = appRouter.createCaller({ user: null });
    const result = await caller.docs.download({ filename: "ReconcileAI_Admin_Guide.docx" });
    
    expect(result).toBeDefined();
    expect(result.filename).toBe("ReconcileAI_Admin_Guide.docx");
    expect(result.contentType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.url).toContain("https://files.manuscdn.com");
  });

  it("should return correct content type for markdown files", async () => {
    const caller = appRouter.createCaller({ user: null });
    const result = await caller.docs.download({ filename: "ReconcileAI_Quick_Start.md" });
    
    expect(result.contentType).toBe("text/markdown");
  });

  it("should return correct content type for Word documents", async () => {
    const caller = appRouter.createCaller({ user: null });
    const result = await caller.docs.download({ filename: "ReconcileAI_Quick_Start.docx" });
    
    expect(result.contentType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  it("should include S3 CDN URL in response", async () => {
    const caller = appRouter.createCaller({ user: null });
    const result = await caller.docs.download({ filename: "ReconcileAI_Quick_Start.md" });
    
    expect(result.url).toBeDefined();
    expect(result.url).toMatch(/^https:\/\/files\.manuscdn\.com\//);
  });

  it("should fetch content successfully from S3", async () => {
    const caller = appRouter.createCaller({ user: null });
    const result = await caller.docs.download({ filename: "ReconcileAI_User_Guide.md" });
    
    // Verify content is not empty
    expect(result.content).toBeDefined();
    expect(result.content.length).toBeGreaterThan(1000); // User guide should be substantial
    
    // Verify content structure
    expect(result.content).toContain("# ReconcileAI User Guide");
    expect(result.content).toContain("## Table of Contents");
  });
});
