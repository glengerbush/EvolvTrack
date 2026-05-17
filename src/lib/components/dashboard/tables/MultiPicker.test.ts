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
  onToggle: (option: string) => void;
  optionColor?: (option: string) => string;
}): HTMLElement {
  return mountIn(MultiPicker, { ariaLabel: 'Symptoms', ...props });
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

function selectedPills(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll('.multi-picker-values .multi-picker-pill'),
  ) as HTMLButtonElement[];
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

describe('MultiPicker — rendering & basic interaction', () => {
  it('renders each selected value as a pill button', () => {
    const container = setup({
      values: ['Headache', 'Fatigue'],
      options: ['Headache', 'Fatigue', 'Nausea'],
      onToggle: vi.fn(),
    });
    expect(selectedPills(container).map((p) => p.textContent)).toEqual([
      'Headache',
      'Fatigue',
    ]);
    selectedPills(container).forEach((pill) => {
      expect(pill.tagName).toBe('BUTTON');
    });
  });

  it('shows the "None" placeholder when no values are selected', () => {
    const container = setup({ values: [], options: ['Headache'], onToggle: vi.fn() });
    expect(container.querySelector('.multi-picker-placeholder')?.textContent).toBe('None');
  });

  it('filters already-selected values out of the dropdown', () => {
    const container = setup({
      values: ['Headache'],
      options: ['Headache', 'Fatigue', 'Nausea'],
      onToggle: vi.fn(),
    });
    chevron(container).click();
    flushSync();
    expect(dropdownOptions(container).map((o) => o.textContent)).toEqual([
      'Fatigue',
      'Nausea',
    ]);
  });

  it('shows "All selected" when every option is already chosen', () => {
    const container = setup({
      values: ['Headache'],
      options: ['Headache'],
      onToggle: vi.fn(),
    });
    chevron(container).click();
    flushSync();
    expect(container.querySelector('.multi-picker-empty')?.textContent).toBe('All selected');
  });

  it('uses empty arrays as defaults when values/options are omitted', () => {
    const container = setup({ onToggle: vi.fn() });
    expect(container.querySelector('.multi-picker-placeholder')?.textContent).toBe('None');
    chevron(container).click();
    flushSync();
    expect(container.querySelector('.multi-picker-empty')?.textContent).toBe('All selected');
  });

  it('applies optionColor to selected pills and dropdown options', () => {
    const container = setup({
      values: ['Headache'],
      options: ['Headache', 'Fatigue'],
      optionColor: (option) =>
        option === 'Headache' ? 'rgb(255, 0, 0)' : 'rgb(0, 0, 255)',
      onToggle: vi.fn(),
    });
    expect(selectedPills(container)[0].style.background).toContain('rgb(255, 0, 0)');
    chevron(container).click();
    flushSync();
    expect(dropdownOptions(container)[0].style.background).toContain('rgb(0, 0, 255)');
  });
});

describe('MultiPicker — click semantics', () => {
  it('clicking empty area of the trigger toggles the dropdown', () => {
    const container = setup({ values: [], options: ['Headache'], onToggle: vi.fn() });
    trigger(container).click();
    flushSync();
    expect(menu(container)).not.toBeNull();
    trigger(container).click();
    flushSync();
    expect(menu(container)).toBeNull();
  });

  it('clicking the chevron toggles the dropdown', () => {
    const container = setup({ values: [], options: ['Headache'], onToggle: vi.fn() });
    chevron(container).click();
    flushSync();
    expect(menu(container)).not.toBeNull();
    chevron(container).click();
    flushSync();
    expect(menu(container)).toBeNull();
  });

  it('calls onToggle with the chosen option when a dropdown option is clicked', () => {
    const onToggle = vi.fn();
    const container = setup({ values: [], options: ['Headache', 'Fatigue'], onToggle });
    chevron(container).click();
    flushSync();
    dropdownOptions(container)[1].click();
    expect(onToggle).toHaveBeenCalledWith('Fatigue');
  });

  it('first click on a selected pill opens the dropdown without calling onToggle', () => {
    const onToggle = vi.fn();
    const container = setup({
      values: ['Headache'],
      options: ['Headache', 'Fatigue'],
      onToggle,
    });
    expect(menu(container)).toBeNull();
    selectedPills(container)[0].click();
    flushSync();
    expect(onToggle).not.toHaveBeenCalled();
    expect(menu(container)).not.toBeNull();
  });

  it('a subsequent click on a selected pill (while open) calls onToggle to deselect', () => {
    const onToggle = vi.fn();
    const container = setup({
      values: ['Headache'],
      options: ['Headache', 'Fatigue'],
      onToggle,
    });
    selectedPills(container)[0].click();
    flushSync();
    selectedPills(container)[0].click();
    expect(onToggle).toHaveBeenCalledWith('Headache');
  });

  it('applies the is-removable class to selected pills only while the dropdown is open', () => {
    const container = setup({
      values: ['Headache'],
      options: ['Headache', 'Fatigue'],
      onToggle: vi.fn(),
    });
    expect(selectedPills(container)[0].classList.contains('is-removable')).toBe(false);
    chevron(container).click();
    flushSync();
    expect(selectedPills(container)[0].classList.contains('is-removable')).toBe(true);
  });

  it('closes the dropdown on outside pointerdown', () => {
    const container = setup({ values: [], options: ['Headache'], onToggle: vi.fn() });
    chevron(container).click();
    flushSync();
    expect(menu(container)).not.toBeNull();

    const outside = document.createElement('div');
    document.body.appendChild(outside);
    outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    flushSync();
    expect(menu(container)).toBeNull();
    outside.remove();
  });

  it('keeps the dropdown open when pointerdown happens inside the picker', () => {
    const container = setup({
      values: ['Headache'],
      options: ['Headache', 'Fatigue'],
      onToggle: vi.fn(),
    });
    chevron(container).click();
    flushSync();
    menu(container)!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    flushSync();
    expect(menu(container)).not.toBeNull();
  });
});

describe('MultiPicker — ARIA & roles', () => {
  it('chevron exposes aria-haspopup, aria-expanded, and a flipping aria-label; aria-controls only when expanded', () => {
    const container = setup({ values: [], options: ['Headache'], onToggle: vi.fn() });
    const btn = chevron(container);
    expect(btn.getAttribute('aria-haspopup')).toBe('listbox');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.getAttribute('aria-label')).toContain('Open');
    // aria-controls must NOT reference a listbox that isn't rendered yet.
    expect(btn.getAttribute('aria-controls')).toBeNull();

    chevron(container).click();
    flushSync();
    const opened = chevron(container);
    expect(opened.getAttribute('aria-expanded')).toBe('true');
    expect(opened.getAttribute('aria-label')).toContain('Close');
    const listboxIdAttr = opened.getAttribute('aria-controls');
    expect(listboxIdAttr).toBeTruthy();
    expect(menu(container)?.id).toBe(listboxIdAttr);
  });

  it('chevron does not carry aria-describedby (hint lives on the listbox)', () => {
    const container = setup({ values: [], options: ['Headache'], onToggle: vi.fn() });
    expect(chevron(container).getAttribute('aria-describedby')).toBeNull();
  });

  it('listbox has role="listbox", aria-multiselectable="true", and a context-specific aria-label', () => {
    const container = setup({ values: [], options: ['Headache'], onToggle: vi.fn() });
    chevron(container).click();
    flushSync();
    const m = menu(container)!;
    expect(m.getAttribute('role')).toBe('listbox');
    expect(m.getAttribute('aria-multiselectable')).toBe('true');
    // "Add ..." disambiguates from the pill group ("Selected ...") so screen
    // readers describe each region's purpose distinctly.
    expect(m.getAttribute('aria-label')).toBe('Add symptoms');
  });

  it('dropdown options have role="option" with aria-selected="false" and are not <button> elements', () => {
    const container = setup({
      values: [],
      options: ['Headache', 'Fatigue'],
      onToggle: vi.fn(),
    });
    chevron(container).click();
    flushSync();
    dropdownOptions(container).forEach((opt) => {
      expect(opt.getAttribute('role')).toBe('option');
      expect(opt.getAttribute('aria-selected')).toBe('false');
      // Buttons are a stronger interactive role than option; avoid the downgrade.
      expect(opt.tagName).not.toBe('BUTTON');
    });
  });

  it('listbox carries the keyboard-hint aria-describedby with arrow/Enter/typeahead guidance', () => {
    const container = setup({ values: [], options: ['Headache'], onToggle: vi.fn() });
    chevron(container).click();
    flushSync();
    const describedBy = menu(container)!.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const hint = container.querySelector(`#${describedBy}`);
    expect(hint).toBeTruthy();
    const text = hint!.textContent?.toLowerCase() ?? '';
    expect(text).toContain('arrow keys');
    expect(text).toContain('enter');
  });

  it('selected pills are grouped under a labeled role="group" with a Backspace-aware description', () => {
    const container = setup({
      values: ['Headache', 'Fatigue'],
      options: ['Headache', 'Fatigue', 'Nausea'],
      onToggle: vi.fn(),
    });
    const group = container.querySelector('.multi-picker-values')!;
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('Selected symptoms');
    const describedBy = group.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const hint = container.querySelector(`#${describedBy}`);
    expect(hint?.textContent?.toLowerCase()).toContain('backspace');
  });

  it('pill container drops the group landmark when no pills are present', () => {
    const container = setup({ values: [], options: ['Headache'], onToggle: vi.fn() });
    const group = container.querySelector('.multi-picker-values')!;
    expect(group.getAttribute('role')).toBeNull();
    expect(group.getAttribute('aria-label')).toBeNull();
    expect(group.getAttribute('aria-describedby')).toBeNull();
  });

  it('"All selected" empty placeholder is not announced as a live region', () => {
    const container = setup({
      values: ['Headache'],
      options: ['Headache'],
      onToggle: vi.fn(),
    });
    chevron(container).click();
    flushSync();
    const empty = container.querySelector('.multi-picker-empty');
    expect(empty).toBeTruthy();
    expect(empty?.getAttribute('role')).toBeNull();
    expect(empty?.getAttribute('aria-live')).toBeNull();
  });

  it('roving tabindex: only the focused option has tabindex 0', () => {
    const container = setup({
      values: [],
      options: ['Headache', 'Fatigue', 'Nausea'],
      onToggle: vi.fn(),
    });
    chevron(container).click();
    flushSync();
    const opts = dropdownOptions(container);
    expect(opts.map((o) => o.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
  });

  it('pill aria-label flips between bare value (closed) and "Remove X" (open)', () => {
    const container = setup({
      values: ['Headache'],
      options: ['Headache', 'Fatigue'],
      onToggle: vi.fn(),
    });
    expect(selectedPills(container)[0].getAttribute('aria-label')).toBeNull();
    chevron(container).click();
    flushSync();
    expect(selectedPills(container)[0].getAttribute('aria-label')).toBe('Remove Headache');
  });

  it('exposes a polite live region for announcements', () => {
    const container = setup({ values: [], options: ['Headache'], onToggle: vi.fn() });
    const region = liveRegion(container);
    expect(region).toBeTruthy();
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('aria-atomic')).toBe('true');
  });
});

describe('MultiPicker — keyboard interaction', () => {
  it('ArrowDown on chevron opens the menu', async () => {
    const container = setup({ values: [], options: ['Headache'], onToggle: vi.fn() });
    keydown(chevron(container), 'ArrowDown');
    await settle();
    expect(menu(container)).not.toBeNull();
  });

  it('ArrowUp on chevron opens the menu', async () => {
    const container = setup({ values: [], options: ['Headache'], onToggle: vi.fn() });
    keydown(chevron(container), 'ArrowUp');
    await settle();
    expect(menu(container)).not.toBeNull();
  });

  it('ignores non-special keys on the chevron', () => {
    const container = setup({ values: [], options: ['Headache'], onToggle: vi.fn() });
    keydown(chevron(container), 'Enter');
    flushSync();
    expect(menu(container)).toBeNull();
  });

  it('ArrowDown on the chevron while the menu is already open focuses the first option', async () => {
    const container = setup({
      values: [],
      options: ['Headache', 'Fatigue', 'Nausea'],
      onToggle: vi.fn(),
    });
    keydown(chevron(container), 'ArrowDown');
    await settle();
    keydown(menu(container)!, 'ArrowDown'); // move focus to second item
    flushSync();
    keydown(chevron(container), 'ArrowDown');
    flushSync();
    expect(document.activeElement).toBe(dropdownOptions(container)[0]);
  });

  it('ArrowUp on the chevron while the menu is already open focuses the last option', async () => {
    const container = setup({
      values: [],
      options: ['Headache', 'Fatigue', 'Nausea'],
      onToggle: vi.fn(),
    });
    keydown(chevron(container), 'ArrowDown');
    await settle();
    keydown(chevron(container), 'ArrowUp');
    flushSync();
    expect(document.activeElement).toBe(dropdownOptions(container)[2]);
  });

  it('ArrowUp on the chevron when no options remain leaves focus alone', async () => {
    const container = setup({
      values: ['Headache'],
      options: ['Headache'],
      onToggle: vi.fn(),
    });
    chevron(container).focus();
    keydown(chevron(container), 'ArrowUp');
    await settle();
    expect(menu(container)).not.toBeNull();
    expect(document.activeElement).toBe(chevron(container));
  });

  it('ignores arrow keys inside an empty menu', async () => {
    const container = setup({
      values: ['Headache'],
      options: ['Headache'],
      onToggle: vi.fn(),
    });
    chevron(container).click();
    await settle();
    keydown(menu(container)!, 'ArrowDown');
    flushSync();
    expect(menu(container)).not.toBeNull();
  });

  it('ignores unrelated keys on a selected pill', () => {
    const onToggle = vi.fn();
    const container = setup({
      values: ['Headache'],
      options: ['Headache', 'Fatigue'],
      onToggle,
    });
    keydown(selectedPills(container)[0], 'a');
    expect(onToggle).not.toHaveBeenCalled();
    expect(menu(container)).toBeNull();
  });

  it('Escape on a pill when the menu is closed does nothing', () => {
    const container = setup({
      values: ['Headache'],
      options: ['Headache', 'Fatigue'],
      onToggle: vi.fn(),
    });
    keydown(selectedPills(container)[0], 'Escape');
    flushSync();
    expect(menu(container)).toBeNull();
  });

  it('Escape on chevron closes the menu and returns focus to the chevron', () => {
    const container = setup({ values: [], options: ['Headache'], onToggle: vi.fn() });
    chevron(container).click();
    flushSync();
    keydown(chevron(container), 'Escape');
    flushSync();
    expect(menu(container)).toBeNull();
  });

  it('ArrowDown in the open menu moves focus to the next option', async () => {
    const container = setup({
      values: [],
      options: ['Headache', 'Fatigue', 'Nausea'],
      onToggle: vi.fn(),
    });
    keydown(chevron(container), 'ArrowDown');
    await settle();
    expect(document.activeElement).toBe(dropdownOptions(container)[0]);

    keydown(menu(container)!, 'ArrowDown');
    flushSync();
    expect(document.activeElement).toBe(dropdownOptions(container)[1]);

    keydown(menu(container)!, 'ArrowDown');
    flushSync();
    expect(document.activeElement).toBe(dropdownOptions(container)[2]);
  });

  it('ArrowDown at the last option wraps to the first', async () => {
    const container = setup({
      values: [],
      options: ['Headache', 'Fatigue'],
      onToggle: vi.fn(),
    });
    keydown(chevron(container), 'ArrowDown');
    await settle();
    keydown(menu(container)!, 'ArrowDown');
    flushSync();
    keydown(menu(container)!, 'ArrowDown');
    flushSync();
    expect(document.activeElement).toBe(dropdownOptions(container)[0]);
  });

  it('ArrowUp from the first option wraps to the last', async () => {
    const container = setup({
      values: [],
      options: ['Headache', 'Fatigue', 'Nausea'],
      onToggle: vi.fn(),
    });
    keydown(chevron(container), 'ArrowDown');
    await settle();
    keydown(menu(container)!, 'ArrowUp');
    flushSync();
    expect(document.activeElement).toBe(dropdownOptions(container)[2]);
  });

  it('Home jumps to the first option, End to the last', async () => {
    const container = setup({
      values: [],
      options: ['Headache', 'Fatigue', 'Nausea'],
      onToggle: vi.fn(),
    });
    keydown(chevron(container), 'ArrowDown');
    await settle();
    keydown(menu(container)!, 'End');
    flushSync();
    expect(document.activeElement).toBe(dropdownOptions(container)[2]);
    keydown(menu(container)!, 'Home');
    flushSync();
    expect(document.activeElement).toBe(dropdownOptions(container)[0]);
  });

  it('Escape inside the menu closes it and returns focus to the chevron', async () => {
    const container = setup({
      values: [],
      options: ['Headache', 'Fatigue'],
      onToggle: vi.fn(),
    });
    keydown(chevron(container), 'ArrowDown');
    await settle();
    keydown(menu(container)!, 'Escape');
    flushSync();
    expect(menu(container)).toBeNull();
    expect(document.activeElement).toBe(chevron(container));
  });

  it('Tab inside the menu closes the menu and returns focus to the chevron', async () => {
    const container = setup({
      values: [],
      options: ['Headache', 'Fatigue'],
      onToggle: vi.fn(),
    });
    keydown(chevron(container), 'ArrowDown');
    await settle();
    keydown(menu(container)!, 'Tab');
    flushSync();
    expect(menu(container)).toBeNull();
    // Focus must anchor on the chevron so the browser's default Tab advances
    // from a real element rather than the option we just unmounted.
    expect(document.activeElement).toBe(chevron(container));
  });

  it('Enter on a focused option selects it', async () => {
    const onToggle = vi.fn();
    const container = setup({
      values: [],
      options: ['Headache', 'Fatigue'],
      onToggle,
    });
    keydown(chevron(container), 'ArrowDown');
    await settle();
    keydown(document.activeElement!, 'Enter');
    flushSync();
    expect(onToggle).toHaveBeenCalledWith('Headache');
  });

  it('Space on a focused option selects it', async () => {
    const onToggle = vi.fn();
    const container = setup({
      values: [],
      options: ['Headache', 'Fatigue'],
      onToggle,
    });
    keydown(chevron(container), 'ArrowDown');
    await settle();
    keydown(menu(container)!, 'ArrowDown');
    flushSync();
    keydown(document.activeElement!, ' ');
    flushSync();
    expect(onToggle).toHaveBeenCalledWith('Fatigue');
  });

  it('Backspace on a selected pill calls onToggle to remove it', () => {
    const onToggle = vi.fn();
    const container = setup({
      values: ['Headache'],
      options: ['Headache', 'Fatigue'],
      onToggle,
    });
    keydown(selectedPills(container)[0], 'Backspace');
    expect(onToggle).toHaveBeenCalledWith('Headache');
  });

  it('Delete on a selected pill calls onToggle to remove it', () => {
    const onToggle = vi.fn();
    const container = setup({
      values: ['Headache'],
      options: ['Headache', 'Fatigue'],
      onToggle,
    });
    keydown(selectedPills(container)[0], 'Delete');
    expect(onToggle).toHaveBeenCalledWith('Headache');
  });

  it('Escape on a focused pill closes an open menu', () => {
    const container = setup({
      values: ['Headache'],
      options: ['Headache', 'Fatigue'],
      onToggle: vi.fn(),
    });
    chevron(container).click();
    flushSync();
    keydown(selectedPills(container)[0], 'Escape');
    flushSync();
    expect(menu(container)).toBeNull();
  });
});

describe('MultiPicker — focus management', () => {
  it('clicking the chevron moves focus to the first menu option', async () => {
    const container = setup({
      values: [],
      options: ['Headache', 'Fatigue'],
      onToggle: vi.fn(),
    });
    chevron(container).click();
    await settle();
    expect(document.activeElement).toBe(dropdownOptions(container)[0]);
  });

  it('opening via empty-area trigger click does NOT move focus', async () => {
    const container = setup({
      values: [],
      options: ['Headache', 'Fatigue'],
      onToggle: vi.fn(),
    });
    const before = document.activeElement;
    trigger(container).click();
    await settle();
    expect(document.activeElement).toBe(before);
  });

  it('keyboard-activated pill (event.detail===0) opens menu and moves focus to first option', async () => {
    const container = setup({
      values: ['Headache'],
      options: ['Headache', 'Fatigue'],
      onToggle: vi.fn(),
    });
    selectedPills(container)[0].dispatchEvent(
      new MouseEvent('click', { bubbles: true, detail: 0 }),
    );
    await settle();
    expect(document.activeElement).toBe(dropdownOptions(container)[0]);
  });
});

describe('MultiPicker — live region announcements', () => {
  it('announces when a symptom is added', () => {
    const container = setup({
      values: [],
      options: ['Headache'],
      onToggle: vi.fn(),
    });
    chevron(container).click();
    flushSync();
    dropdownOptions(container)[0].click();
    flushSync();
    expect(liveRegion(container).textContent).toBe('Headache added. 1 selected.');
  });

  it('announces when a symptom is removed (with plural count)', () => {
    const container = setup({
      values: ['Headache', 'Fatigue', 'Nausea'],
      options: ['Headache', 'Fatigue', 'Nausea'],
      onToggle: vi.fn(),
    });
    chevron(container).click();
    flushSync();
    selectedPills(container)[1].click();
    flushSync();
    expect(liveRegion(container).textContent).toBe('Fatigue removed. 2 selected.');
  });
});

describe('MultiPicker — typeahead', () => {
  it('typing a letter inside the listbox jumps to the next option starting with it', async () => {
    const container = setup({
      values: [],
      options: ['Apple', 'Banana', 'Cherry'],
      onToggle: vi.fn(),
    });
    keydown(chevron(container), 'ArrowDown');
    await settle();
    keydown(menu(container)!, 'c');
    flushSync();
    expect(document.activeElement).toBe(dropdownOptions(container)[2]);
  });

  it('matching is case-insensitive', async () => {
    const container = setup({
      values: [],
      options: ['Apple', 'Banana'],
      onToggle: vi.fn(),
    });
    keydown(chevron(container), 'ArrowDown');
    await settle();
    keydown(menu(container)!, 'B');
    flushSync();
    expect(document.activeElement).toBe(dropdownOptions(container)[1]);
  });

  it('typing the same letter cycles through matching options', async () => {
    const container = setup({
      values: [],
      options: ['Apple', 'Apricot', 'Banana'],
      onToggle: vi.fn(),
    });
    keydown(chevron(container), 'ArrowDown');
    await settle();
    expect(document.activeElement).toBe(dropdownOptions(container)[0]);
    keydown(menu(container)!, 'a');
    flushSync();
    expect(document.activeElement).toBe(dropdownOptions(container)[1]);
    keydown(menu(container)!, 'a');
    flushSync();
    expect(document.activeElement).toBe(dropdownOptions(container)[0]);
  });

  it('ignores typeahead when a modifier key is held', async () => {
    const container = setup({
      values: [],
      options: ['Apple', 'Banana'],
      onToggle: vi.fn(),
    });
    keydown(chevron(container), 'ArrowDown');
    await settle();
    menu(container)!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }),
    );
    flushSync();
    expect(document.activeElement).toBe(dropdownOptions(container)[0]);
  });
});

