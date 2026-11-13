import { useEffect, useRef } from 'react';

/** True when keystrokes should go to a form control instead of app shortcuts. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color'].includes(type);
  }
  return target.closest('[role="combobox"], [role="listbox"], [role="menu"]') !== null;
}

/** True while a modal dialog (other than ones marked data-hotkeys-allowed) is open. */
export function isModalOpen(): boolean {
  return document.querySelector('[role="dialog"][data-state="open"]:not([data-hotkeys-allowed])') !== null;
}

type HotkeyMap = Record<string, (e: KeyboardEvent) => void>;

interface Options {
  /** Allow the shortcuts even while a modal dialog is open. */
  allowInDialogs?: boolean;
  enabled?: boolean;
}

/**
 * Single-key app shortcuts ("n", "p", "/", "[", "]"). Ignored while typing in a field, with
 * modifier keys, or (by default) while a modal dialog is open.
 */
export function useHotkeys(map: HotkeyMap, options: Options = {}): void {
  const ref = useRef(map);
  ref.current = map;
  const { allowInDialogs = false, enabled = true } = options;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (!allowInDialogs && isModalOpen()) return;
      const handler = ref.current[e.key] ?? ref.current[e.key.toLowerCase()];
      if (handler) {
        e.preventDefault();
        handler(e);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [allowInDialogs, enabled]);
}
