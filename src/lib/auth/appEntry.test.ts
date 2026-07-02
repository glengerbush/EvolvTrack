import { describe, it, expect } from 'vitest';
import { shouldEnterApp } from './appEntry';

describe('shouldEnterApp', () => {
  it('sends signed-in users into the app regardless of local data', () => {
    expect(shouldEnterApp('signed-in', false, false)).toBe(true);
    expect(shouldEnterApp('signed-in', false, true)).toBe(true);
  });

  it('continues an in-progress demo even when signed out with no data', () => {
    expect(shouldEnterApp('signed-out', true, false)).toBe(true);
  });

  it('does not treat demo mode as a reason to enter when honorDemo is false', () => {
    // `/` passes honorDemo=false: a leftover demo flag from an earlier visit
    // shouldn't hijack the marketing page the way it should for `/auth`.
    expect(shouldEnterApp('signed-out', true, false, false)).toBe(false);
  });

  it('still enters for signed-in or has-local-data even when honorDemo is false', () => {
    expect(shouldEnterApp('signed-in', true, false, false)).toBe(true);
    expect(shouldEnterApp('signed-out', false, true, false)).toBe(true);
  });

  it('sends signed-out users with local data into the app (returning offline user)', () => {
    expect(shouldEnterApp('signed-out', false, true)).toBe(true);
  });

  it('keeps a fresh signed-out visitor with no data on the entry page', () => {
    expect(shouldEnterApp('signed-out', false, false)).toBe(false);
  });

  it('keeps expired-session users on the entry page (handled by the layout)', () => {
    // Even with local data: the layout bounces expired sessions to /auth, so we
    // must not pre-empt that by routing them into /app.
    expect(shouldEnterApp('signed-out-expired', false, true)).toBe(false);
    expect(shouldEnterApp('signed-out-expired', false, false)).toBe(false);
  });

  it('does not act while auth is still loading', () => {
    expect(shouldEnterApp('loading', false, true)).toBe(false);
  });
});
