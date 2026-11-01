// Per-browser conveniences only (panel sizes, last tab, drafts). Every access is
// guarded: storage may be unavailable and the UI must work without it.
// Never used for secrets or for settings that the backend owns.

const PREFIX = 'mazz.studio.';

export const prefs = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      if (value === undefined) localStorage.removeItem(PREFIX + key);
      else localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      // storage full or blocked: the preference is simply not remembered
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(PREFIX + key);
    } catch {
      // ignored
    }
  },
};
