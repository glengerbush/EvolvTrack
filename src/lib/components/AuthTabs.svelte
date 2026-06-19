<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import {
    requestPasswordReset,
    signInWithMagicLink,
    signInWithPassword,
    signUpWithPassword
  } from '$lib/auth/supabase';
  import { isDemoMode } from '$lib/stores/demoStore';
  import { setupWizardPending } from '$lib/stores/setupWizardStore';
  import { get } from 'svelte/store';

  let { initialTab = 'login' }: { initialTab?: 'login' | 'signup' } = $props();

  function getInitialActiveTab() {
    return initialTab;
  }

  let activeTab = $state<'login' | 'signup'>(getInitialActiveTab());
  let identifier = $state('');
  let password = $state('');
  let signUpConfirmPassword = $state('');
  let status = $state('');
  let forgotPanelOpen = $state(false);
  let resetEmail = $state('');

  function isLikelyEmailAddress(value: string) {
    if (!value || value.length > 254 || /\s/.test(value)) return false;

    const parts = value.split('@');
    if (parts.length !== 2) return false;

    const [localPart, domain] = parts;
    if (!localPart || localPart.length > 64 || !domain) return false;
    if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return false;

    const domainLabels = domain.split('.');
    if (domainLabels.length < 2) return false;

    const labelPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
    if (!domainLabels.every((label) => labelPattern.test(label))) return false;

    const tld = domainLabels[domainLabels.length - 1] ?? '';
    const asciiTld = /^[a-z]{2,63}$/i;
    const punycodeTld = /^xn--[a-z0-9-]{1,59}$/i;
    if (!asciiTld.test(tld) && !punycodeTld.test(tld)) return false;

    return true;
  }

  const trimmedIdentifier = $derived(identifier.trim());
  const showMagicLinkButton = $derived(isLikelyEmailAddress(trimmedIdentifier));

  async function submitLogin() {
    if (!identifier.trim() || !password) {
      status = 'Email/username and password are required.';
      return;
    }

    const { error } = await signInWithPassword(identifier, password);
    if (error) {
      status = error.message;
      return;
    }

    status = 'Signed in with password.';
    await goto(resolve('/app'));
  }

  function toggleForgotPanel() {
    if (forgotPanelOpen) {
      forgotPanelOpen = false;
      return;
    }
    resetEmail = trimmedIdentifier;
    forgotPanelOpen = true;
    status = '';
  }

  async function sendPasswordReset() {
    const { error } = await requestPasswordReset(resetEmail);
    if (error) {
      status = error.message;
      return;
    }
    status = 'Check your email for a password reset link.';
    forgotPanelOpen = false;
  }

  async function magicLink() {
    if (!showMagicLinkButton) {
      status = 'Enter a valid email address (including a proper domain) to use a magic link.';
      return;
    }

    const { error } = await signInWithMagicLink(trimmedIdentifier);
    status = error ? error.message : 'Check your email for sign-in link.';
  }

  async function signUp() {
    if (!identifier.trim()) {
      status = 'Email or username is required.';
      return;
    }

    if (password !== signUpConfirmPassword) {
      status = 'Passwords do not match.';
      return;
    }

    const { data, error } = await signUpWithPassword(identifier, password);
    const providedEmail = identifier.trim().includes('@');

    if (error) {
      status = error.message;
      return;
    }

    // Demo data is sample content, not the user's own — drop it before the
    // account starts syncing so we never push demo rows up.
    if (get(isDemoMode)) {
      await isDemoMode.disable();
    }

    // Supabase returns a session here when email confirmation isn't required
    // (the common path for username-only signups). Treat that as logged-in
    // and route to the dashboard; the setup wizard takes it from there.
    if (data?.session) {
      setupWizardPending.mark();
      status = 'Account created.';
      await goto(resolve('/app'));
      return;
    }

    status = providedEmail
      ? 'Account created. Check your email to confirm and sign in.'
      : 'Account created. You can sign in with your username and password.';
  }

  function handleLoginSubmit(event: SubmitEvent) {
    event.preventDefault();
    void submitLogin();
  }

  function handleSignUpSubmit(event: SubmitEvent) {
    event.preventDefault();
    void signUp();
  }
