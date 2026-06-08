// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import MultiPicker from './MultiPicker.svelte';
import MultiPickerHarness from '../../../../test/MultiPickerHarness.svelte';

type Mounted = { component: ReturnType<typeof mount>; container: HTMLElement };
let active: Mounted | null = null;

function mountIn(component: unknown, props: Record<string, unknown>): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mounted = mount(component as any, { target: container, props: props as any });
  flushSync();
  active = { component: mounted, container };
  return container;
}

function setup(props: {
  values?: string[];
  options?: string[];
  onToggle?: (option: string) => void;
  optionColor?: (option: string) => string;
  forceOpen?: boolean;
  onRequestClose?: () => void;
}): HTMLElement {
  return mountIn(MultiPicker, { ariaLabel: 'Symptoms', onToggle: () => {}, ...props });
}

function setupHarness(props: {
  initialValues?: string[];
  options?: string[];
  optionColor?: (option: string) => string;
}): HTMLElement {
  return mountIn(MultiPickerHarness, props);
}

afterEach(() => {
  if (active) {
    unmount(active.component);
    active.container.remove();
    active = null;
  }
});

function trigger(container: HTMLElement): HTMLElement {
  return container.querySelector('.multi-picker-trigger') as HTMLElement;
}

function chevron(container: HTMLElement): HTMLButtonElement {
  return container.querySelector('.multi-picker-chevron-btn') as HTMLButtonElement;
}

function selectedPills(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll('.multi-picker-values .multi-picker-pill'),
  ) as HTMLElement[];
}

function dropdownOptions(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('.multi-picker-option')) as HTMLElement[];
}

function menu(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.multi-picker-menu');
}

function liveRegion(container: HTMLElement): HTMLElement {
  return container.querySelector('[aria-live="polite"]') as HTMLElement;
}

