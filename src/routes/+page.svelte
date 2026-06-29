<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { isDemoMode } from '$lib/stores/demoStore';
  import { resolveAppEntry } from '$lib/auth/resolveAppEntry';

  async function continueOffline() {
    // Make sure demo data isn't lingering from a previous visit before
    // dropping the user into the real, empty app.
    await isDemoMode.disable();
    await goto('/app');
  }

  // A returning user can still land here directly (bookmark, shared link, or
  // typing the bare domain) even though the installed PWA opens at `/auth`.
  // Route signed-in / demo / has-local-data visitors straight into the app
  // rather than stranding them on the marketing page. The marketing markup is
  // left always-rendered (no `{#if}`) so it stays prerendered for SEO and for
  // genuinely new visitors.
  onMount(() => {
    let active = true;
    void resolveAppEntry().then((enter) => {
      if (active && enter) void goto('/app', { replaceState: true });
    });
    return () => {
      active = false;
    };
  });
</script>

<div class="page">
  <div class="container">
    <header class="topbar">
      <a href="/" class="brand">
        <span class="brand-mark" aria-hidden="true"></span>
        EvolvTrack
      </a>
      <nav class="top-actions">
        <a class="btn btn-primary" href="/auth">Log In / Sign Up</a>
      </nav>
    </header>

    <section class="hero">
      <div class="chart-frame card">
        <div class="chart-overlay">
          <h1>Your progress should belong to you.</h1>
          <p class="lede">Track dose, shot location, medication levels, and weight trends — offline first, end-to-end encrypted when you sync.</p>
          <a class="btn btn-demo-hero" href="/demo">
            Try the live demo →
          </a>
        </div>
      </div>
    </section>

    <section class="philosophy" aria-labelledby="what-heading">
      <h2 id="what-heading">What is this?</h2>
      <p class="section-lede">
        A health tracker for people on GLP1 and GIP medications who want clean data visualizations
        without giving up control of it. No accounts required, no terms to
        agree to, no data harvesting.
      </p>

      <div class="promise-grid">
        <article class="promise">
          <h3>You own your data</h3>
          <p>
            Instant account deletion. Export at any time. Setup end-to-end encryption and we can't access your data even on our servers. The full
            <a href="https://github.com/glengerbush/EvolvTrack" target="_blank" rel="noopener">source for the app and server</a>
            is public so you can audit it or run it yourself for personal use.
          </p>
        </article>

        <article class="promise">
          <h3>Beta testers get a free license, forever</h3>
          <p>
            If you're part of the beta group, your license is free for life
            and transferable to anyone you want to give it to.
          </p>
        </article>

        <article class="promise">
          <h3>We will never ask for personal details</h3>
          <p>
            No email, no phone, no name, no address. A username, password for login, and a passphrase for end-to-end encryption if you want to sync across devices. Or use offline without signing up.
            
          </p>
        </article>

        <article class="promise">
          <h3>A human reads every support email</h3>
          <p>
            No no canned replies. We are a small team and we will personally respond, just drop us a line at support@evolvtrack.com.
          </p>
        </article>

        <article class="promise">
          <h3>No terms and conditions</h3>
          <p>
            There's nothing to agree to, no pages of legal drivel, you just use the app.
            
          </p>
        </article>
      </div>
    </section>

    <section class="ways" aria-labelledby="ways-heading">
      <h2 id="ways-heading">Two ways to use this app</h2>

      <div class="ways-grid">
        <article class="way">
          <div class="way-tag">Free</div>
          <h3>Fully offline, one device</h3>
          <p>
            Open it, start tracking. Data lives in your browser's local
            storage. No account, no network, nothing to sign. Works as a
            PWA so you can install it like a native app.
          </p>
          <button type="button" class="btn btn-ghost way-cta" onclick={continueOffline}>
            Continue offline
          </button>
        </article>

        <article class="way featured">
          <div class="way-tag">Beta users: free for life</div>
          <h3>Synced across devices, optionally E2EE</h3>
          <p>
            Sign up for to sync between phone, laptop,
            and tablet. Turn on end-to-end encryption and the server only
            ever sees ciphertext — even we can't read your records.
          </p>
          <a class="btn btn-primary way-cta" href="/auth">Log In / Sign Up</a>
        </article>
      </div>
    </section>

    <section class="bottom-cta">
      <h2>See it in action first?</h2>
      <p>
        Spin up the demo with generated data, or jump straight into the
        empty app and start tracking your own.
      </p>
      <div class="bottom-buttons">
        <a class="btn btn-primary" href="/demo">
          Try the demo
        </a>
        <button type="button" class="btn btn-ghost" onclick={continueOffline}>
          Continue offline
        </button>
      </div>
    </section>

    <footer class="footer">
      <p>
        <a href="https://github.com/glengerbush/EvolvTrack" target="_blank" rel="noopener">Source on GitHub</a>
        · Drop us a line: <a href="mailto:hello@evolvtrack.com">hello@evolvtrack.com</a>
        · Built for the people who use it, not the data they generate.
      </p>
    </footer>
  </div>
