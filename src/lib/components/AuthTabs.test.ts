// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const h = vi.hoisted(() => ({
  requestPasswordResetMock: vi.fn(),
  signInWithPasswordMock: vi.fn(),
  signInWithMagicLinkMock: vi.fn(),
  signUpWithPasswordMock: vi.fn(),
  gotoMock: vi.fn(),
  setupWizardMarkMock: vi.fn(),
  isDemoModeGet: vi.fn(() => false),
  isDemoModeDisableMock: vi.fn(),
}));

vi.mock('$lib/auth/supabase', () => ({
  requestPasswordReset: h.requestPasswordResetMock,
  signInWithPassword: h.signInWithPasswordMock,
  signInWithMagicLink: h.signInWithMagicLinkMock,
  signUpWithPassword: h.signUpWithPasswordMock,
}));

vi.mock('$app/navigation', () => ({ goto: h.gotoMock }));
vi.mock('$app/paths', () => ({ resolve: (p: string) => p }));

vi.mock('$lib/stores/demoStore', () => ({
  isDemoMode: {
    subscribe: (run: (v: boolean) => void) => {
      run(h.isDemoModeGet());
      return () => undefined;
    },
    disable: h.isDemoModeDisableMock,
  },
}));

vi.mock('$lib/stores/setupWizardStore', () => ({
  setupWizardPending: { mark: h.setupWizardMarkMock },
}));

const AuthTabs = (await import('./AuthTabs.svelte')).default;

function findButton(root: ParentNode, label: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  );
}

function typeInto(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

describe('AuthTabs — forgot-password panel', () => {
  let host: HTMLElement;
  let component: ReturnType<typeof mount>;

  beforeEach(() => {
    h.requestPasswordResetMock.mockReset();
    h.requestPasswordResetMock.mockResolvedValue({ error: null });
    document.body.innerHTML = '<div id="host"></div>';
    host = document.getElementById('host') as HTMLElement;
    component = mount(AuthTabs, { target: host, props: { initialTab: 'login' } });
    flushSync();
  });

  afterEach(() => {
    unmount(component);
  });

  function identifierInput() {
    return host.querySelector('input[autocomplete="username"]') as HTMLInputElement;
  }

  it('hides the "Forgot password?" link when no identifier is entered', () => {
    expect(findButton(host, 'Forgot password?')).toBeUndefined();
  });

  it('hides the link when the identifier is a username (no @)', () => {
    typeInto(identifierInput(), 'alice');
    expect(findButton(host, 'Forgot password?')).toBeUndefined();
  });

  it('shows the link when the identifier is a valid email', () => {
    typeInto(identifierInput(), 'alice@example.com');
    expect(findButton(host, 'Forgot password?')).toBeDefined();
  });

  it('opens an inline panel with the email pre-filled from the identifier', () => {
    typeInto(identifierInput(), 'alice@example.com');
    findButton(host, 'Forgot password?')!.click();
    flushSync();

    const panel = host.querySelector('#forgot-panel') as HTMLElement | null;
    expect(panel).not.toBeNull();
    const emailInput = panel!.querySelector('input') as HTMLInputElement;
    expect(emailInput.value).toBe('alice@example.com');
  });

  it('toggles the panel closed when "Cancel" is clicked', () => {
    typeInto(identifierInput(), 'alice@example.com');
    findButton(host, 'Forgot password?')!.click();
    flushSync();
    findButton(host, 'Cancel')!.click();
    flushSync();
    expect(host.querySelector('#forgot-panel')).toBeNull();
  });

  it('sends the reset and closes the panel on success', async () => {
    typeInto(identifierInput(), 'alice@example.com');
    findButton(host, 'Forgot password?')!.click();
    flushSync();

    findButton(host, 'Send reset link')!.click();
    // Two microtasks: one for the awaited resetPassword promise, one for the
    // subsequent state assignment to land before we flush effects.
    await Promise.resolve();
    await Promise.resolve();
    flushSync();

    expect(h.requestPasswordResetMock).toHaveBeenCalledWith('alice@example.com');
    expect(host.querySelector('#forgot-panel')).toBeNull();
    expect(host.textContent).toContain('Check your email');
  });

  it('keeps the panel open and surfaces the error on failure', async () => {
    h.requestPasswordResetMock.mockResolvedValueOnce({
      error: { message: 'Password reset requires a real email address.' },
    });

    typeInto(identifierInput(), 'alice@example.com');
    findButton(host, 'Forgot password?')!.click();
    flushSync();

    findButton(host, 'Send reset link')!.click();
    await Promise.resolve();
    await Promise.resolve();
    flushSync();

    expect(host.querySelector('#forgot-panel')).not.toBeNull();
    expect(host.textContent).toContain('Password reset requires a real email');
  });

  it('uses the latest typed email if the user edits the panel field before sending', async () => {
    typeInto(identifierInput(), 'alice@example.com');
    findButton(host, 'Forgot password?')!.click();
    flushSync();

    const panelInput = host.querySelector('#forgot-panel input') as HTMLInputElement;
    typeInto(panelInput, 'bob@example.com');

    findButton(host, 'Send reset link')!.click();
    await Promise.resolve();
    await Promise.resolve();
    flushSync();

    expect(h.requestPasswordResetMock).toHaveBeenCalledWith('bob@example.com');
  });
});

describe('AuthTabs — in-flight request guard (rate-limit protection)', () => {
  let host: HTMLElement;
  let component: ReturnType<typeof mount>;

  beforeEach(() => {
    h.signInWithPasswordMock.mockReset();
    document.body.innerHTML = '<div id="host"></div>';
    host = document.getElementById('host') as HTMLElement;
    component = mount(AuthTabs, { target: host, props: { initialTab: 'login' } });
    flushSync();
  });

  afterEach(() => {
    unmount(component);
  });

  function identifierInput() {
    return host.querySelector('input[autocomplete="username"]') as HTMLInputElement;
  }

  function passwordInput() {
    return host.querySelector('input[autocomplete="current-password"]') as HTMLInputElement;
  }

  it('fires only one sign-in request even if the button is clicked repeatedly while one is pending', async () => {
    // Hold the auth call open so the first request stays in flight across the
    // extra clicks — this is the spam-click sequence that trips Supabase's rate
    // limiter when the button isn't gated.
    let resolveSignIn: (v: { error: null }) => void = () => {};
    h.signInWithPasswordMock.mockReturnValue(
      new Promise((resolve) => {
        resolveSignIn = resolve;
      }),
    );

    typeInto(identifierInput(), 'alice@example.com');
    typeInto(passwordInput(), 'hunter2');

    const loginButton = findButton(host, 'Log in with password')!;
    loginButton.click();
    flushSync();

    expect(loginButton.disabled).toBe(true);

    // Impatient extra clicks while the first request is still pending.
    loginButton.click();
    loginButton.click();
    flushSync();

    expect(h.signInWithPasswordMock).toHaveBeenCalledTimes(1);

    resolveSignIn({ error: null });
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
  });

  it('re-enables the button after a failed sign-in so the user can retry', async () => {
    h.signInWithPasswordMock.mockResolvedValue({ error: { message: 'Invalid login credentials' } });

    typeInto(identifierInput(), 'alice@example.com');
    typeInto(passwordInput(), 'wrong');

    const loginButton = findButton(host, 'Log in with password')!;
    loginButton.click();
    await Promise.resolve();
    await Promise.resolve();
    flushSync();

    expect(loginButton.disabled).toBe(false);
    expect(host.textContent).toContain('Invalid login credentials');
  });
});