describe('MultiPicker — pill keyboard navigation', () => {
  it('ArrowRight on a pill moves focus to the next pill', () => {
    const container = setup({
      values: ['Headache', 'Fatigue', 'Nausea'],
      options: ['Headache', 'Fatigue', 'Nausea'],
      onToggle: vi.fn(),
    });
    selectedPills(container)[0].focus();
    keydown(selectedPills(container)[0], 'ArrowRight');
    flushSync();
    expect(document.activeElement).toBe(selectedPills(container)[1]);
  });

  it('ArrowLeft on the first pill wraps to the last', () => {
    const container = setup({
      values: ['Headache', 'Fatigue'],
      options: ['Headache', 'Fatigue'],
      onToggle: vi.fn(),
    });
    selectedPills(container)[0].focus();
    keydown(selectedPills(container)[0], 'ArrowLeft');
    flushSync();
    expect(document.activeElement).toBe(selectedPills(container)[1]);
  });

  it('Home/End on a pill jump to the first/last pill', () => {
    const container = setup({
      values: ['Headache', 'Fatigue', 'Nausea'],
      options: ['Headache', 'Fatigue', 'Nausea'],
      onToggle: vi.fn(),
    });
    selectedPills(container)[1].focus();
    keydown(selectedPills(container)[1], 'End');
    flushSync();
    expect(document.activeElement).toBe(selectedPills(container)[2]);
    keydown(selectedPills(container)[2], 'Home');
    flushSync();
    expect(document.activeElement).toBe(selectedPills(container)[0]);
  });
});

