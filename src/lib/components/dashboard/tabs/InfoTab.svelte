<!--
  Info tab — Frequently Asked Questions.

  Native <details>/<summary> accordions, no JS. Add or edit a question by
  copying an <details class="faq-item"> block. The "amount in system" answer
  is sourced from the model in src/lib/utils/pharmacokinetics.ts — keep the
  two in sync if the PK parameters change.

  Same-page links (href="#faq-...") are intercepted so they expand the target
  <details> question and scroll to it — native anchors scroll but won't open a
  collapsed accordion. See revealTarget below.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { canInstall, promptInstall } from '$lib/stores/pwaInstallStore';

  // Reveal the element a same-page link points at: expand its <details> (when
  // the target is, or sits inside, a collapsed question) and scroll it in.
  // Targets may be a <details> question or a <section> heading.
  function revealTarget(hash: string) {
    if (!hash.startsWith('#')) return;
    const el = document.getElementById(hash.slice(1));
    if (!el) return;
    const details = el.closest('details');
    if (details) details.open = true;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  let root: HTMLElement;

  function handleClick(event: MouseEvent) {
    const link = (event.target as HTMLElement | null)?.closest('a[href^="#"]');
    if (!link) return;
    // Take over from the browser/router so we can open the accordion too.
    event.preventDefault();
    revealTarget(link.getAttribute('href') ?? '');
  }

  onMount(() => {
    // Delegate clicks here (rather than an inline onclick on a non-interactive
    // <main>) so the real interactive targets stay the anchors themselves.
    root.addEventListener('click', handleClick);
    // Honor a fragment present on load (e.g. a deep link into a question).
    if (location.hash) revealTarget(location.hash);
    return () => root.removeEventListener('click', handleClick);
  });
</script>

<main class="content" bind:this={root}>
  <header class="faq-header">
    <h1 class="faq-title">Frequently Asked Questions</h1>
    <p class="faq-intro">
      Short answers to common questions about how EvolvTrack works. Jump to a
      topic below, or open any question to read more.
    </p>
    <nav class="faq-nav" aria-label="FAQ topics">
      <a href="#faq-getting-started">Getting Started</a>
      <a href="#faq-calculators">Dosing &amp; Calculators</a>
      <a href="#faq-charts">Charts &amp; Tracking</a>
      <a href="#faq-sync">Sync &amp; Privacy</a>
      <a href="#faq-troubleshooting">Troubleshooting</a>
    </nav>
  </header>

  <section id="faq-getting-started" class="faq-section">
    <h2 class="faq-section-title">Getting Started</h2>

    <details class="faq-item">
      <summary><span class="faq-chevron" aria-hidden="true">▸</span>What is EvolvTrack?</summary>
      <div class="faq-answer">
        <p>
          EvolvTrack is a personal tracker for losing weight while on injectable
          GLP-1 and GIP medications. With it you can:
        </p>
        <ul>
          <li>Log your injections and track them over time</li>
          <li>Get an estimate of how much medication is currently in your body</li>
          <li>Log your weight and symptoms to see how your medication level impacts how you feel</li>
          <li>Compare your weight loss to your dose week over week</li>
          <li>Keep tabs on your medication stock</li>
        </ul>
        <p>
          We know there are a lot of apps that do similar things, but EvolvTrack
          is private. We understand that this data is sensitive and personal, so
          we built it from the ground up with one principle in mind: you should
          always have control over your data. And since it is a PWA, you can
          install it on any platform (<a href="#faq-install">How to install?</a>).
        </p>
      </div>
    </details>

    <details class="faq-item">
      <summary><span class="faq-chevron" aria-hidden="true">▸</span>What is E2EE or end-to-end encryption?</summary>
      <div class="faq-answer">
        <p>
          This is a feature we recommend all EvolvTrack users turn on (though
          you don't have to). It keeps your data secure and private. Your data is encrypted before it leaves your
          device so anyone with access to our servers cannot read your data
          (that includes us!). This also means we can't help you recover it if
          you lose your passphrase and recovery code.(These are different from your login password which can be reset if you use your email to sign up.)
        </p>
        <p>
          At first login you will be prompted to set it up by the Setup Wizard,
          but you can always enable or disable it later in settings. See the
          <a href="#faq-sync">Sync &amp; Privacy</a> section for details.
        </p>
      </div>
    </details>

    <details class="faq-item">
      <summary><span class="faq-chevron" aria-hidden="true">▸</span>Do I need an account to use it?</summary>
      <div class="faq-answer">
        <p>
          Nope! EvolvTrack works fully offline, just install the app on your
          device. You can read about how to do that
          <a href="#faq-install">here</a>.
        </p>
        <p>
          If you want to sync your data across multiple devices, you will need
          an account. But we don't require an email to sign up. You can either:
        </p>
        <ul>
          <li>Create a username and password</li>
          <li>Use your email and sign in with your password or via magic link (passwordless sign-on)</li>
        </ul>
      </div>
    </details>

    <details class="faq-item" id="faq-install">
      <summary><span class="faq-chevron" aria-hidden="true">▸</span>How do I install EvolvTrack?</summary>
      <div class="faq-answer">
        <p>
          EvolvTrack is a Progressive Web App (PWA), so you install it straight
          from your browser, there's no app store, and no separate download.
          Once installed it opens in its own window, works offline, and behaves
          like any other app on your device. The exact steps depend on your
          device and browser:
        </p>

        {#if $canInstall}
          <p class="install-cta">
            <button type="button" class="btn btn-primary" onclick={() => promptInstall()}>
              Install EvolvTrack
            </button>
            <span class="install-cta-note">Your browser can install it directly, in one tap.</span>
          </p>
        {/if}

        <h3 class="faq-subhead">iPhone &amp; iPad</h3>
        <p>
          Open EvolvTrack in <strong>Safari</strong> (this only works in Safari,
          not Chrome or Firefox on iOS). Tap the <strong>Share</strong> button
          (the square with an upward arrow), scroll down, and tap
          <strong>Add to Home Screen</strong>, then <strong>Add</strong>. The
          EvolvTrack icon will appear on your home screen.
        </p>

        <h3 class="faq-subhead">Android</h3>
        <p>
          Open EvolvTrack in <strong>Chrome</strong> (or another Chromium
          browser like Edge or Samsung Internet). Tap the <strong>⋮</strong>
          menu in the top-right corner and choose <strong>Install app</strong>
          or <strong>Add to Home screen</strong>. You may also see an
          &ldquo;Install&rdquo; prompt appear at the bottom of the screen that
          you can tap directly.
        </p>

        <h3 class="faq-subhead">Windows, Mac &amp; Linux (Chrome or Edge)</h3>
        <p>
          Look for the <strong>install icon</strong> at the right-hand end of
          the address bar, a small screen with a downward arrow. Click it and
          confirm <strong>Install</strong>. If you don't see it, open the
          <strong>⋮</strong> (Chrome) or <strong>…</strong> (Edge) menu and
          choose <strong>Install EvolvTrack…</strong>
        </p>

        <h3 class="faq-subhead">Mac (Safari)</h3>
        <p>
          On macOS Sonoma or later, open EvolvTrack in Safari, then choose
          <strong>File → Add to Dock</strong>. It will run as its own app from
          the Dock.
        </p>

        <h3 class="faq-subhead">Don't see an install option?</h3>
        <p>
          Some browsers — Firefox on the desktop, for example — don't support
          installing PWAs. EvolvTrack still works fully in the browser tab; to
          install it, switch to Chrome, Edge, or Safari. You also only need to
          install once per device, and you can install on as many devices as
          you like.
        </p>
      </div>
    </details>
  </section>

  <section id="faq-calculators" class="faq-section">
    <h2 class="faq-section-title">Dosing &amp; Calculators</h2>

    <details class="faq-item">
      <summary><span class="faq-chevron" aria-hidden="true">▸</span>What do the calculators do?</summary>
      <div class="faq-answer">
        <p>The Calculators tab has three tools:</p>
        <ul>
          <li>
            <strong>Dosage calculator</strong> - given a vial concentration and
            an intended dose, tells you how many syringe units to draw.
          </li>
          <li>
            <strong>Reverse dose calculator</strong> - given a number of units
            drawn, tells you the dose in milligrams.
          </li>
          <li>
            <strong>Vial transition calculator</strong> - helps you adjust when
            you switch to a vial of a different concentration.
          </li>
        </ul>
      </div>
    </details>

    <details class="faq-item">
      <summary><span class="faq-chevron" aria-hidden="true">▸</span>What is a &ldquo;vial transition&rdquo;?</summary>
      <div class="faq-answer">
        <p>
          A vial transition is when you move from one vial to another that has a
          different concentration. Because units drawn depend on concentration,
          the same dose needs a different number of units from the new vial.
        </p>
      </div>
    </details>

    <details class="faq-item">
      <summary><span class="faq-chevron" aria-hidden="true">▸</span>Why are syringe volumes shown in U-100 units?</summary>
      <div class="faq-answer">
        <p>
          U-100 insulin syringes are the most common tool for these injections.
          On a U-100 scale, 100 units = 1 mL, so the calculators convert your
          dose to units to match the markings on the syringe. If your syringe uses a different scale, you will need to convert the result from the calculators.
        </p>
      </div>
    </details>

    <details class="faq-item" id="faq-vials">
      <summary><span class="faq-chevron" aria-hidden="true">▸</span>How does EvolvTrack track what&rsquo;s left in each vial?</summary>
      <div class="faq-answer">
        <p>
          In the <strong>Medications</strong> tab, the amount left in each vial is
          <strong>calculated for you</strong>, you don&rsquo;t keep a running
          count by hand. Tap the <strong>Doses Left</strong> column heading to
          switch it between <strong>Doses Left</strong> and <strong>mg Left</strong>.
        </p>

        <h3 class="faq-subhead">What&rsquo;s calculated for you</h3>
        <p>Each vial starts from its labeled size, taken from three columns you enter:</p>
        <ul>
          <li><strong>Concentration (mg/mL) &times; mL in Vial = total mg</strong> the vial holds.</li>
          <li><strong>total mg &divide; Prescribed Dose = the number of doses</strong> in the vial.</li>
        </ul>
        <p>
          From there, every dose you log is subtracted automatically, so the
          remaining figure always reflects your real history. Only doses you
          actually took count, <strong>planned</strong> (not-yet-taken) and
          <strong>skipped</strong> doses don&rsquo;t draw anything down.
        </p>

        <h3 class="faq-subhead">Which vial a dose comes from</h3>
        <p>
          Doses come out of the <strong>vial highest on the table</strong> first
          (for that medication), not by date. When a dose is larger than
          what&rsquo;s left in that vial, the remainder is taken from the next one
          down, the same split the
          <a href="#faq-calculators">vial transition calculator</a> helps you draw.
          So a vial only starts being used once the one above it is empty. To change
          which vial is drawn from first, <strong>reorder the rows</strong>, drag the
          vial you want used next to the top.
        </p>

        <h3 class="faq-subhead">Overfill</h3>
        <p>
          The count is based on the <strong>labeled</strong> fill (the mL you
          entered). Compounded vials are often slightly overfilled, so you may get
          an extra partial, or even full, dose beyond what the label
          says. When that happens the vial shows <strong>0 left</strong> with an
          <strong>&ldquo;over&rdquo;</strong> marker rather than pretending it holds
          more. We don&rsquo;t guess at overfill; the numbers you can rely on are
          the ones from the label.
        </p>

        <h3 class="faq-subhead">What you can override</h3>
        <p>
          The remaining amount can be manually overriden: type a number
          into a vial&rsquo;s <strong>Doses Left / mg Left</strong> cell to set it
          directly. That&rsquo;s useful if you used part of a vial before you started
          logging, or want to fix an estimate. Your correction sticks, and doses you
          log afterward keep counting down from it. Clear the cell to return to the
          automatic calculation; and note that editing a vial&rsquo;s
          concentration, mL, or prescribed dose also resets the override, since
          those change what the vial is and the figure recalculates from scratch.
        </p>
        <p>
          Everything else(a vial&rsquo;s capacity, how many doses it holds,
          and which vial is currently active) follows from the columns above
          and your logged doses, so it stays correct without any manual upkeep.
        </p>
      </div>
    </details>
  </section>

  <section id="faq-charts" class="faq-section">
    <h2 class="faq-section-title">Charts &amp; Tracking</h2>

    <details class="faq-item" id="faq-amount-calc">
      <summary><span class="faq-chevron" aria-hidden="true">▸</span>How is &ldquo;amount in system&rdquo; calculated?</summary>
      <div class="faq-answer">
        <h2 class="faq-subhead">TLDR</h2>
        <p>
          With every injection, the drug seeps in from the injection site,
          spreads through your body, and your body slowly clears it out.
        </p>
        <p>
          We use one of two models, depending on the drug.
        </p>

        <h3 class="faq-subhead">One-compartment model</h3>
        <p>
          Treats your body as a single bucket. The drug flows in, then drains
          out at a steady rate.
        </p>

        <h3 class="faq-subhead">Two-compartment model</h3>
        <p>
          Treats your body as two connected buckets: your bloodstream (fast) and
          your deeper tissues (slow). The drug exchanges back and forth between
          them while also draining out. EvolvTrack plots the amount estimated to be
          in the bloodstream, which is the part that actually drives how the drug
          makes you feel. This is the more accurate of the two, and it's lifted
          straight from published medical studies.
        </p>

        <h3 class="faq-subhead">Which drug uses which</h3>
        <p>Two-compartment (more accurate, accounts for your weight):</p>
        <ul>
          <li>Semaglutide (Ozempic / Wegovy)</li>
          <li>Tirzepatide (Mounjaro / Zepbound)</li>
          <li>Dulaglutide (Trulicity)</li>
        </ul>
        <p>One-compartment (simpler curve, not weight-adjusted):</p>
        <ul>
          <li>
            Liraglutide (Victoza / Saxenda)
            <ul><li>taken daily, so it rises and falls in a single day.</li></ul>
          </li>
          <li>
            Retatrutide
            <ul><li>we don't have the data yet</li></ul>
          </li>
        </ul>
        <p>If new data becomes available, we will update the models we use.</p>

        <p class="faq-note">
          Treat the &ldquo;amount in system&rdquo; figure as a well-grounded
          estimate for spotting trends and comparing days, not as a clinical
          measurement. It is not medical advice; dosing decisions belong with
          your prescriber.
        </p>


        <h2 class="faq-subhead">The Long Version</h2>
        <p>
          EvolvTrack estimates how much of each medication is still in your body
          using a pharmacokinetic (PK) model — the same kind of math used in
          clinical drug research. Depending on the medication, we use a combination of dose, bioavailability, absorption rate, eliminiation rate, and half life. A much more detailed explaination is below, but note:
        </p>

        <h3 class="faq-subhead">The model</h3>
        <p>
          EvolvTrack uses one of two model shapes per drug. The simpler is the
          <strong>Bateman equation</strong> — a one-compartment model with
          first-order absorption and first-order elimination, used for
          liraglutide and retatrutide. For a single dose it gives the milligrams
          remaining at time <em>t</em> (hours after injection):
        </p>
        <p class="faq-formula">
          A(t) = (F &middot; D &middot; k<sub>a</sub>) &divide; (k<sub>a</sub> &minus; k<sub>e</sub>)
          &times; (e<sup>&minus;k<sub>e</sub>t</sup> &minus; e<sup>&minus;k<sub>a</sub>t</sup>)
        </p>
        <ul>
          <li><strong>F</strong> — bioavailability: the fraction of the injected dose that actually reaches your bloodstream.</li>
          <li><strong>D</strong> — the dose injected, in milligrams.</li>
          <li><strong>k<sub>a</sub></strong> — absorption rate constant: how fast the drug moves from the injection site into your blood.</li>
          <li><strong>k<sub>e</sub></strong> — elimination rate constant: how fast your body clears it, calculated as ln(2) &divide; half-life.</li>
          <li><strong>t</strong> — hours since the injection.</li>
        </ul>
        <p>
          Every logged injection is evaluated independently and the results are
          summed per drug, so overlapping doses stack the way they do in real
          life.
        </p>

        <h3 class="faq-subhead">Semaglutide, tirzepatide &amp; dulaglutide: a two-compartment model</h3>
        <p>
          The three long-acting weekly drugs(semaglutide, tirzepatide, and
          dulaglutide) are characterized in the published literature by
          <strong>two-compartment</strong> models, and EvolvTrack uses those
          published models directly (Overgaard et&nbsp;al. 2019; Schneck
          et&nbsp;al. 2024; Geiser et&nbsp;al. 2015).
        </p>
        <p>
          A two-compartment model splits the body into a <em>central</em>
          compartment, the bloodstream and fast-equilibrating tissue, and a
          <em>peripheral</em> compartment of slower tissue. After absorption,
          drug shuttles back and forth between the two and is cleared from the
          central one. The figure EvolvTrack plots for these drugs is the
          <strong>central-compartment</strong> amount, which tracks the blood
          level that drives the drug's effect.
        </p>
        <p>
          The single-dose central amount works out to a sum of three exponential
          terms rather than two:
        </p>
        <p class="faq-formula">
          A(t) = F &middot; D &middot; k<sub>a</sub> &times;
          (c<sub>1</sub>e<sup>&minus;k<sub>a</sub>t</sup>
          + c<sub>2</sub>e<sup>&minus;&alpha;t</sup>
          + c<sub>3</sub>e<sup>&minus;&beta;t</sup>)
        </p>
        <p>
          Here <strong>&alpha;</strong> and <strong>&beta;</strong> are the fast
          (distribution) and slow (terminal) rate constants, and c<sub>1</sub>,
          c<sub>2</sub> and c<sub>3</sub> are fixed weights derived from the
          model's rate constants. The payoff: the estimated peak (roughly one
          day after a tirzepatide dose, two to three days for semaglutide and
          dulaglutide) and the early post-peak dip are far more accurate than a
          one-compartment curve can manage, which makes it easier to line up
          symptoms and wellness with drug levels.
        </p>

        <h3 class="faq-subhead">Personalized to your weight</h3>
        <p>
          The population studies behind these models all found
          <strong>body weight</strong> to be the main driver of
          person-to-person differences. If you log weigh-ins, EvolvTrack uses
          them: each dose of semaglutide, tirzepatide or dulaglutide is
          individualized with that drug's published body-weight relationship,
          using the most recent weigh-in on or before the day the dose was
          taken.
        </p>
        <p>
          For semaglutide and tirzepatide, body weight scales clearance and the
          volume of distribution; for dulaglutide it scales bioavailability. If
          you have logged no weigh-ins, or for a dose taken before your first
          weigh-in, the model falls back to the study's reference weight, which
          gives the population-average curve. Liraglutide and retatrutide are
          not weight-adjusted.
        </p>

        <h3 class="faq-subhead">Per-drug parameters</h3>
        <p>EvolvTrack ships published parameters for five GLP-1 / GIP medications:</p>
        <div class="faq-table-frame">
        <div class="faq-table-wrap">
          <table class="faq-table">
            <thead>
              <tr><th>Medication</th><th>Model</th><th>Terminal half-life</th><th>Bioavailability</th></tr>
            </thead>
            <tbody>
              <tr><td>Semaglutide (Ozempic / Wegovy)</td><td>Two-compartment</td><td>~1 week</td><td>85%</td></tr>
              <tr><td>Tirzepatide (Mounjaro / Zepbound)</td><td>Two-compartment</td><td>~5 days</td><td>80%</td></tr>
              <tr><td>Dulaglutide (Trulicity)</td><td>Two-compartment</td><td>~5 days</td><td>47%</td></tr>
              <tr><td>Liraglutide (Victoza / Saxenda)</td><td>One-compartment</td><td>~13 h</td><td>55%</td></tr>
              <tr><td>Retatrutide</td><td>One-compartment</td><td>~6 days</td><td>80%</td></tr>
            </tbody>
          </table>
        </div>
        </div>

        <h3 class="faq-subhead">Which values are estimates, and why</h3>
        <p>
          <strong>All of these numbers are population averages — estimates, not
          measurements of you specifically.</strong> That matters in a few
          concrete ways:
        </p>
        <ol>
          <li>
            <strong>The parameters are population means.</strong> Half-lives,
            bioavailability and absorption rates are averages. Body weight is
            the one source of variation EvolvTrack can correct for (see
            &ldquo;Personalized to your weight&rdquo; above); kidney function,
            injection site, and anti-drug antibodies still vary from person to
            person, so your real curve could be higher or lower.
          </li>
          <li>
            <strong>The absorption constant (k<sub>a</sub>) is directly measured
            for only three of the drugs.</strong> For semaglutide, tirzepatide,
            and dulaglutide, k<sub>a</sub> comes from published population-PK
            studies. For liraglutide and retatrutide, EvolvTrack instead solves
            k<sub>a</sub> numerically from the
            label's reported time-to-peak (T<sub>max</sub>) using
            T<sub>max</sub> = ln(k<sub>a</sub>/k<sub>e</sub>) &divide;
            (k<sub>a</sub> &minus; k<sub>e</sub>). That is a reasonable
            approximation, but a derived figure rather than an observed one.
          </li>
          <li>
            <strong>Liraglutide's absorption is simplified.</strong> Liraglutide is
            itself a one-compartment drug, and EvolvTrack matches that structure, 
            but its published models describe absorption in more detail
            (Watson et&nbsp;al. 2010 used sequential zero, then first-order
            absorption). EvolvTrack uses a single first-order absorption rate,
            solved from the label time-to-peak.
          </li>
          <li>
            <strong>Timing is rounded to whole days.</strong> EvolvTrack treats
            every injection as happening at midnight on its date and reads the
            system amount at midnight on the target date. Sub-day timing is not
            modeled.
          </li>
        </ol>

        <h3 class="faq-subhead">Sources</h3>
        <p>The PK parameters are drawn from peer-reviewed literature and drug labels:</p>
        <ul>
          <li><strong>Semaglutide</strong> — Overgaard et al. (PMC6437231); PMC11215664; PMID 29915923</li>
          <li><strong>Tirzepatide</strong> — Schneck et al. 2024 (PMC10962491); StatPearls NBK585056</li>
          <li><strong>Dulaglutide</strong> — Geiser et al. 2015 (PMID 26507721); PMC12052016</li>
          <li><strong>Liraglutide</strong> — PMC4875959; StatPearls NBK608007</li>
          <li><strong>Retatrutide</strong> — NEJM (NEJMoa2301972); PMC12190491</li>
        </ul>
      </div>
    </details>

    <details class="faq-item">
      <summary><span class="faq-chevron" aria-hidden="true">▸</span>Why is the amount in system so low?</summary>
      <div class="faq-answer">
        <p>
          It's a common surprise: you inject, say, 11&nbsp;mg of tirzepatide and
          the chart peaks around a quarter of that. That's expected, not a bug. 
        </p>
        <p>
          For semaglutide, tirzepatide, and dulaglutide, the chart <strong>estimates how much drug is in your blood plasma</strong>, not the total amount in your body. Some of the dose is still being absorbed from the injection site, some has moved into your tissues, and not all of it is absorbed in the first place. For a detailed explanation see <a href="#faq-amount-calc">How is &ldquo;amount in system&rdquo; calculated?</a>
        </p>
        <p>
This number is best used as a trend line: a way to compare your levels day to day within the same medication, and see how they line up with how you feel. It is not a literal count of how many milligrams are in your body, and it is not a good way to compare one medication against another.
        </p>
        <p>
          For a deeper understanding of the calculation, see
          <a href="#faq-amount-calc">How is &ldquo;amount in system&rdquo;
          calculated?</a>
        </p>
      </div>
    </details>

    <details class="faq-item">
      <summary><span class="faq-chevron" aria-hidden="true">▸</span>Why is liraglutide less accurate than the other drugs?</summary>
      <div class="faq-answer">
        <p>
          Liraglutide is usually taken once a day, and its levels rise and fall within that same day. It peaks about 10 hours after injection, then drops again.
        </p>
        <p>
          EvolvTrack keeps logging simple by recording doses by date, not exact time, and reading the chart once per day at midnight. That works well for weekly medications, where the curve changes slowly and the exact hour barely matters.
        </p>
        <p>
          For liraglutide, though, timing matters more. Because the chart does not track the daily peak, the line may sit lower than your actual plasma level.
        </p>
        <p>
          So liraglutide’s line is best treated as a rough day-to-day trend, not an exact plasma-level estimate.
        </p>
      </div>
    </details>

    <details class="faq-item">
      <summary><span class="faq-chevron" aria-hidden="true">▸</span>Why does a dose I logged today show 0&nbsp;mg?</summary>
      <div class="faq-answer">
        <p>
          The system amount for a given day represents what was already
          circulating <em>before</em> that day's injection. A dose logged today
          is treated as happening at the start of the day, so it contributes 0
          to today's figure and begins building up from tomorrow onward. This
          keeps each day's number comparable.
        </p>
      </div>
    </details>

    <details class="faq-item">
      <summary><span class="faq-chevron" aria-hidden="true">▸</span>What do &ldquo;planned&rdquo; and &ldquo;skipped&rdquo; doses mean?</summary>
      <div class="faq-answer">
        <p>
          A <em>planned</em> dose has a date that is in the future, it appears on the chart as a projection. A <em>skipped</em> dose is one you marked as not taken; a <em>skipped</em>
          day is excluded from the chart so it does not distort your trend line. None of the data for a <em>skipped</em> dose is used for the chart, but it will remain in the table for reference until you delete it. 
        </p>
      </div>
    </details>
  </section>

  <section id="faq-sync" class="faq-section">
    <h2 class="faq-section-title">Sync &amp; Privacy</h2>

    <details class="faq-item">
      <summary><span class="faq-chevron" aria-hidden="true">▸</span>How does sync keep my data private?</summary>
      <div class="faq-answer">
        <p>
          Sync is only private if you have end-to-end encryption (E2EE) turned
          on. We strongly recommend enabling it.
        </p>
        <ul>
          <li>
            <strong>With E2EE on:</strong> Your data is encrypted on your device
            before it is sent to our servres, so the server only stores encrypted data.
            Nobody — not even us — can read your records. The EvolvTrack source
            code is <a href="https://github.com/glengerbush/EvolvTrack" target="_blank" rel="noopener">public</a> so this can be independently audited.
          </li>
          <li>
            <strong>With E2EE off:</strong> Just turn it on...otherwise your data can be read by those with access to our server, which is <em>hopefully</em> just us. It does mean we can recover your data for you if you lose your password, but if you aren't using a password manager, it's probably time to start.
          </li>
        </ul>
        <p>
          You can turn E2EE on or off at any time from the Settings tab.
        </p>
      </div>
    </details>

    <details class="faq-item">
      <summary><span class="faq-chevron" aria-hidden="true">▸</span>What happens if I forget my passphrase?</summary>
      <div class="faq-answer">
        <p>
          You only have a passphrase if you enabled E2EE. It is separate from your login password. 
          With E2EE on,your passphrase and your recovery code are the only two ways to unlock your
          encrypted data, neither is ever sent to the server. You can use the
          recovery code from the unlock screen to set a new passphrase if you
          forget the old one.
        </p>
        <p>
          <strong>If you lose both your passphrase and your recovery code, your
          encrypted data is unrecoverable.</strong> No one(including us!) can decrypt
          it.
        </p>
      </div>
    </details>

    <details class="faq-item">
      <summary><span class="faq-chevron" aria-hidden="true">▸</span>How does the recovery code work?</summary>
      <div class="faq-answer">
        <p>
          When you enable E2EE we generate a single recovery code
          and show it to you once. Save it somewhere safe, we can't show it to
          you again.
        </p>
        <p>
          If you forget your passphrase, paste the recovery code into the unlock
          screen and choose a new passphrase. Two important things happen
          automatically:
        </p>
        <ul>
          <li>The old recovery code stops working, a fresh one is issued.</li>
          <li>A new encryption key is generated and your data is re-encrypted
          under it. If the old code or key was exposed somehow, that exposure
          doesn't carry into your future data.</li>
        </ul>
        <p>
          You can also rotate the recovery code or the encryption key at any
          time from Settings, useful if you think a code or device may have
          been seen.
        </p>
      </div>
    </details>

    <details class="faq-item">
      <summary><span class="faq-chevron" aria-hidden="true">▸</span>What does a license do?</summary>
      <div class="faq-answer">
        <p>
          A license allows for multi-device sync. This means your data is backed up and synced on our servers, which can then be synced to any logged in device. Without a license the app can be used offline on one device. See the Settings tab for license details.
        </p>
      </div>
    </details>
  </section>

  <section id="faq-troubleshooting" class="faq-section">
    <h2 class="faq-section-title">Troubleshooting</h2>

    <details class="faq-item">
      <summary><span class="faq-chevron" aria-hidden="true">▸</span>A medication I logged isn't on the chart.</summary>
      <div class="faq-answer">
        <p>
          The "amount in system" only appears the day after a dose, so if there aren't days logged after you logged a dose, you won't see a line for that yet. If you add planned doses to the chart, you will see an estimated "amount in system" starting the day after the dose was taken.
        </p>
      </div>
    </details>

    <details class="faq-item">
      <summary><span class="faq-chevron" aria-hidden="true">▸</span>My data isn't appearing on another device.</summary>
      <div class="faq-answer">
        <p>
          Check that sync is enabled and signed in on both devices, and that
          each device has been online since the change was made. If you have
          end-to-end encryption turned on, both devices must also be unlocked
          with the same passphrase. If a device still looks out of date, open
          it, click the sync status pill in the top bar (next to the
          &ldquo;Log out&rdquo; button), and press &ldquo;Sync now&rdquo; in
          the panel that appears. Wait for the status to change from &ldquo;Syncing&rdquo; to &ldquo;Synced.&rdquo;
        </p>
      </div>
    </details>
  </section>

  <p class="faq-disclaimer">
    EvolvTrack is a personal tracking tool, not a medical device. Nothing here
    is medical advice — always follow your prescriber's guidance.
  </p>
</main>

<style>
  .content {
    width: min(100% - 2rem, 1240px);
    margin-inline: auto;
    padding: 1rem 0 1.25rem;
    display: grid;
    gap: 1rem;
    align-content: start;
  }

  .faq-header {
    display: grid;
    gap: 0.5rem;
  }

  .faq-title {
    margin: 0;
    font-size: 1.9rem;
    font-weight: 800;
    color: var(--headerText);
  }

  .faq-intro {
    margin: 0;
    max-width: 60ch;
    color: var(--muted);
    line-height: 1.5;
  }

  .faq-nav {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-top: 0.25rem;
  }

  .faq-nav a {
    border: 2px solid var(--cardBorder);
    border-radius: 999px;
    padding: 0.28rem 0.7rem;
    font-size: 0.85rem;
    font-weight: 600;
    text-decoration: none;
    color: var(--text);
    background: color-mix(in oklab, var(--surface) 70%, transparent);
  }

  .faq-nav a:hover {
    background: color-mix(in oklab, var(--headerBg) 22%, var(--surface) 78%);
  }

  .faq-section {
    display: grid;
    gap: 0.5rem;
    /* Clear the sticky .tabbar in Dashboard.svelte so the section heading
     * lands below the tab bar instead of underneath it. */
    scroll-margin-top: 3.5rem;
    min-width: 0;
  }

  /* Grid items default to min-width:auto (min-content); without this the wide
   * FAQ parameters table makes .faq-section/.faq-item grow to the table's
   * min-width and push the whole page sideways, instead of the table scrolling
   * inside its own .faq-table-wrap. Same containment rule as the foundation. */
  .faq-section > :global(*),
  .faq-item {
    min-width: 0;
  }

  .faq-section-title {
    margin: 0.5rem 0 0.1rem;
    font-size: 1.15rem;
    font-weight: 700;
    font-variant: small-caps;
    color: var(--headerText);
  }

  .faq-item {
    border: 2px solid var(--cardBorder);
    border-radius: 12px;
    background: color-mix(in oklab, var(--surface) 86%, transparent);
    box-shadow: 0 2px 5px rgba(0, 0, 0, 0.12);
    /* Match .faq-section: clear the sticky .tabbar when a question is the
     * scroll target of a same-page link. */
    scroll-margin-top: 3.5rem;
  }

  .faq-item summary {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    cursor: pointer;
    list-style: none;
    padding: 0.65rem 0.85rem;
    font-weight: 700;
    color: var(--text);
  }

  .faq-item summary::-webkit-details-marker {
    display: none;
  }

  .faq-item summary:focus-visible {
    outline: 2px solid var(--cardBorder);
    outline-offset: 2px;
    border-radius: 10px;
  }

  .faq-chevron {
    color: var(--muted);
    transition: transform 0.15s ease;
  }

  .faq-item[open] .faq-chevron {
    transform: rotate(90deg);
  }

  .faq-answer {
    padding: 0 0.95rem 0.85rem 1.65rem;
    color: var(--text);
    line-height: 1.55;
  }

  .faq-answer :global(p),
  .faq-answer :global(ul),
  .faq-answer :global(ol) {
    margin: 0 0 0.65rem;
  }

  .faq-answer :global(li) {
    margin-bottom: 0.3rem;
  }

  .faq-answer :global(a) {
    color: var(--text);
    text-decoration: underline;
  }

  .faq-subhead {
    margin: 0.9rem 0 0.4rem;
    font-size: 0.95rem;
    font-weight: 700;
    font-variant: small-caps;
    color: var(--headerText);
  }

  h2.faq-subhead {
    font-size: 1.25rem;
  }

  /* Shown only in browsers that support direct PWA install (see
   * pwaInstallStore); elsewhere the per-device instructions below apply. */
  .install-cta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
  }

  .install-cta-note {
    font-size: 0.9rem;
    color: var(--muted);
  }

  .faq-formula {
    font-family: 'Courier New', monospace;
    font-size: 1rem;
    background: color-mix(in oklab, var(--surface) 55%, transparent);
    border: 2px solid color-mix(in oklab, var(--cardBorder) 28%, #e0e0e0 72%);
    border-radius: 10px;
    padding: 0.6rem 0.8rem;
  }

  .faq-table-frame {
    position: relative;
    margin-bottom: 0.65rem;
  }

  .faq-table-wrap {
    overflow-x: auto;
  }

  .faq-table {
    border-collapse: collapse;
    font-size: 0.9rem;
    min-width: 28rem;
  }

  .faq-table th,
  .faq-table td {
    border: 1px solid color-mix(in oklab, var(--cardBorder) 40%, #d4d4d4 60%);
    padding: 0.35rem 0.6rem;
    text-align: left;
  }

  .faq-table th {
    background: color-mix(in oklab, var(--headerBg) 18%, var(--surface) 82%);
    font-weight: 700;
  }

  /* ── Scroll-better treatment for the narrow viewport (≤640px) ──
   * The table can't shrink below ~28rem without becoming unreadable, so instead
   * of wrapping it to cards we let it scroll horizontally but pin the Medication
   * column (the row's identity) so it stays visible while Model / half-life /
   * bioavailability scroll into view, and fade the right edge to hint there's
   * more. On wider screens the table fits, so none of this applies. */
  @media (max-width: 640px) {
    .faq-table th:first-child,
    .faq-table td:first-child {
      position: sticky;
      left: 0;
      /* Opaque so scrolled cells pass behind it; box-shadow redraws the divider
       * that border-collapse drops underneath a sticky cell. */
      background: var(--surface);
      box-shadow: 1px 0 0 color-mix(in oklab, var(--cardBorder) 40%, #d4d4d4 60%);
      z-index: 1;
    }

    .faq-table th:first-child {
      background: color-mix(in oklab, var(--headerBg) 18%, var(--surface) 82%);
      z-index: 2;
    }

    .faq-table-frame::after {
      content: '';
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      width: 1.6rem;
      pointer-events: none;
      background: linear-gradient(
        to right,
        transparent,
        color-mix(in oklab, var(--surface) 86%, transparent)
      );
    }
  }

  .faq-note {
    border-left: 4px solid var(--cardBorder);
    padding: 0.5rem 0.75rem;
    background: color-mix(in oklab, var(--surface) 60%, transparent);
    border-radius: 0 8px 8px 0;
    font-size: 0.92rem;
  }

  .faq-disclaimer {
    margin: 0.5rem 0 0;
    font-size: 0.82rem;
    color: var(--muted);
    text-align: center;
  }
</style>
