<!--
  Info tab — Frequently Asked Questions.

  Native <details>/<summary> accordions, no JS. Add or edit a question by
  copying an <details class="faq-item"> block. The "amount in system" answer
  is sourced from the model in src/lib/utils/pharmacokinetics.ts — keep the
  two in sync if the PK parameters change.
-->
<main class="content">
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
          EvolvTrack is a personal tracker for injectable medications. It logs
          your injections, estimates how much medication is still circulating
          in your body, and charts those values over time alongside optional
          wellness notes. It also includes calculators for working out doses
          and syringe volumes.
        </p>
      </div>
    </details>

    <details class="faq-item">
      <summary><span class="faq-chevron" aria-hidden="true">▸</span>Does my data stay private?</summary>
      <div class="faq-answer">
        <p>
          Yes. Everything you enter is stored locally on your device first. If
          you choose to enable sync, your data is end-to-end encrypted before
          it ever leaves the device — see the <a href="#faq-sync">Sync &amp;
          Privacy</a> section for details.
        </p>
      </div>
    </details>

    <details class="faq-item">
      <summary><span class="faq-chevron" aria-hidden="true">▸</span>Do I need an account to use it?</summary>
      <div class="faq-answer">
        <p>
          No. EvolvTrack works fully offline with no account — your data lives
          in this browser. An account is only needed if you want to sync across
          multiple devices.
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
            <strong>Dosage calculator</strong> — given a vial concentration and
            an intended dose, tells you how many syringe units to draw.
          </li>
          <li>
            <strong>Reverse dose calculator</strong> — given a number of units
            drawn, tells you the dose in milligrams.
          </li>
          <li>
            <strong>Vial transition calculator</strong> — helps you adjust when
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
          the same dose needs a different number of units from the new vial. The
          transition calculator works out the new figure for you.
        </p>
      </div>
    </details>

    <details class="faq-item">
      <summary><span class="faq-chevron" aria-hidden="true">▸</span>Why are syringe volumes shown in U-100 units?</summary>
      <div class="faq-answer">
        <p>
          U-100 insulin syringes are the most common tool for these injections.
          On a U-100 scale, 100 units = 1 mL, so the calculators convert your
          dose to units to match the markings on the syringe.
        </p>
      </div>
    </details>
  </section>

  <section id="faq-charts" class="faq-section">
    <h2 class="faq-section-title">Charts &amp; Tracking</h2>

    <details class="faq-item">
      <summary><span class="faq-chevron" aria-hidden="true">▸</span>How is &ldquo;amount in system&rdquo; calculated?</summary>
      <div class="faq-answer">
        <p>
          EvolvTrack estimates how much of each medication is still in your body
          using a pharmacokinetic (PK) model — the same kind of math used in
          clinical drug research.
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
          The three long-acting weekly drugs — semaglutide, tirzepatide and
          dulaglutide — are characterized in the published literature by
          <strong>two-compartment</strong> models, and EvolvTrack uses those
          published models directly (Overgaard et&nbsp;al. 2019; Schneck
          et&nbsp;al. 2024; Geiser et&nbsp;al. 2015).
        </p>
        <p>
          A two-compartment model splits the body into a <em>central</em>
          compartment — the bloodstream and fast-equilibrating tissue — and a
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
          you have logged no weigh-ins — or for a dose taken before your first
          weigh-in — the model falls back to the study's reference weight, which
          gives the population-average curve. Liraglutide and retatrutide are
          not weight-adjusted.
        </p>

        <h3 class="faq-subhead">Per-drug parameters</h3>
        <p>EvolvTrack ships published parameters for five GLP-1 / GIP medications:</p>
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
            for only three of the drugs.</strong> For semaglutide, tirzepatide
            and dulaglutide, k<sub>a</sub> comes from published population-PK
            studies. For liraglutide and retatrutide no compatible published
            k<sub>a</sub> exists, so EvolvTrack solves it numerically from the
            label's reported time-to-peak (T<sub>max</sub>) using
            T<sub>max</sub> = ln(k<sub>a</sub>/k<sub>e</sub>) &divide;
            (k<sub>a</sub> &minus; k<sub>e</sub>). That is a reasonable
            approximation, but a derived figure rather than an observed one.
          </li>
          <li>
            <strong>One model is still simplified.</strong> Liraglutide's
            published model uses zero-order absorption with a lag time;
            EvolvTrack approximates it with the standard one-compartment Bateman
            curve. The three drugs with published two-compartment models —
            semaglutide, tirzepatide and dulaglutide — are modeled in full (see
            above).
          </li>
          <li>
            <strong>Timing is rounded to whole days.</strong> EvolvTrack treats
            every injection as happening at midnight on its date and reads the
            system amount at midnight on the target date. Sub-day timing is not
            modeled.
          </li>
          <li>
            <strong>Unknown medications are skipped.</strong> If you log a drug
            EvolvTrack has no parameters for, it contributes nothing to the
            total rather than being guessed at.
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

        <p class="faq-note">
          Treat the &ldquo;amount in system&rdquo; figure as a well-grounded
          estimate for spotting trends and comparing days — not as a clinical
          measurement. It is not medical advice; dosing decisions belong with
          your prescriber.
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
          A <strong>planned</strong> dose is one you intend to take but have not
          confirmed yet — it appears on the chart as a projection. A
          <strong>skipped</strong> dose is one you marked as not taken; a skipped
          day is excluded from the chart so it does not distort your trend line.
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
          Sync is end-to-end encrypted. Your data is encrypted on your device
          with a key derived from your passphrase before it is uploaded, so the
          server only ever stores ciphertext and cannot read your records. The
          EvolvTrack source code is public so this can be independently audited.
        </p>
      </div>
    </details>

    <details class="faq-item">
      <summary><span class="faq-chevron" aria-hidden="true">▸</span>What happens if I forget my passphrase?</summary>
      <div class="faq-answer">
        <p>
          Because encryption happens on your device, your passphrase is the only
          thing that can decrypt synced data — it is never sent to the server.
          If you lose it, that data cannot be recovered. Keep a copy somewhere
          safe, such as a password manager.
        </p>
      </div>
    </details>

    <details class="faq-item">
      <summary><span class="faq-chevron" aria-hidden="true">▸</span>What does a license unlock?</summary>
      <div class="faq-answer">
        <p>
          Core tracking and the calculators are available without a license.
          A license unlocks multi-device sync. See the Settings tab for license
          details.
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
          The system-amount chart can only plot medications it has
          pharmacokinetic parameters for (currently the five listed above). A
          drug outside that set is still logged, but it is left off the
          system-amount line because there is no model to estimate it.
        </p>
      </div>
    </details>

    <details class="faq-item">
      <summary><span class="faq-chevron" aria-hidden="true">▸</span>My data isn't appearing on another device.</summary>
      <div class="faq-answer">
        <p>
          Check that sync is enabled and signed in on both devices, that both
          use the same passphrase, and that each device has been online since
          the change was made. If a device still looks out of date, open it and
          let it finish syncing before editing.
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
    scroll-margin-top: 1rem;
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
    max-width: 72ch;
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

  .faq-formula {
    font-family: 'Courier New', monospace;
    font-size: 1rem;
    background: color-mix(in oklab, var(--surface) 55%, transparent);
    border: 2px solid color-mix(in oklab, var(--cardBorder) 28%, #e0e0e0 72%);
    border-radius: 10px;
    padding: 0.6rem 0.8rem;
  }

  .faq-table-wrap {
    overflow-x: auto;
    margin-bottom: 0.65rem;
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
