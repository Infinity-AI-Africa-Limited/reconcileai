import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

describe('Documentation Files', () => {
  it('should have User Guide file', () => {
    const userGuidePath = join(__dirname, '..', '..', 'ReconcileAI_User_Guide.md');
    expect(existsSync(userGuidePath)).toBe(true);
    
    const content = readFileSync(userGuidePath, 'utf-8');
    expect(content).toContain('# ReconcileAI User Guide');
    expect(content).toContain('## Table of Contents');
    expect(content.length).toBeGreaterThan(10000); // Should be substantial
  });

  it('should have Administrator Guide file', () => {
    const adminGuidePath = join(__dirname, '..', '..', 'ReconcileAI_Admin_Guide.md');
    expect(existsSync(adminGuidePath)).toBe(true);
    
    const content = readFileSync(adminGuidePath, 'utf-8');
    expect(content).toContain('# ReconcileAI Administrator Guide');
    expect(content).toContain('## Table of Contents');
    expect(content.length).toBeGreaterThan(10000); // Should be substantial
  });

  it('should have Quick Start Guide file', () => {
    const quickStartPath = join(__dirname, '..', '..', 'ReconcileAI_Quick_Start.md');
    expect(existsSync(quickStartPath)).toBe(true);
    
    const content = readFileSync(quickStartPath, 'utf-8');
    expect(content).toContain('# ReconcileAI Quick Start Guide');
    expect(content).toContain('## Welcome to ReconcileAI');
    expect(content.length).toBeGreaterThan(5000); // Should be substantial
  });

  it('should have comprehensive content in User Guide', () => {
    const userGuidePath = join(__dirname, '..', '..', 'ReconcileAI_User_Guide.md');
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
    const adminGuidePath = join(__dirname, '..', '..', 'ReconcileAI_Admin_Guide.md');
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
