<script lang="ts">
  import { goto } from '$app/navigation';
  import { isDemoMode } from '$lib/stores/demoStore';

  async function startDemo() {
    await isDemoMode.enable();
    await goto('/app');
  }
</script>

<section class="hero">
  <div class="container">
    <header class="topbar">
      <h1>✽ EVOLVETRACK</h1>
      <div><a href="#features">Features</a> <a class="btn btn-ghost" href="/auth">Log In</a></div>
    </header>

    <div class="lead">
      <div class="card chart">
        <svg viewBox="0 0 500 260" aria-label="weight trend chart">
          <g stroke="#b5b5b5"><path d="M30 20v220M70 20v220M110 20v220M150 20v220M190 20v220M230 20v220M270 20v220M310 20v220M350 20v220M390 20v220M430 20v220M470 20v220"/><path d="M20 40h460M20 80h460M20 120h460M20 160h460M20 200h460"/></g>
          <path d="M30 35 L65 45 L80 60 L110 70 L130 95 L170 110 L210 145 L230 135 L260 148 L295 165 L305 190 L340 190 L365 204 L400 218 L430 230 L445 256 L475 260" fill="none" stroke="#7ccc47" stroke-width="4"/>
        </svg>
      </div>
      <div class="cta">
        <h2>YOUR PROGRESS SHOULD BELONG TO YOU.</h2>
        <div class="cta-buttons">
          <a class="btn btn-primary" href="/auth">Log In</a>
          <button class="btn btn-demo" onclick={startDemo}>Try Demo</button>
        </div>
      </div>
    </div>

    <article id="features" class="copy">
      <h3>Meet Evolve Track - The App that Puts You in Control</h3>
      <p>Track dose, shot location, medication levels, and trends in one secure place. EVOLVETRACK works offline and encrypts your records end to end.</p>
    </article>
  </div>
</section>

<style>
  .hero { background: var(--surface-soft); min-height: 100dvh; }
  .topbar { display:flex; justify-content:space-between; align-items:center; padding: 1rem 0; }
  .lead { display:grid; gap:1rem; grid-template-columns: 1fr; align-items:center; padding:1rem 0; }
  .chart { padding: 1rem; }
  svg { width: 100%; height: auto; }
  h2 { font-size: clamp(2rem, 7vw, 4rem); max-width: 18ch; }
  .cta-buttons { display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: center; margin-top: 1.5rem; }
  .btn-demo {
    background: transparent;
    border: 2px solid var(--brand);
    color: var(--brand);
    font-weight: 600;
  }
  .btn-demo:hover { background: color-mix(in oklab, var(--brand) 10%, transparent 90%); }
  .copy { padding: 1.5rem 0 3rem; }
  @media (min-width: 900px) {
    .lead { grid-template-columns: 1fr 1fr; }
  }
</style>
