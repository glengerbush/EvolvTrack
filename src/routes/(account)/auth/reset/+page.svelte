<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { onDestroy, onMount } from 'svelte';
  import { supabase } from '$lib/auth/supabase';

  type Phase = 'waiting' | 'ready' | 'updating' | 'done';

  let phase = $state<Phase>('waiting');
  let newPassword = $state('');
  let confirmPassword = $state('');
  let status = $state('');

  // Supabase's reset email lands here with a recovery token in the URL. The
  // client (detectSessionInUrl: true) consumes it and fires PASSWORD_RECOVERY;
  // during that session updateUser({ password }) is permitted.
  let unsubscribe: (() => void) | null = null;

  onMount(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        phase = 'ready';
        status = '';
      }
    });
    unsubscribe = () => data.subscription.unsubscribe();

    // Fast-path: PASSWORD_RECOVERY may have fired before this listener
    // attached. If a session already exists, treat it as the recovery session.
    void (async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      if (sessionData.session && phase === 'waiting') phase = 'ready';
    })();

    // If nothing happens within a few seconds, the link is likely stale or
    // already used — surface that instead of leaving the user on a spinner.
    const timeoutId = window.setTimeout(() => {
      if (phase === 'waiting') {
        status =
          'Reset link could not be verified. It may have expired or already been used — request a new one from the login page.';
      }
    }, 4000);
    return () => window.clearTimeout(timeoutId);
  });

  onDestroy(() => {
    unsubscribe?.();
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (newPassword.length < 8) {
      status = 'Password must be at least 8 characters.';
      return;
    }
    if (newPassword !== confirmPassword) {
      status = 'Passwords do not match.';
      return;
    }
    phase = 'updating';
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) {
      phase = 'ready';
      status = error.message;
      return;
    }
    phase = 'done';
    status = 'Password updated. Sign in again with your new password.';
    // Invalidate all sessions so other devices can't continue on the old token.
    // Local IndexedDB data stays intact — only the auth session is cleared.
    try {
      await supabase.auth.signOut({ scope: 'global' });
    } catch {
      // Best-effort: still send the user to the login page even if the
      // network round-trip failed.
    }
    await goto(resolve('/auth'));
  }
</script>

<svelte:head>
  <title>Reset password · EvolvTrack</title>
</svelte:head>

<div class="auth-shell container">
  <a class="brand" href={resolve('/')}>
    <span class="brand-mark" aria-hidden="true"></span>
    EvolvTrack
  </a>

  <section class="auth-card" aria-labelledby="reset-heading">
    <header class="intro">
      <h1 id="reset-heading">Set a new password</h1>
      <p>Choose a new password for your account.</p>
    </header>

    {#if phase === 'waiting'}
      <p class="status" role="status">Verifying your reset link…</p>
    {:else if phase === 'done'}
      <p class="status" role="status">{status}</p>
    {:else}
      <form class="auth-form" onsubmit={submit}>
        <label>
          New password
          <input bind:value={newPassword} type="password" autocomplete="new-password" />
        </label>
        <label>
          Confirm new password
          <input bind:value={confirmPassword} type="password" autocomplete="new-password" />
        </label>
        <button class="btn btn-primary" type="submit" disabled={phase === 'updating'}>
          {phase === 'updating' ? 'Updating…' : 'Update password'}
        </button>
      </form>
    {/if}

    {#if status && phase !== 'done'}
      <p class="status" role="status">{status}</p>
    {/if}

    <div class="divider"><span>or</span></div>

    <a class="btn btn-ghost offline-cta" href={resolve('/auth')}>Back to log in</a>
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
  .intro { text-align: center; display: flex; flex-direction: column; gap: 0.4rem; }
  .intro h1 { margin: 0; font-size: clamp(1.5rem, 3.5vw, 1.9rem); line-height: 1.15; }
  .intro p { margin: 0; color: var(--muted); line-height: 1.4; }

  .auth-form { display: flex; flex-direction: column; gap: 0.75rem; }
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

  .offline-cta { display: block; width: 100%; text-align: center; text-decoration: none; }
</style>
