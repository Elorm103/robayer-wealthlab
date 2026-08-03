/**
 * Unit tests: sensitive-data masking — Version 5.0 Milestone 1.2 (AI
 * Governance & Safety), Task 6. Pure logic, no DB.
 */
import { describe, it, expect } from 'vitest';
import { maskSensitiveData } from '../../services/ai/sensitiveDataMasking';

describe('maskSensitiveData', () => {
  it('passes through null/undefined without flagging anything masked', () => {
    expect(maskSensitiveData(null)).toEqual({ masked: null, wasMasked: false });
    expect(maskSensitiveData(undefined)).toEqual({ masked: null, wasMasked: false });
  });

  it('leaves ordinary text completely untouched', () => {
    const text = 'What is the current price of a 91-day Treasury bill in Ghana?';
    const result = maskSensitiveData(text);
    expect(result.masked).toBe(text);
    expect(result.wasMasked).toBe(false);
  });

  it('detects and redacts a provider-style API key', () => {
    const result = maskSensitiveData('Use sk-abcdef1234567890abcdef1234 to authenticate.');
    expect(result.wasMasked).toBe(true);
    expect(result.masked).not.toContain('sk-abcdef1234567890abcdef1234');
    expect(result.masked).toContain('[REDACTED:provider_api_key]');
  });

  it('detects and redacts a bearer token', () => {
    const result = maskSensitiveData('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.some.payload');
    expect(result.wasMasked).toBe(true);
    expect(result.masked).toContain('[REDACTED:');
  });

  it('detects and redacts a labeled password', () => {
    const result = maskSensitiveData('password: SuperSecret123!');
    expect(result.wasMasked).toBe(true);
    expect(result.masked).not.toContain('SuperSecret123!');
  });

  it('detects and redacts a credentialed URL', () => {
    const result = maskSensitiveData('Fetch from https://admin:hunter2@internal.example.com/api');
    expect(result.wasMasked).toBe(true);
    expect(result.masked).not.toContain('hunter2');
  });

  it('detects and redacts a session id assignment', () => {
    const result = maskSensitiveData('session_id=a1b2c3d4e5f6g7h8');
    expect(result.wasMasked).toBe(true);
    expect(result.masked).not.toContain('a1b2c3d4e5f6g7h8');
  });

  it('redacts multiple distinct secrets in the same text, each independently', () => {
    const result = maskSensitiveData('key: sk-abcdef1234567890abcdef1234 and password: hunter2hunter2');
    expect(result.wasMasked).toBe(true);
    expect(result.masked).not.toContain('sk-abcdef1234567890abcdef1234');
    expect(result.masked).not.toContain('hunter2hunter2');
  });
});
