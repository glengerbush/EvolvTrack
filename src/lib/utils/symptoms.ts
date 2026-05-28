export const DEFAULT_SYMPTOM_COLORS: Record<string, string> = {
  Nausea: '#e7bb72',
  Diarrhea: '#a8d5a2',
  Vomiting: '#f4a97a',
  Constipation: '#c8ccd4',
  'Abdominal pain': '#f09ab0',
  Headache: '#ef9aa2',
  Anhedonia: '#9a98e9',
};

export const DEFAULT_SYMPTOM_OPTIONS = Object.keys(DEFAULT_SYMPTOM_COLORS);

export function symptomColor(symptom: string, colors: Record<string, string>): string {
  return colors[symptom] ?? '#c8ccd4';
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100;
  const l = lightness / 100;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const value = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(value * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Pick a hex color for a freshly-discovered symptom. Hue is randomized;
 * saturation/lightness sit in the same range as the built-in defaults so
 * imported entries don't look out of place next to "Nausea" or "Headache".
 * Pass a custom `rng` in tests for determinism.
 */
export function generateSymptomColor(rng: () => number = Math.random): string {
  const hue = Math.floor(rng() * 360);
  const saturation = 55 + Math.floor(rng() * 20);
  const lightness = 70 + Math.floor(rng() * 8);
  return hslToHex(hue, saturation, lightness);
}

export function symptomInitial(symptom: string): string {
  const trimmed = symptom.trim();
  if (!trimmed) return '?';
  // Use Intl.Segmenter when available so multi-code-point graphemes (emoji
  // with surrogate pairs, ZWJ sequences, variation selectors) stay intact.
  // `charAt(0)` returns half a surrogate pair for emoji and renders as �.
  const first =
    typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
      ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
          .segment(trimmed)
          [Symbol.iterator]()
          .next().value?.segment ?? trimmed
      : Array.from(trimmed)[0] ?? trimmed;
  return /\p{L}/u.test(first) ? first.toUpperCase() : first;
}
