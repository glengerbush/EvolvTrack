import { describe, expect, it } from 'vitest';
import { themes, type ColorMode, type DashboardTab, type DashboardTheme, type ThemeName } from './dashboardTheme';

const THEME_NAMES: ThemeName[] = ['default', 'colorblind', 'greyscale'];
const COLOR_MODES: ColorMode[] = ['light', 'dark'];
const TAB_NAMES: DashboardTab[] = ['health', 'medication', 'calculators', 'info', 'settings'];

const THEME_KEYS: Array<keyof DashboardTheme> = [
  'bgTint',
  'gridLine',
  'cardBorder',
  'headerBg',
  'headerText',
  'accent',
  'warning',
  'success',
  'tabBase',
  'tabText',
  'stripe',
  'rowAlt',
  'vialActive',
  'vialWarning',
  'weightLine',
  'wellnessBar',
  'symptomMarker',
  'danger',
];

const isHexColor = (s: string) => /^#[0-9a-fA-F]{3,8}$/.test(s);
const isRgbaColor = (s: string) => /^rgba?\(/.test(s);

const allCombos = THEME_NAMES.flatMap((name) =>
  COLOR_MODES.flatMap((mode) => TAB_NAMES.map((tab) => [name, mode, tab] as const)),
);

describe('themes structure', () => {
  it('exposes the three documented theme names', () => {
    expect(Object.keys(themes).sort()).toEqual([...THEME_NAMES].sort());
  });

  it.each(THEME_NAMES)('theme %s has both light and dark modes', (name) => {
    expect(Object.keys(themes[name]).sort()).toEqual([...COLOR_MODES].sort());
  });

  it.each(
    THEME_NAMES.flatMap((name) => COLOR_MODES.map((mode) => [name, mode] as const)),
  )('themes.%s.%s has every tab', (name, mode) => {
    expect(Object.keys(themes[name][mode]).sort()).toEqual([...TAB_NAMES].sort());
  });

  it.each(allCombos)('themes.%s.%s.%s has every theme key', (name, mode, tab) => {
    const theme = themes[name][mode][tab];
    for (const key of THEME_KEYS) {
      expect(theme[key], `themes.${name}.${mode}.${tab}.${key}`).toBeDefined();
      expect(typeof theme[key]).toBe('string');
    }
  });

  it.each(allCombos)('themes.%s.%s.%s values are valid CSS colors (hex or rgba)', (name, mode, tab) => {
    const theme = themes[name][mode][tab];
    for (const key of THEME_KEYS) {
      const v = theme[key];
      expect(isHexColor(v) || isRgbaColor(v), `${name}.${mode}.${tab}.${key} = "${v}"`).toBe(true);
    }
  });
});

describe('default theme spot checks', () => {
  it('health tab uses the documented green palette (light)', () => {
    expect(themes.default.light.health.headerBg).toBe('#1f7a3a');
    expect(themes.default.light.health.bgTint).toBe('#c7d6b8');
  });

  it('medication tab uses the documented blue/grey palette (light)', () => {
    expect(themes.default.light.medication.headerBg).toBe('#6b84a6');
  });

  it('dark variants invert surface lightness: bgTint is darker than the light counterpart', () => {
    // Crude but stable: compare hex lightness via avg byte.
    const avg = (hex: string) => {
      const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
      if (!m) return NaN;
      return (parseInt(m[1], 16) + parseInt(m[2], 16) + parseInt(m[3], 16)) / 3;
    };
    for (const tab of TAB_NAMES) {
      const light = themes.default.light[tab].bgTint;
      const dark = themes.default.dark[tab].bgTint;
      expect(avg(dark), `default.dark.${tab}.bgTint must be darker than light`).toBeLessThan(avg(light));
    }
  });
});

describe('greyscale theme', () => {
  // Greyscale should have no hue: hex values should have R == G == B.
  const isPureGrey = (hex: string) => {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return false;
    const r = hex.slice(1, 3);
    const g = hex.slice(3, 5);
    const b = hex.slice(5, 7);
    return r.toLowerCase() === g.toLowerCase() && g.toLowerCase() === b.toLowerCase();
  };

  it.each(
    COLOR_MODES.flatMap((mode) =>
      TAB_NAMES.flatMap((tab) =>
        (['bgTint', 'cardBorder', 'headerBg', 'accent', 'warning', 'success', 'tabBase'] as const).map(
          (key) => [mode, tab, key] as const,
        ),
      ),
    ),
  )('greyscale.%s.%s.%s is a pure grey hex', (mode, tab, key) => {
    const v = themes.greyscale[mode][tab][key];
    expect(isPureGrey(v), `greyscale.${mode}.${tab}.${key} = "${v}"`).toBe(true);
  });
});
