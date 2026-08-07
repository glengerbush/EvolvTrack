<script lang="ts">
  import type { Snippet } from 'svelte';
  import { resolve } from '$app/paths';
  import {
    logoutCurrentDevice,
    type LogoutResult,
  } from '$lib/auth/logout';
  import type { PendingOutgoingChanges } from '$lib/sync/pending-outgoing-changes';
  import { errorMessage } from '$lib/utils/errorMessage';
  import LogoutPrompt from './LogoutPrompt.svelte';

  let {
    children,
    beforeStart,
  }: {
    children: Snippet<[() => void, boolean]>;
    beforeStart?: () => boolean;
  } = $props();

  let pending = $state<PendingOutgoingChanges | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);

  function navigateAfterCompletion() {
    window.location.href = resolve('/auth');
  }

  function handleResult(result: LogoutResult): void {
    if (result.status === 'complete') {
      navigateAfterCompletion();
      return;
    }
    pending = result.pending;
    if (result.status === 'sync-incomplete') {
      error = 'Sync did not complete. Your pending changes remain in this app.';
    }
  }

  async function run(strategy: 'require-synced' | 'sync-first' | 'discard') {
    if (busy) return;
    busy = true;
    error = null;
    try {
      handleResult(await logoutCurrentDevice(strategy));
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      busy = false;
    }
  }

  function start() {
    if (beforeStart && !beforeStart()) return;
    void run('require-synced');
  }

  function cancel() {
    if (busy) return;
    pending = null;
    error = null;
  }
</script>

{@render children(start, busy)}

{#if pending}
  <LogoutPrompt
    {pending}
    {busy}
    {error}
    onSync={() => run('sync-first')}
    onDiscard={() => run('discard')}
    onCancel={cancel}
  />
{/if}
