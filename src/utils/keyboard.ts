/**
 * Keyboard Shortcuts Manager
 */

export type KeyboardCallback = () => void;

export interface ShortcutModifiers {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

export interface ShortcutBinding {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  callback: KeyboardCallback;
}

class KeyboardShortcutManager {
  private bindings: Map<string, ShortcutBinding> = new Map();

  register(
    shortcutKey: string,
    callback: KeyboardCallback,
    options?: ShortcutModifiers
  ): void {
    const id = this.generateId(shortcutKey, options);
    this.bindings.set(id, { key: shortcutKey, ...options, callback });
  }

  unregister(shortcutKey: string, options?: ShortcutModifiers): void {
    this.bindings.delete(this.generateId(shortcutKey, options));
  }

  handleKeyDown(event: KeyboardEvent): void {
    for (const binding of this.bindings.values()) {
      if (
        event.key.toLowerCase() === binding.key.toLowerCase() &&
        event.ctrlKey === (binding.ctrl || false) &&
        event.shiftKey === (binding.shift || false) &&
        event.altKey === (binding.alt || false) &&
        event.metaKey === (binding.meta || false)
      ) {
        event.preventDefault();
        binding.callback();
        break;
      }
    }
  }

  parseShortcut(shortcutStr: string): {
    key: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean;
  } {
    const parts = shortcutStr.toLowerCase().split("+");
    const result = { key: "", ctrl: false, shift: false, alt: false, meta: false };
    for (const part of parts) {
      switch (part) {
        case "ctrl":  result.ctrl  = true; break;
        case "shift": result.shift = true; break;
        case "alt":   result.alt   = true; break;
        case "meta":
        case "cmd":   result.meta  = true; break;
        default:      result.key   = part;
      }
    }
    return result;
  }

  private generateId(shortcutKey: string, options?: ShortcutModifiers): string {
    const parts = [shortcutKey];
    if (options?.ctrl)  parts.push("ctrl");
    if (options?.shift) parts.push("shift");
    if (options?.alt)   parts.push("alt");
    if (options?.meta)  parts.push("meta");
    return parts.join("+");
  }

  clear(): void { this.bindings.clear(); }
  getBindings(): ShortcutBinding[] { return Array.from(this.bindings.values()); }
}

export const keyboardShortcutManager = new KeyboardShortcutManager();

let _keyboardInitialized = false

export function initializeKeyboardShortcuts(): void {
  if (_keyboardInitialized) return
  _keyboardInitialized = true
  window.addEventListener("keydown", (event) => {
    keyboardShortcutManager.handleKeyDown(event);
  });
}

export function registerDefaultShortcuts(callbacks: Record<string, () => void>): void {
  const defaultShortcuts: Record<string, string> = {
    "ctrl+s": "save",
    "ctrl+,": "settings",
  };

  for (const [shortcut, action] of Object.entries(defaultShortcuts)) {
    const callback = callbacks[action];
    if (callback) {
      const parsed = keyboardShortcutManager.parseShortcut(shortcut);
      keyboardShortcutManager.register(parsed.key, callback, {
        ctrl: parsed.ctrl,
        shift: parsed.shift,
        alt: parsed.alt,
        meta: parsed.meta,
      });
    }
  }
}