describe('MultiPicker — contrast-aware pill text color', () => {
  it('chooses light text on a dark background', () => {
    const container = setup({
      values: ['Headache'],
      options: ['Headache', 'Fatigue'],
      optionColor: () => 'rgb(0, 0, 0)',
      onToggle: vi.fn(),
    });
    const pill = selectedPills(container)[0];
    expect(pill.style.color).toBeTruthy();
    // Light text: white (#ffffff) — accept either hex or rgb form.
    const c = pill.style.color.replace(/\s+/g, '').toLowerCase();
    expect(['#ffffff', 'rgb(255,255,255)', 'white']).toContain(c);
  });

  it('chooses dark text on a light background', () => {
    const container = setup({
      values: ['Headache'],
      options: ['Headache', 'Fatigue'],
      optionColor: () => 'rgb(255, 255, 255)',
      onToggle: vi.fn(),
    });
    const pill = selectedPills(container)[0];
    const c = pill.style.color.replace(/\s+/g, '').toLowerCase();
    expect(c).not.toBe('');
    expect(c).not.toBe('rgb(255,255,255)');
    expect(c).not.toBe('#ffffff');
    expect(c).not.toBe('white');
  });

  it('applies contrast color to dropdown options too', () => {
    const container = setup({
      values: [],
      options: ['Headache'],
      optionColor: () => '#000000',
      onToggle: vi.fn(),
    });
    chevron(container).click();
    flushSync();
    const opt = dropdownOptions(container)[0];
    expect(opt.style.color).toBeTruthy();
    const c = opt.style.color.replace(/\s+/g, '').toLowerCase();
    expect(['#ffffff', 'rgb(255,255,255)', 'white']).toContain(c);
  });

  it('skips foreground color when optionColor is not provided', () => {
    const container = setup({
      values: ['Headache'],
      options: ['Headache', 'Fatigue'],
      onToggle: vi.fn(),
    });
    const pill = selectedPills(container)[0];
    expect(pill.style.color).toBe('');
  });
});

