/**
 * Unit tests: prompt/response encryption at rest — Version 5.0
 * Milestone 1.2 (AI Governance & Safety), Task 5. AES-256-GCM via Web
 * Crypto. No DB — these test the module's own encrypt/decrypt/
 * isEncrypted contract directly.
 */
import { describe, it, expect } from 'vitest';
import { encryptText, decryptText, isEncrypted, isEncryptionAvailable } from '../../services/ai/promptEncryption';

function randomBase64Key(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

describe('promptEncryption', () => {
  it('reports encryption unavailable when the key is absent', async () => {
    const envWithoutKey = {} as any;
    expect(await isEncryptionAvailable(envWithoutKey)).toBe(false);
    expect(await encryptText(envWithoutKey, 'secret')).toBeNull();
  });

  it('reports encryption unavailable for a malformed (wrong-length) key', async () => {
    const envWithBadKey = { AI_PROMPT_ENCRYPTION_KEY: btoa('too-short') } as any;
    expect(await isEncryptionAvailable(envWithBadKey)).toBe(false);
    expect(await encryptText(envWithBadKey, 'secret')).toBeNull();
  });

  it('encrypts to a value carrying the enc:v1: marker, and decrypts back to the exact original text', async () => {
    const env = { AI_PROMPT_ENCRYPTION_KEY: randomBase64Key() } as any;
    const plaintext = 'The customer asked about their Ghana Stock Exchange portfolio allocation.';

    const encrypted = await encryptText(env, plaintext);
    expect(encrypted).not.toBeNull();
    expect(encrypted!.startsWith('enc:v1:')).toBe(true);
    expect(encrypted).not.toContain(plaintext);
    expect(isEncrypted(encrypted)).toBe(true);

    const decrypted = await decryptText(env, encrypted!);
    expect(decrypted).toBe(plaintext);
  });

  it('produces a different ciphertext for the same plaintext each time (random IV)', async () => {
    const env = { AI_PROMPT_ENCRYPTION_KEY: randomBase64Key() } as any;
    const a = await encryptText(env, 'same input');
    const b = await encryptText(env, 'same input');
    expect(a).not.toBe(b);
  });

  it('treats legacy plaintext (no enc:v1: marker) as already-decrypted and returns it unchanged', async () => {
    const env = { AI_PROMPT_ENCRYPTION_KEY: randomBase64Key() } as any;
    expect(isEncrypted('plain old text')).toBe(false);
    expect(await decryptText(env, 'plain old text')).toBe('plain old text');
  });

  it('throws when asked to decrypt a genuinely encrypted value but the key is missing', async () => {
    const envWithKey = { AI_PROMPT_ENCRYPTION_KEY: randomBase64Key() } as any;
    const encrypted = await encryptText(envWithKey, 'secret');

    const envWithoutKey = {} as any;
    await expect(decryptText(envWithoutKey, encrypted!)).rejects.toThrow(/not configured/);
  });

  it('throws when the ciphertext has been tampered with (authentication failure)', async () => {
    const env = { AI_PROMPT_ENCRYPTION_KEY: randomBase64Key() } as any;
    const encrypted = await encryptText(env, 'secret');
    const tampered = encrypted!.slice(0, -4) + 'XXXX';
    await expect(decryptText(env, tampered)).rejects.toThrow();
  });
});
