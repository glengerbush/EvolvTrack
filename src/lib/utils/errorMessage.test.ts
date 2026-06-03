import { describe, expect, it } from 'vitest';
import { errorMessage } from './errorMessage';

describe('errorMessage', () => {
  it('uses an Error instance message', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('passes a plain string through', () => {
    expect(errorMessage('already a message')).toBe('already a message');
  });

  it('pulls .message from a Postgrest-style error object (no more [object Object])', () => {
    const pgError = {
      message: 'new row violates row-level security policy for table "sync_changes_encrypted"',
      code: '42501',
      details: null,
      hint: null,
    };
    expect(errorMessage(pgError)).toBe(
      'new row violates row-level security policy for table "sync_changes_encrypted"',
    );
    expect(errorMessage(pgError)).not.toBe('[object Object]');
  });

  it('falls back to details, then hint, then JSON', () => {
    expect(errorMessage({ details: 'detail text' })).toBe('detail text');
    expect(errorMessage({ hint: 'a hint' })).toBe('a hint');
    expect(errorMessage({ code: '500' })).toBe('{"code":"500"}');
  });

  it('handles primitives without throwing', () => {
    expect(errorMessage(null)).toBe('null');
    expect(errorMessage(undefined)).toBe('undefined');
    expect(errorMessage(42)).toBe('42');
  });
});
