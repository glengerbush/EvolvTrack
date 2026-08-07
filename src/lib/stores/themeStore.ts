import { writable, derived } from 'svelte/store';
import {
  themes,
  DASHBOARD_TABS,
  type ColorMode,
  type ColorModePreference,
  type DashboardTab,
  type DashboardTheme,
  type TabThemes,
  type ThemeName,
} from '$lib/theme/dashboardTheme';
import { getProfile, saveProfile } from '$lib/domain/health-data-storage';

const STORAGE_KEY = 'evolvtrack-theme';
const COLOR_MODE_STORAGE_KEY = 'evolvtrack-color-mode';
const OVERRIDES_STORAGE_KEY = 'evolvtrack-theme-overrides';

export type ThemeOverrideKey = `${ThemeName}:${ColorMode}:${DashboardTab}`;
export type ThemeOverrideMap = Partial<Record<ThemeOverrideKey, Partial<DashboardTheme>>>;

export function overrideKey(theme: ThemeName, mode: ColorMode, tab: DashboardTab): ThemeOverrideKey {
  return `${theme}:${mode}:${tab}` as ThemeOverrideKey;
}

function isValidTheme(v: string | null | undefined): v is ThemeName {
  return v === 'default' || v === 'colorblind' || v === 'greyscale';
}

function isValidColorModePreference(v: string | null | undefined): v is ColorModePreference {
  return v === 'light' || v === 'dark' || v === 'system';
}

function getInitialTheme(): ThemeName {
  if (typeof window === 'undefined') return 'default';
  const stored = localStorage.getItem(STORAGE_KEY);
  return isValidTheme(stored) ? stored : 'default';
}

function getInitialColorModePreference(): ColorModePreference {
  if (typeof window === 'undefined') return 'system';
  const stored = localStorage.getItem(COLOR_MODE_STORAGE_KEY);
  return isValidColorModePreference(stored) ? stored : 'system';
}

// Detect the current OS preference, with safe SSR fallback.
function getSystemColorMode(): ColorMode {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getInitialOverrides(): ThemeOverrideMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(OVERRIDES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const _activeTheme = writable<ThemeName>(getInitialTheme());
const _colorModePreference = writable<ColorModePreference>(getInitialColorModePreference());
const _systemColorMode = writable<ColorMode>(getSystemColorMode());
const _themeOverrides = writable<ThemeOverrideMap>(getInitialOverrides());

function persistOverrides(map: ThemeOverrideMap) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(OVERRIDES_STORAGE_KEY, JSON.stringify(map));
}

if (typeof window !== 'undefined') {
  // Subscribe to OS color-scheme changes so `'system'` stays live.
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (media) {
    const onChange = (event: MediaQueryListEvent) => _systemColorMode.set(event.matches ? 'dark' : 'light');
    // Newer browsers support addEventListener; older Safari needs addListener.
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange);
    } else if (typeof (media as MediaQueryList & { addListener?: (l: (e: MediaQueryListEvent) => void) => void }).addListener === 'function') {
      (media as MediaQueryList & { addListener: (l: (e: MediaQueryListEvent) => void) => void }).addListener(onChange);
    }
  }

  void getProfile().then((profile) => {
    if (isValidTheme(profile?.colorTheme)) {
      localStorage.setItem(STORAGE_KEY, profile.colorTheme);
      _activeTheme.set(profile.colorTheme);
    }
    if (isValidColorModePreference(profile?.colorModePreference)) {
      localStorage.setItem(COLOR_MODE_STORAGE_KEY, profile.colorModePreference);
      _colorModePreference.set(profile.colorModePreference);
    }
  });
}

export const activeTheme = {
  subscribe: _activeTheme.subscribe,
  set(name: ThemeName) {
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, name);
    }
    _activeTheme.set(name);
    void saveProfile({ colorTheme: name });
  },
};

export const colorModePreference = {
  subscribe: _colorModePreference.subscribe,
  set(pref: ColorModePreference) {
    if (typeof window !== 'undefined') {
      localStorage.setItem(COLOR_MODE_STORAGE_KEY, pref);
    }
    _colorModePreference.set(pref);
    void saveProfile({ colorModePreference: pref });
  },
};

// The mode actually in effect after resolving 'system'.
export const activeColorMode = derived<[typeof _colorModePreference, typeof _systemColorMode], ColorMode>(
  [_colorModePreference, _systemColorMode],
  ([$pref, $sys]) => ($pref === 'system' ? $sys : $pref),
);

export const themeOverrides = {
  subscribe: _themeOverrides.subscribe,
  setField(
    theme: ThemeName,
    mode: ColorMode,
    tab: DashboardTab,
    field: keyof DashboardTheme,
    value: string,
  ) {
    _themeOverrides.update((map) => {
      const key = overrideKey(theme, mode, tab);
      const existing = map[key] ?? {};
      const next: Partial<DashboardTheme> = { ...existing, [field]: value };
      const updated: ThemeOverrideMap = { ...map, [key]: next };
      persistOverrides(updated);
      return updated;
    });
  },
  clearField(theme: ThemeName, mode: ColorMode, tab: DashboardTab, field: keyof DashboardTheme) {
    _themeOverrides.update((map) => {
      const key = overrideKey(theme, mode, tab);
      const existing = map[key];
      if (!existing) return map;
      const next: Partial<DashboardTheme> = { ...existing };
      delete next[field];
      const updated: ThemeOverrideMap = { ...map };
      if (Object.keys(next).length === 0) {
        delete updated[key];
      } else {
        updated[key] = next;
      }
      persistOverrides(updated);
      return updated;
    });
  },
  resetTab(theme: ThemeName, mode: ColorMode, tab: DashboardTab) {
    _themeOverrides.update((map) => {
      const key = overrideKey(theme, mode, tab);
      if (!(key in map)) return map;
      const updated: ThemeOverrideMap = { ...map };
      delete updated[key];
      persistOverrides(updated);
      return updated;
    });
  },
  resetAll() {
    persistOverrides({});
    _themeOverrides.set({});
  },
};

export const activeTabThemes = derived<
  [typeof _activeTheme, typeof activeColorMode, typeof _themeOverrides],
  TabThemes
>(
  [_activeTheme, activeColorMode, _themeOverrides],
  ([$theme, $mode, $overrides]) => {
    const base = themes[$theme][$mode];
    const merged = {} as TabThemes;
    for (const tab of DASHBOARD_TABS) {
      const key = overrideKey($theme, $mode, tab);
      const tabOverrides = $overrides[key];
      merged[tab] = tabOverrides ? { ...base[tab], ...tabOverrides } : base[tab];
    }
    return merged;
  },
);
