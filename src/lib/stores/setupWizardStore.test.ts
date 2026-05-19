// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'evolvtrack-setup-wizard-pending';

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

async function freshStore() {
  const mod = await import('$lib/stores/setupWizardStore');
  return mod;
}

describe('setupWizardPending — initial value', () => {
  it('reads false when nothing is stored', async () => {
    const { setupWizardPending, isSetupWizardPending } = await freshStore();
    const { get } = await import('svelte/store');
    expect(get(setupWizardPending)).toBe(false);
    expect(isSetupWizardPending()).toBe(false);
  });

  it('reads true when localStorage flag is set', async () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    const { setupWizardPending, isSetupWizardPending } = await freshStore();
    const { get } = await import('svelte/store');
    expect(get(setupWizardPending)).toBe(true);
    expect(isSetupWizardPending()).toBe(true);
  });

  it('reads false for any value other than the literal "true"', async () => {
    localStorage.setItem(STORAGE_KEY, '1');
    const { setupWizardPending, isSetupWizardPending } = await freshStore();
    const { get } = await import('svelte/store');
    expect(get(setupWizardPending)).toBe(false);
    expect(isSetupWizardPending()).toBe(false);
  });
});

describe('setupWizardPending — mark / clear', () => {
  it('mark persists the flag and updates the store', async () => {
    const { setupWizardPending, isSetupWizardPending } = await freshStore();
    const { get } = await import('svelte/store');
    setupWizardPending.mark();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');
    expect(get(setupWizardPending)).toBe(true);
    expect(isSetupWizardPending()).toBe(true);
  });

  it('clear removes the flag and resets the store', async () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    const { setupWizardPending, isSetupWizardPending } = await freshStore();
    const { get } = await import('svelte/store');
    setupWizardPending.clear();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(get(setupWizardPending)).toBe(false);
    expect(isSetupWizardPending()).toBe(false);
  });
});