describe('MultiPicker — reactive parent (harness)', () => {
  it('selecting the last available option focuses the chevron', async () => {
    const container = setupHarness({
      initialValues: [],
      options: ['Headache'],
    });
    chevron(container).click();
    await settle();
    dropdownOptions(container)[0].click();
    await settle();
    expect(menu(container)?.querySelector('.multi-picker-empty')).toBeTruthy();
    expect(document.activeElement).toBe(chevron(container));
  });

  it('removing the last pill focuses the chevron', async () => {
    const container = setupHarness({
      initialValues: ['Headache'],
      options: ['Headache'],
    });
    chevron(container).click();
    await settle();
    selectedPills(container)[0].click();
    await settle();
    expect(selectedPills(container).length).toBe(0);
    expect(document.activeElement).toBe(chevron(container));
  });

  it('selecting a middle option moves focus to the next remaining option', async () => {
    const container = setupHarness({
      initialValues: [],
      options: ['Headache', 'Fatigue', 'Nausea'],
    });
    chevron(container).click();
    await settle();
    dropdownOptions(container)[1].click();
    await settle();
    const remaining = dropdownOptions(container);
    expect(remaining.map((r) => r.textContent)).toEqual(['Headache', 'Nausea']);
    expect(document.activeElement).toBe(remaining[1]);
  });

  it('removing a middle pill moves focus to the next remaining pill', async () => {
    const container = setupHarness({
      initialValues: ['Headache', 'Fatigue', 'Nausea'],
      options: ['Headache', 'Fatigue', 'Nausea'],
    });
    chevron(container).click();
    await settle();
    selectedPills(container)[1].click();
    await settle();
    const pills = selectedPills(container);
    expect(pills.map((p) => p.textContent)).toEqual(['Headache', 'Nausea']);
    expect(document.activeElement).toBe(pills[1]);
  });
});
