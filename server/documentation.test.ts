import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

describe('Documentation Files', () => {
  it('should have User Guide file', () => {
    const userGuidePath = join(__dirname, '..', 'docs', 'guides', 'ReconcileAI_User_Guide.md');
    expect(existsSync(userGuidePath)).toBe(true);
    
    const content = readFileSync(userGuidePath, 'utf-8');
    expect(content).toContain('# ReconcileAI User Guide');
    expect(content).toContain('## Table of Contents');
    expect(content.length).toBeGreaterThan(10000); // Should be substantial
  });

  it('should have Administrator Guide file', () => {
    const adminGuidePath = join(__dirname, '..', 'docs', 'guides', 'ReconcileAI_Admin_Guide.md');
    expect(existsSync(adminGuidePath)).toBe(true);
    
    const content = readFileSync(adminGuidePath, 'utf-8');
    expect(content).toContain('# ReconcileAI Administrator Guide');
    expect(content).toContain('## Table of Contents');
    expect(content.length).toBeGreaterThan(10000); // Should be substantial
  });

  it('should have Quick Start Guide file', () => {
    const quickStartPath = join(__dirname, '..', 'docs', 'guides', 'ReconcileAI_Quick_Start.md');
    expect(existsSync(quickStartPath)).toBe(true);
    
    const content = readFileSync(quickStartPath, 'utf-8');
    expect(content).toContain('# ReconcileAI Quick Start Guide');
    expect(content).toContain('## Welcome to ReconcileAI');
    expect(content.length).toBeGreaterThan(5000); // Should be substantial
  });

  it('should have comprehensive content in User Guide', () => {
    const userGuidePath = join(__dirname, '..', 'docs', 'guides', 'ReconcileAI_User_Guide.md');
    const content = readFileSync(userGuidePath, 'utf-8');
    
    // Check for key sections
    expect(content).toContain('Getting Started');
    expect(content).toContain('Transaction Data Upload');
    expect(content).toContain('Reconciliation Jobs');
    expect(content).toContain('Exception Management');
    expect(content).toContain('Three-Module Architecture');
    expect(content).toContain('Transaction Integrity');
    expect(content).toContain('Settlement Reconciliation');
    expect(content).toContain('Account-Level Reconciliation');
  });

  it('should have comprehensive content in Administrator Guide', () => {
    const adminGuidePath = join(__dirname, '..', 'docs', 'guides', 'ReconcileAI_Admin_Guide.md');
    const content = readFileSync(adminGuidePath, 'utf-8');
    
    // Check for key sections
    expect(content).toContain('Administrator Overview');
    expect(content).toContain('User Management');
    expect(content).toContain('Module Configuration');
    expect(content).toContain('Matching Engine Configuration');
    expect(content).toContain('Integration Management');
    expect(content).toContain('Security and Compliance');
    expect(content).toContain('Performance Monitoring');
    expect(content).toContain('Troubleshooting');
  });
});

/**
 * These endpoint tests `await import('./routers')`, which pulls in the full
 * ~7k-line appRouter and its transitive DB/scheduler modules, then builds a
 * request context. That module-load cost alone can exceed vitest's default 5s
 * budget on a cold run or against a remote database, so they failed
 * intermittently for timing reasons rather than behaviour. The assertions are
 * unchanged — only the time budget is made explicit.
 */
const ROUTER_TEST_TIMEOUT_MS = 30_000;

describe('Documentation Backend Endpoints', () => {
  it('should have docs.download endpoint', async () => {
    const { appRouter } = await import('./routers');
    const { createContext } = await import('./_core/context');
    
    const mockReq = {} as any;
    const mockRes = {} as any;
    const ctx = createContext({ req: mockReq, res: mockRes });
    const caller = appRouter.createCaller(ctx);

    const result = await caller.docs.download({
      filename: 'ReconcileAI_Quick_Start.md',
    });

    expect(result).toBeDefined();
    expect(result.filename).toBe('ReconcileAI_Quick_Start.md');
    expect(result.contentType).toBe('text/markdown');
    expect(result.content).toContain('ReconcileAI');
  }, ROUTER_TEST_TIMEOUT_MS);

  it('should download User Guide via endpoint', async () => {
    const { appRouter } = await import('./routers');
    const { createContext } = await import('./_core/context');
    
    const mockReq = {} as any;
    const mockRes = {} as any;
    const ctx = createContext({ req: mockReq, res: mockRes });
    const caller = appRouter.createCaller(ctx);

    const result = await caller.docs.download({
      filename: 'ReconcileAI_User_Guide.md',
    });

    expect(result.filename).toBe('ReconcileAI_User_Guide.md');
    expect(result.content.length).toBeGreaterThan(10000);
  }, ROUTER_TEST_TIMEOUT_MS);

  it('should download Admin Guide via endpoint', async () => {
    const { appRouter } = await import('./routers');
    const { createContext } = await import('./_core/context');
    
    const mockReq = {} as any;
    const mockRes = {} as any;
    const ctx = createContext({ req: mockReq, res: mockRes });
    const caller = appRouter.createCaller(ctx);

    const result = await caller.docs.download({
      filename: 'ReconcileAI_Admin_Guide.md',
    });

    expect(result.filename).toBe('ReconcileAI_Admin_Guide.md');
    expect(result.content.length).toBeGreaterThan(10000);
  }, ROUTER_TEST_TIMEOUT_MS);
});
