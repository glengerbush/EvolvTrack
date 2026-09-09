---
target: health graph
total_score: 20
max_score: 36
na_heuristics: 9
p0_count: 0
p1_count: 3
timestamp: 2026-09-09T01-43-33Z
slug: components-dashboard-tabs-sharedtabcontent-svelte
---
Method: dual-agent (A: /root/graph_design_review · B: /root/graph_evidence)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|---|---:|---|
| 1 | Visibility of System Status | 3 | Active range and crosshair are clear; planned and forecast states are not. |
| 2 | Match System / Real World | 3 | Dates and weight are familiar; “mg in system” and wellness scaling need explanation. |
| 3 | User Control and Freedom | 3 | Range and series choices are reversible; there is no reset/show-all action. |
| 4 | Consistency and Standards | 2 | Dashed and hollow marks carry several incompatible meanings. |
| 5 | Error Prevention | 2 | Mixed scales and silent dependent toggles invite misinterpretation. |
| 6 | Recognition Rather Than Recall | 2 | Users must infer today, planned, hollow, and forecast meanings. |
| 7 | Flexibility and Efficiency | 2 | Useful presets exist, but graph inspection is pointer-only. |
| 8 | Aesthetic and Minimalist Design | 2 | Strong visual identity; mobile wellness bars and overlays become noisy. |
| 9 | Error Recovery | n/a | This read-only graph has no graph-specific error workflow. |
| 10 | Help and Documentation | 1 | No contextual explanation of scales, forecast logic, or interaction. |
| **Total** |  | **20/36** | **Acceptable; significant improvement needed** |

## Design Specificity Verdict

**LLM assessment:** Strongly product-authored. The graph-paper substrate, ledger-like controls, weight/pharmacokinetic/wellness comparison, and medication color-plus-shape encoding unmistakably belong to EvolvTrack. It is not category-interchangeable. The weakness is semantic integrity: the graph looks more certain than its mixed scales and state grammar justify.

**Deterministic scan:** The CLI detector returned `[]`: zero findings, rules, severities, locations, or false positives. It missed the important problems because they depend on runtime geometry, interaction modality, accessibility-tree completeness, and interpretation rather than static anti-patterns.

**Visual evidence:** Desktop and mobile were inspected in fresh browser tabs. No reliable user-visible overlay is available: Codex Browser’s read-only evaluation surface rejected the required title/script mutation. Fallback evidence used screenshots, DOM/accessibility snapshots, measured geometry/styles, source inspection, and the successful CLI scan.

## Overall Impression

The graph is visually memorable and technically ambitious, but it currently asks users to decode too many concepts at once. Its biggest opportunity is to become a trustworthy health instrument: separate unlike measures, state exactly what is observed/planned/forecast, and make every date inspectable regardless of input method.

## What’s Working

- Medication series pair color with distinct marker shapes, preserving identity under overlap, grayscale, and common color-vision differences.
- Fixed axes remain visible during horizontal scrolling; range changes keep the latest date in view.
- Responsive containment is sound: neither 1440px desktop nor 390px mobile produced page-level horizontal overflow, and the skeuomorphic graph-paper identity survives both.

## Cognitive Load

**High: 5 of 8 checklist items fail.** Five legend series appear together, with more options for multiple medications. Weight, PK, wellness, symptoms, dual axes, dates, and three future-state treatments compete in one plot. Wellness requires remembering an invisible 0–10 scale while the adjacent right axis displays unrelated mg values. The legend editor exposes five or more simultaneous choices; the range control is manageable at exactly four.

## Emotional Journey

Arrival feels warm, tactile, and personal rather than clinical. Crosshair snapping and paired value chips create the strongest moment: exploration feels precise. Confidence drops at the today/future boundary, where dashed and hollow marks do not clearly say recorded, planned, or predicted. The graph ends without a concise takeaway, leaving users to interpret raw signals alone.

## Priority Issues

### 1. [P1] Wellness has no truthful visible scale

