import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api.ts';

export interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload(): void;
}

/** GET a path into state. Refetches when `path` changes. */
export function useApi<T>(path: string | null, deps: unknown[] = []): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [nonce, setNonce] = useState(0);
  // Guards against a slow first response overwriting a fast second one.
  const latest = useRef(0);

  useEffect(() => {
    if (!path) { setLoading(false); return; }
    const ticket = ++latest.current;
    setLoading(true);
    api.get<T>(path)
      .then((d) => { if (ticket === latest.current) { setData(d); setError(null); } })
      .catch((e: unknown) => {
        if (ticket !== latest.current) return;
        setError(e instanceof ApiError ? e.message : 'Something went wrong');
      })
      .finally(() => { if (ticket === latest.current) setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce, ...deps]);

  return { data, error, loading, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

/** Debounced value, for the search box. */
export function useDebounced<T>(value: T, ms = 180): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Polls while the tab is visible. Reminders are the point of this app, so the
 * numbers must not silently go stale - but polling a hidden tab is just heat.
 */
export function usePoll(fn: () => void, ms = 60_000): void {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    let id: number | undefined;
    const start = () => { stop(); id = window.setInterval(() => saved.current(), ms); };
    const stop = () => { if (id !== undefined) { clearInterval(id); id = undefined; } };
    const onVis = () => { if (document.hidden) stop(); else { saved.current(); start(); } };
    start();
    document.addEventListener('visibilitychange', onVis);
    return () => { stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [ms]);
}

export function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem('crm-theme');
    if (saved) return saved === 'dark';
    return !window.matchMedia('(prefers-color-scheme: light)').matches;
  });
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try { localStorage.setItem('crm-theme', dark ? 'dark' : 'light'); } catch { /* private mode */ }
  }, [dark]);
  return [dark, useCallback(() => setDark((d) => !d), [])];
}