</script>

<div class="auth-shell container">
  <a class="brand" href={resolve('/')}>
    <span class="brand-mark" aria-hidden="true"></span>
    EvolvTrack
  </a>

  <section class="auth-card" aria-labelledby="auth-heading">
    <header class="intro">
      <h1 id="auth-heading">
        {activeTab === 'login' ? 'Welcome back' : 'Create your account'}
      </h1>
      <p>
        {activeTab === 'login'
          ? 'Sign in with a password or an email magic link.'
          : 'A username and password are all we need — email is optional.'}
      </p>
    </header>

    <div class="tabs" role="tablist" aria-label="Authentication form">
      <button
        class="tab"
        class:active={activeTab === 'login'}
        role="tab"
        aria-selected={activeTab === 'login'}
        onclick={() => (activeTab = 'login')}
      >
        Log In
      </button>
      <button
        class="tab"
        class:active={activeTab === 'signup'}
        role="tab"
        aria-selected={activeTab === 'signup'}
        onclick={() => (activeTab = 'signup')}
      >
        Sign Up
      </button>
    </div>

    {#if activeTab === 'login'}
      <form class="auth-form" onsubmit={handleLoginSubmit}>
        <label>
          <span class="label-row">
            Email or username
            <span
              class="hint"
              title="Magic link / passwordless sign in requires an email."
              aria-label="Magic link / passwordless sign in requires an email."
            >ⓘ</span>
          </span>
          <input
            id="login-identifier"
            name="username"
            bind:value={identifier}
            autocomplete="username"
          />
        </label>
        <label>
          Password
          <input
            id="login-password"
            name="password"
            bind:value={password}
            type="password"
            autocomplete="current-password"
          />
        </label>
        <button class="btn btn-primary" type="submit">Log in with password</button>
        {#if showMagicLinkButton}
          <button class="btn btn-ghost" type="button" onclick={magicLink}>Email magic link</button>
          <button
            class="link-button"
            type="button"
            aria-expanded={forgotPanelOpen}
            aria-controls="forgot-panel"
            onclick={toggleForgotPanel}
          >
            {forgotPanelOpen ? 'Cancel' : 'Forgot password?'}
          </button>
          {#if forgotPanelOpen}
            <div id="forgot-panel" class="forgot-panel">
              <label>
                Email
                <input
                  id="reset-email"
                  name="email"
                  bind:value={resetEmail}
                  type="email"
                  autocomplete="email"
                  placeholder="you@example.com"
                />
              </label>
              <button class="btn btn-primary" type="button" onclick={sendPasswordReset}>
                Send reset link
              </button>
            </div>
          {/if}
        {/if}
      </form>
    {:else}
      <form class="auth-form" onsubmit={handleSignUpSubmit}>
        <label>
          <span class="label-row">
            Email or username
            <span
              class="hint"
              title="Magic link / passwordless sign in requires an email."
              aria-label="Magic link / passwordless sign in requires an email."
            >ⓘ</span>
          </span>
          <input
            id="signup-identifier"
            name="username"
            bind:value={identifier}
            autocomplete="username"
          />
        </label>
        <label>
          Password
          <input
            id="signup-password"
            name="new-password"
            bind:value={password}
            type="password"
            autocomplete="new-password"
          />
        </label>
        <label>
          Confirm password
          <input
            id="signup-confirm-password"
            name="confirm-password"
            bind:value={signUpConfirmPassword}
            type="password"
            autocomplete="new-password"
          />
        </label>
        <button class="btn btn-primary" type="submit">Create account</button>
      </form>
    {/if}

    {#if status}
      <p class="status" role="status">{status}</p>
    {/if}

    <div class="divider"><span>or</span></div>

    <a class="btn btn-ghost offline-cta" href={resolve('/app')}>Continue without an account</a>
    <p class="offline-note">
      Every browser handles data persistence differently,
      <a href={`${resolve('/app')}#faq-offline`}>checkout our FAQ to learn more</a>.
    </p>
  </section>
</div>

<style>
  .auth-shell {
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 1.25rem 0 2rem;
    gap: 1.5rem;
    color: var(--text);
  }
  .brand {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 800;
    letter-spacing: 0.02em;
    font-size: 1.1rem;
    color: var(--text);
    text-decoration: none;
  }
  /* Real app mark (masked /logo.svg), matching the in-app header lockup. */
  .brand-mark {
    width: 1.7rem;
    height: 1.7rem;
    flex: 0 0 auto;
    position: relative;
    border-radius: 7px;
    border: 1px solid var(--brand);
    background-color: var(--brand);
  }
  .brand-mark::before {
    content: '';
    position: absolute;
    inset: 5% 5% 0 0;
    background-color: #ffffff;
    -webkit-mask: url('/logo.svg') no-repeat center / 120% 120%;
    mask: url('/logo.svg') no-repeat center / 120% 120%;
  }

  .auth-card {
    width: min(100%, 26rem);
    margin: auto 0;
    background: var(--surface);
    color: var(--text);
    border-radius: var(--radius-lg);
    padding: 2rem 1.75rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    box-shadow: var(--shadow-soft);
  }
  .intro {
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .intro h1 {
    margin: 0;
    font-size: clamp(1.5rem, 3.5vw, 1.9rem);
    line-height: 1.15;
  }
  .intro p {
    margin: 0;
    color: var(--muted);
    line-height: 1.4;
  }

  .tabs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.3rem;
    background: color-mix(in oklab, var(--surface) 82%, var(--text) 18%);
    border-radius: 12px;
    padding: 0.25rem;
  }
  .tab {
    appearance: none;
    -webkit-appearance: none;
    border: none;
    background: transparent;
    color: var(--text);
    border-radius: 9px;
    padding: 0.6rem 0.8rem;
    line-height: 1.2;
    font-weight: 600;
    cursor: pointer;
    transition: background var(--motion-fast);
  }
  .tab.active {
    background: var(--surface);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  }
  .tab:focus { outline: none; }
  .tab:focus-visible { outline: 2px solid color-mix(in oklab, var(--text) 45%, transparent); outline-offset: -2px; }

  .auth-form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .auth-form label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.92rem;
    color: var(--muted);
  }
  input {
    display: block;
    width: 100%;
    padding: 0.7rem 0.8rem;
    border-radius: 10px;
    border: 1px solid color-mix(in oklab, var(--text) 22%, transparent);
    background: var(--surface);
    color: var(--text);
    font-size: 1rem;
  }
  input:focus {
    outline: 2px solid color-mix(in oklab, var(--brand) 60%, transparent);
    outline-offset: 1px;
    border-color: transparent;
  }
  .label-row {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }
  .hint {
    cursor: help;
    color: var(--muted);
    font-size: 0.9em;
  }

  .link-button {
    align-self: center;
    background: none;
    border: none;
    padding: 0.2rem 0.4rem;
    margin-top: -0.2rem;
    color: var(--muted);
    font-size: 0.88rem;
    cursor: pointer;
    text-decoration: underline;
  }
  .link-button:hover { color: var(--text); }
  .link-button:focus { outline: none; }
  .link-button:focus-visible {
    outline: 2px solid color-mix(in oklab, var(--text) 45%, transparent);
    outline-offset: 2px;
    border-radius: 4px;
  }

  .forgot-panel {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding: 0.85rem;
    border-radius: 10px;
    background: color-mix(in oklab, var(--surface) 82%, var(--text) 18%);
  }
  .forgot-panel label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.9rem;
    color: var(--muted);
  }

  .status {
    margin: 0;
    text-align: center;
    color: var(--muted);
    font-size: 0.9rem;
    line-height: 1.4;
  }

  .divider {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    color: var(--muted);
    font-size: 0.85rem;
    margin: 0.25rem 0;
  }
  .divider::before,
  .divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: color-mix(in oklab, var(--text) 14%, transparent);
  }

  .offline-cta {
    display: block;
    width: 100%;
    text-align: center;
    text-decoration: none;
  }

  .offline-note {
    margin: 0 0 0;
    text-align: center;
    font-size: 0.85rem;
    line-height: 1.4;
    color: var(--muted);
  }

  .offline-note a {
    color: var(--brand);
    text-decoration: underline;
  }
</style>