**Why it matters:** Wellness bars use an independent 0–10 scale while the right axis shows dynamic medication mg. A bar top visually aligns with an unrelated mg value, making a polished graph capable of communicating the wrong relationship.

**Fix:** Move wellness into a labeled 0–10 lane or aligned small multiple. Keep dates synchronized with the main plot and include wellness plus symptom names in the crosshair summary.

**Suggested command:** `$impeccable layout`

### 2. [P1] Planned and forecast states collapse into the same visual grammar

**Why it matters:** Dashed paths represent planned weight, calculated weight prediction, and projected PK; hollow/dotted planned marks are absent from the legend. Users cannot distinguish entered intent from model output.

**Fix:** Establish one explicit state grammar: observed = solid/filled, planned = dashed/hollow, forecast = dotted or an uncertainty band. Add a compact state key, hide unavailable legend entries, and keep planned values out of prediction inputs where appropriate.

**Suggested command:** `$impeccable clarify`

### 3. [P1] The primary inspection interaction excludes keyboard, screen-reader, and motor-impaired users

**Why it matters:** The scrollable plot has no role or tabindex; date scrubbing is mouse/touch only. The accessibility tree announces 32 wellness images and five doses but omits weight values and full symptom names. Mobile range controls measure 18.9px high, the edit control 32×32px, and checkbox hit areas about 24px high.

**Fix:** Make the plot keyboard-focusable with Left/Right date navigation, visible focus, and a live day summary. Add a complete alternate data table/list; remove noisy nested image roles. Expand touch targets to roughly 44×44px without enlarging their visual marks.

**Suggested command:** `$impeccable audit`

### 4. [P2] Mobile proportions make the graph dense and laborious

**Why it matters:** At 390px, two fixed 50px axes leave only 232px for data while the chart stays 440px tall. The 1W canvas spans 1,061px—4.57 times its viewport—and the wrapped legend consumes about 52px before editing.

**Fix:** Use a mobile-specific chart height/aspect ratio, slimmer axes, weekly tick decimation, and a compact wellness lane or heat strip. Show the visible date window so horizontal position is understandable.

**Suggested command:** `$impeccable adapt`

### 5. [P2] Legend editing communicates the wrong transaction

**Why it matters:** A pencil becomes a floppy-disk icon although changes save immediately, and its accessible label remains “Edit graph legend.” Users receive conflicting signals about whether they must save.

**Fix:** Replace it with a “Series” disclosure or direct toggle chips grouped as Measurements and Medication model. If changes remain live, use a clear “Done” state and expose `aria-expanded`/`aria-pressed` correctly.

**Suggested command:** `$impeccable clarify`

## Persona Red Flags

**Alex (Power User):** Cannot inspect dates by keyboard or quickly isolate a series without opening legend edit mode. There is no reset/show-all accelerator, and Weight silently controls Weight prediction.

**Sam (Accessibility-Dependent):** Cannot operate the crosshair with a keyboard. The screen-reader sequence is flooded by wellness image nodes while omitting central weight data; symptom initials lack names/dates; tiny mobile targets impair motor access.

**Casey (Distracted Mobile User):** Must scrub a long, narrow 440px-tall chart with small controls. After interruption, there is no persistent selected date or plain-language summary to restore context.

## Minor Observations

- “Overview” is vague; “Health trends” better names the graph’s job.
- `M/D` labels become ambiguous across years in All.
- The today line needs a visible “Today” label or key.
- Axis text is about 11.5px and symptom initials about 9.3px on mobile.
- “1W/4W” changes density over scrollable history rather than strictly filtering; show the visible date span.
- Symptom initials are lossy and potentially colliding; reveal full name and date on hover, tap, focus, and in the alternate representation.
- Empty-state copy is clear and action-oriented.

## Questions to Consider

- Is the graph primarily answering “Am I progressing?” or “How do medication kinetics relate to how I feel?”
- Should wellness remain overlaid at all, or become a synchronized lower lane?
- What single semantic promise should dashed marks make?
- At Today, should the graph prompt planned-dose confirmation rather than merely showing another mark?
