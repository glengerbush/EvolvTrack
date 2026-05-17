import { writable } from 'svelte/store';
import {
  DEFAULT_SYMPTOM_COLORS,
  DEFAULT_SYMPTOM_OPTIONS,
  symptomColor,
  symptomInitial,
} from '$lib/utils/symptoms';

export { DEFAULT_SYMPTOM_COLORS, DEFAULT_SYMPTOM_OPTIONS, symptomColor, symptomInitial };

export const symptomOptions = writable<string[]>([...DEFAULT_SYMPTOM_OPTIONS]);
export const symptomColors = writable<Record<string, string>>({ ...DEFAULT_SYMPTOM_COLORS });
