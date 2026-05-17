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