</div>

<style>
  .page {
    /* Light graphite base with a graph-paper grid overlay, matching the
     * Dashboard's bgTint + gridLine treatment. */
    background-color: #e8ebee;
    background-image:
      linear-gradient(to right, rgba(60, 70, 80, 0.12) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(60, 70, 80, 0.12) 1px, transparent 1px);
    background-size: 30px 30px;
    min-height: 100dvh;
    padding-bottom: 3rem;
  }
  :global(html[data-color-mode='dark']) .page {
    background-color: #1d2024;
    background-image:
      linear-gradient(to right, rgba(220, 230, 240, 0.08) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(220, 230, 240, 0.08) 1px, transparent 1px);
  }

  .topbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 0;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .brand {
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
  .top-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  /* ---- Hero ---- */
  .hero {
    padding: 1.5rem 0 3rem;
  }
  .chart-frame {
    position: relative;
    overflow: hidden;
    background: transparent !important;
  }

  .chart-overlay {
    position: relative;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    text-align: center;
    padding: 2.5rem 1.5rem;
    min-height: 16rem;
    background: linear-gradient(
      to bottom,
      color-mix(in oklab, var(--surface) 5%, transparent) 0%,
      color-mix(in oklab, var(--surface) 85%, transparent) 100%
    );
  }
  .chart-overlay h1 {
    font-size: clamp(2rem, 6vw, 3.75rem);
    line-height: 1.05;
    max-width: 18ch;
    margin: 0 0 0.75rem;
  }
  .chart-overlay .lede {
    max-width: 48ch;
    color: var(--muted);
    margin: 0 0 1.5rem;
    font-size: clamp(1rem, 1.6vw, 1.1rem);
  }
  .btn-demo-hero {
    background: var(--brand);
    color: #fff;
    font-size: 1.05rem;
    padding: 0.9rem 1.6rem;
    box-shadow: 0 8px 18px color-mix(in oklab, var(--brand) 35%, transparent);
  }
  .btn-demo-hero:hover {
    transform: translateY(-1px);
  }

  /* ---- Shared section ---- */
  section.philosophy,
  section.ways,
  section.bottom-cta {
    padding: 3rem 0;
  }
  section h2 {
    font-size: clamp(1.6rem, 3vw, 2.25rem);
    margin: 0 0 0.5rem;
  }
  .section-lede {
    color: var(--muted);
    max-width: 60ch;
    margin: 0 0 2rem;
    font-size: 1.05rem;
  }

  /* ---- Promises ---- */
  .promise-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1rem;
  }
  .promise {
    background: var(--surface);
    border-radius: var(--radius-md);
    padding: 1.25rem;
    box-shadow: var(--shadow-soft);
  }
  .promise h3 {
    margin: 0 0 0.5rem;
    font-size: 1.1rem;
    color: var(--brand);
  }
  .promise p {
    margin: 0;
    color: var(--text);
    line-height: 1.5;
  }
  .promise a {
    color: var(--brand);
    text-decoration: underline;
  }

  /* ---- Two ways ---- */
  .ways-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1rem;
  }
  .way {
    background: var(--surface);
    border-radius: var(--radius-md);
    padding: 1.5rem;
    box-shadow: var(--shadow-soft);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .way.featured {
    border: 1px solid var(--brand);
  }
  .way-tag {
    align-self: flex-start;
    background: color-mix(in oklab, var(--brand) 12%, transparent);
    color: var(--brand);
    font-size: 0.8rem;
    font-weight: 600;
    padding: 0.2rem 0.6rem;
    border-radius: 999px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .way h3 {
    margin: 0;
    font-size: 1.25rem;
  }
  .way p {
    margin: 0;
    color: var(--muted);
    line-height: 1.5;
  }
  .way-cta {
    align-self: flex-start;
    margin-top: 0.5rem;
  }

  /* ---- Bottom CTA ---- */
  .bottom-cta {
    text-align: center;
  }
  .bottom-cta p {
    color: var(--muted);
    max-width: 50ch;
    margin: 0 auto 1.5rem;
  }
  .bottom-buttons {
    display: flex;
    justify-content: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  /* ---- Footer ---- */
  .footer {
    padding: 2rem 0 0;
    color: var(--muted);
    font-size: 0.9rem;
    text-align: center;
  }
  .footer a {
    color: var(--brand);
    text-decoration: underline;
  }

  /* ---- Responsive ---- */
  @media (min-width: 720px) {
    .promise-grid { grid-template-columns: 1fr 1fr; }
    .ways-grid { grid-template-columns: 1fr 1fr; }
  }
  @media (max-width: 540px) {
    .topbar { padding-bottom: 0.5rem; }
    .top-actions { width: 100%; justify-content: flex-end; }
    .chart-overlay { padding: 1rem; }
  }
</style>