function keydown(target: Element, key: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

async function settle(): Promise<void> {
  await tick();
  flushSync();
}

describe('MultiPicker — rendering', () => {
  it('renders each selected value as a pill in the trigger', () => {
    const container = setup({ values: ['Headache', 'Nausea'], options: ['Headache', 'Nausea', 'Fatigue'] });
    expect(selectedPills(container).map((p) => p.textContent?.trim())).toEqual(['Headache', 'Nausea']);
  });

  it('shows the "None" placeholder when no values are selected', () => {
    const container = setup({ values: [], options: ['Headache'] });
    expect(container.querySelector('.multi-picker-placeholder')?.textContent).toBe('None');
  });

  it('uses empty arrays as defaults when values/options are omitted', () => {
    const container = setup({});
    expect(selectedPills(container)).toHaveLength(0);
    expect(menu(container)).toBeNull();
  });

  it('the menu lists ALL options (selected and unselected) once open', async () => {
    const container = setup({ values: ['Nausea'], options: ['Headache', 'Nausea', 'Fatigue'] });
    chevron(container).click();
    await settle();
    expect(dropdownOptions(container).map((o) => o.textContent?.trim())).toEqual([
      'Headache',
      '✓ Nausea',
      'Fatigue',
    ]);
  });

  it('marks selected options with aria-selected and the selected class', async () => {
    const container = setup({ values: ['Nausea'], options: ['Headache', 'Nausea'] });
    chevron(container).click();
    await settle();
    const [headache, nausea] = dropdownOptions(container);
    expect(headache.getAttribute('aria-selected')).toBe('false');
    expect(headache.classList.contains('selected')).toBe(false);
    expect(nausea.getAttribute('aria-selected')).toBe('true');
    expect(nausea.classList.contains('selected')).toBe(true);
  });

  it('applies optionColor as a fill for selected and a tint for unselected', async () => {
    const container = setup({
      values: ['Nausea'],
      options: ['Headache', 'Nausea'],
      optionColor: () => '#3366cc',
    });
    chevron(container).click();
    await settle();
    const [headache, nausea] = dropdownOptions(container);
    // Selected = solid fill in the option colour; unselected = a different
    // (tinted) treatment. (happy-dom drops color-mix() from inline styles, so we
    // assert the two states render distinctly rather than the exact tint.)
    expect(nausea.getAttribute('style')).toContain('#3366cc');
    expect(headache.getAttribute('style')).not.toBe(nausea.getAttribute('style'));
  });
});

describe('MultiPicker — toggle semantics', () => {
  it('clicking an option calls onToggle with that option', async () => {
    const onToggle = vi.fn();
    const container = setup({ values: [], options: ['Headache', 'Nausea'], onToggle });
    chevron(container).click();
    await settle();
    dropdownOptions(container)[1].click();
    expect(onToggle).toHaveBeenCalledWith('Nausea');
  });

  it('Space on a focused option toggles it and keeps the menu open', async () => {
    const onToggle = vi.fn();
    const container = setup({ values: [], options: ['Headache', 'Nausea'], onToggle });
    chevron(container).click();
    await settle();
    keydown(dropdownOptions(container)[0], ' ');
    expect(onToggle).toHaveBeenCalledWith('Headache');
    expect(menu(container)).not.toBeNull();
  });

  it('round-trips add then remove through the harness (selected stays in the list)', async () => {
    const container = setupHarness({ initialValues: [], options: ['Headache', 'Nausea'] });
    chevron(container).click();
    await settle();
    // add
    dropdownOptions(container)[0].click();
    await settle();
    expect(selectedPills(container).map((p) => p.textContent?.trim())).toEqual(['Headache']);
    expect(dropdownOptions(container)).toHaveLength(2); // still shows both
    // remove the same option from the menu
    dropdownOptions(container)[0].click();
    await settle();
    expect(selectedPills(container)).toHaveLength(0);
  });
});

describe('MultiPicker — open / close', () => {
  it('clicking the chevron toggles the menu', async () => {
    const container = setup({ options: ['Headache'] });
    expect(menu(container)).toBeNull();
    chevron(container).click();
    await settle();
    expect(menu(container)).not.toBeNull();
    chevron(container).click();
    await settle();
    expect(menu(container)).toBeNull();
  });

  it('ArrowDown / Enter / Space on the chevron open the menu', async () => {
    for (const key of ['ArrowDown', 'Enter', ' ']) {
      const container = setup({ options: ['Headache'] });
      keydown(chevron(container), key);
      await settle();
      expect(menu(container), `key ${key}`).not.toBeNull();
      unmount(active!.component);
      active!.container.remove();
      active = null;
    }
  });

  it('Enter on a focused option closes the menu via onRequestClose (does NOT toggle)', async () => {
    const onToggle = vi.fn();
    const onRequestClose = vi.fn();
    const container = setup({ values: [], options: ['Headache'], onToggle, onRequestClose });
    chevron(container).click();
    await settle();
    keydown(dropdownOptions(container)[0], 'Enter');
    await settle();
    expect(onToggle).not.toHaveBeenCalled();
    expect(onRequestClose).toHaveBeenCalledTimes(1);
    expect(menu(container)).toBeNull();
  });

  it('Escape inside the menu closes it via onRequestClose', async () => {
    const onRequestClose = vi.fn();
    const container = setup({ options: ['Headache'], onRequestClose });
    chevron(container).click();
    await settle();
    keydown(menu(container)!, 'Escape');
    await settle();
    expect(onRequestClose).toHaveBeenCalledTimes(1);
    expect(menu(container)).toBeNull();
  });

  it('Tab inside the menu closes it via onRequestClose', async () => {
    const onRequestClose = vi.fn();
    const container = setup({ options: ['Headache'], onRequestClose });
    chevron(container).click();
    await settle();
    keydown(menu(container)!, 'Tab');
    await settle();
    expect(onRequestClose).toHaveBeenCalledTimes(1);
    expect(menu(container)).toBeNull();
  });

  it('outside pointerdown closes the menu via onRequestClose', async () => {
    const onRequestClose = vi.fn();
    const container = setup({ options: ['Headache'], onRequestClose });
    chevron(container).click();
    await settle();
    document.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await settle();
    expect(onRequestClose).toHaveBeenCalledTimes(1);
    expect(menu(container)).toBeNull();
  });

  it('forceOpen opens the menu and focuses a selected option first', async () => {
    const container = setup({ values: ['Nausea'], options: ['Headache', 'Nausea'], forceOpen: true });
    await settle();
    expect(menu(container)).not.toBeNull();
    expect(document.activeElement).toBe(dropdownOptions(container)[1]);
  });
});

describe('MultiPicker — keyboard navigation', () => {
  it('ArrowDown moves to the next option and wraps at the end', async () => {
    const container = setup({ options: ['Headache', 'Nausea'] });
    chevron(container).click();
    await settle();
    const opts = dropdownOptions(container);
    opts[0].focus();
    keydown(opts[0], 'ArrowDown');
    expect(document.activeElement).toBe(opts[1]);
    keydown(opts[1], 'ArrowDown');
    expect(document.activeElement).toBe(opts[0]);
  });

  it('ArrowUp from the first option wraps to the last', async () => {
    const container = setup({ options: ['Headache', 'Nausea'] });
    chevron(container).click();
    await settle();
    const opts = dropdownOptions(container);
    opts[0].focus();
    keydown(opts[0], 'ArrowUp');
    expect(document.activeElement).toBe(opts[1]);
  });

  it('Home jumps to the first option, End to the last', async () => {
    const container = setup({ options: ['Headache', 'Nausea', 'Fatigue'] });
    chevron(container).click();
    await settle();
    const opts = dropdownOptions(container);
    opts[1].focus();
    keydown(opts[1], 'End');
    expect(document.activeElement).toBe(opts[2]);
    keydown(opts[2], 'Home');
    expect(document.activeElement).toBe(opts[0]);
  });

  it('typeahead jumps to the next option starting with the typed letter', async () => {
    const container = setup({ options: ['Headache', 'Nausea', 'Numbness'] });
    chevron(container).click();
    await settle();
    const opts = dropdownOptions(container);
    opts[0].focus();
    keydown(menu(container)!, 'n');
    expect(document.activeElement).toBe(opts[1]);
    keydown(menu(container)!, 'n');
    expect(document.activeElement).toBe(opts[2]);
  });
});

describe('MultiPicker — ARIA & announcements', () => {
  it('the listbox is multiselectable with a context label', async () => {
    const container = setup({ options: ['Headache'] });
    chevron(container).click();
    await settle();
    const list = menu(container)!;
    expect(list.getAttribute('role')).toBe('listbox');
    expect(list.getAttribute('aria-multiselectable')).toBe('true');
    expect(list.getAttribute('aria-label')).toMatch(/symptoms/i);
  });

  it('options use role="option" with aria-selected reflecting state', async () => {
    const container = setup({ values: ['Nausea'], options: ['Headache', 'Nausea'] });
    chevron(container).click();
    await settle();
    const opts = dropdownOptions(container);
    expect(opts.every((o) => o.getAttribute('role') === 'option')).toBe(true);
    expect(opts[0].getAttribute('aria-selected')).toBe('false');
    expect(opts[1].getAttribute('aria-selected')).toBe('true');
  });

  it('roving tabindex: only the focused option has tabindex 0', async () => {
    const container = setup({ options: ['Headache', 'Nausea'] });
    chevron(container).click();
    await settle();
    const opts = dropdownOptions(container);
    const zeros = opts.filter((o) => o.getAttribute('tabindex') === '0');
    expect(zeros).toHaveLength(1);
  });

  it('announces additions and removals on the live region', async () => {
    const container = setupHarness({ initialValues: [], options: ['Headache'] });
    chevron(container).click();
    await settle();
    dropdownOptions(container)[0].click();
    await settle();
    expect(liveRegion(container).textContent).toMatch(/Headache added\. 1 selected/);
    dropdownOptions(container)[0].click();
    await settle();
    expect(liveRegion(container).textContent).toMatch(/Headache removed\. 0 selected/);
  });
});
