<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import {
    signInWithMagicLink,
    signInWithPassword,
    signUpWithPassword
  } from '$lib/auth/supabase';

  let { initialTab = 'login' }: { initialTab?: 'login' | 'signup' } = $props();

  function getInitialActiveTab() {
    return initialTab;
  }

  let activeTab = $state<'login' | 'signup'>(getInitialActiveTab());
  let identifier = $state('');
  let password = $state('');
  let signUpConfirmPassword = $state('');
  let status = $state('');

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

    const { error } = await signUpWithPassword(identifier, password);
    const providedEmail = identifier.trim().includes('@');
    status = error
      ? error.message
      : providedEmail
        ? 'Account created. You can sign in with your email and password.'
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

<section class="auth container">
  <div class="left">
    <div class="intro-copy">
      <h1>{activeTab === 'login' ? 'Welcome Back' : 'Create Account'}</h1>
      <p>
        {activeTab === 'login'
          ? 'Use a password or an email magic link to sign in.'
          : 'Create your account so you can securely track your progress.'}
      </p>
    </div>

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
        <label>Email or Username <input bind:value={identifier} autocomplete="username" /></label>
        <label>Password <input bind:value={password} type="password" autocomplete="current-password" /></label>
        <button class="btn btn-primary" type="submit">Log In with Password</button>
        {#if showMagicLinkButton}
          <button class="btn btn-ghost" type="button" onclick={magicLink}>Email Magic Link</button>
        {/if}
      </form>
    {:else}
      <form class="auth-form" onsubmit={handleSignUpSubmit}>
        <label
          >Email or Username
          <span
            class="hint"
            title="We cannot contact you if you do not provide an email. This can be changed later in your account settings."
            aria-label="We cannot contact you if you do not provide an email. This can be changed later in your account settings."
            >ⓘ</span
          >
          <input bind:value={identifier} autocomplete="username" /></label
        >
        <label>Password <input bind:value={password} type="password" autocomplete="new-password" /></label>
        <label
          >Confirm Password <input bind:value={signUpConfirmPassword} type="password" autocomplete="new-password" /></label
        >
        <button class="btn btn-primary" type="submit">Create Account</button>
      </form>
    {/if}

    <a class="btn btn-ghost offline-cta" href={resolve('/app')}>continue without an account</a>
    <small>{status}</small>
  </div>
  <div class="right card">
    <div><strong>Track.</strong></div>
    <div><strong>Learn.</strong></div>
    <div><strong>Evolve.</strong></div>
  </div>
</section>

<style>
  .auth { min-height: 100dvh; display:grid; gap:1rem; align-items:stretch; grid-template-columns: 1fr; padding: 1rem 0; color: var(--text); }
  .left {
    background: color-mix(in oklab, var(--surface) 96%, var(--text) 4%);
    color: var(--text);
    border-radius: var(--radius-lg);
    padding: 1.5rem;
    display: grid;
    gap: .8rem;
    align-content: start;
    grid-auto-rows: max-content;
  }
  .intro-copy { min-height: 7.5rem; }
  .intro-copy h1 { margin: 0 0 .6rem; line-height: 1.15; }
  .intro-copy p { margin: 0; min-height: 3rem; line-height: 1.35; }
  .tabs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: .4rem;
    background: color-mix(in oklab, var(--surface) 82%, var(--text) 18%);
    border-radius: 14px;
    padding: .2rem;
  }
  .tab {
    appearance: none;
    -webkit-appearance: none;
    border: none;
    background: transparent;
    color: var(--text);
    border-radius: 10px;
    min-height: 3.75rem;
    padding: .55rem .8rem;
    line-height: 1.2;
    font-weight: 700;
    cursor: pointer;
  }
  .tab.active { background: var(--surface); }
  .tab:focus { outline: none; }
  .tab:focus-visible { outline: 2px solid color-mix(in oklab, var(--text) 45%, transparent); outline-offset: -2px; }
  .auth-form { display:grid; gap:.8rem; }
  .hint { cursor: help; margin-left: .4rem; color: var(--muted); font-size: .9em; }
  .offline-cta { justify-self: start; display: inline-flex; }
  input {
    display: block;
    width: 100%;
    padding: .7rem;
    border-radius: 12px;
    border: 1px solid color-mix(in oklab, var(--text) 28%, transparent);
    background: var(--surface);
    color: var(--text);
  }
  .right { background: var(--surface-soft); color: var(--text); padding:2rem; display:grid; place-content:space-evenly; }
  @media (min-width: 900px) { .auth { grid-template-columns: 1.05fr .95fr; } }
</style>
