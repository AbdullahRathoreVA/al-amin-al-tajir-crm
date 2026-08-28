/**
 * A ~60 line router. react-router would work, but this app has nine routes and
 * no nested layouts, so the dependency would cost more than it saves.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

interface RouterValue {
  path: string;
  query: URLSearchParams;
  navigate(to: string, opts?: { replace?: boolean }): void;
}

const Ctx = createContext<RouterValue | null>(null);

export function RouterProvider({ children }: { children: ReactNode }) {
  const [href, setHref] = useState(() => window.location.pathname + window.location.search);

  useEffect(() => {
    const onPop = () => setHref(window.location.pathname + window.location.search);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to: string, opts?: { replace?: boolean }) => {
    if (to === window.location.pathname + window.location.search) return;
    window.history[opts?.replace ? 'replaceState' : 'pushState']({}, '', to);
    setHref(to);
    // Route changes must move the reader to the top, or a long list keeps its
    // old scroll position and the new page looks empty.
    window.scrollTo(0, 0);
  }, []);

  const value = useMemo<RouterValue>(() => {
    const [path = '/', qs = ''] = href.split('?');
    return { path, query: new URLSearchParams(qs), navigate };
  }, [href, navigate]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRouter(): RouterValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useRouter must be used inside RouterProvider');
  return v;
}

/** Anchor that keeps normal link behaviour: middle-click and ctrl-click still
 *  open a new tab, because taking that away is always wrong. */
export function Link(
  { to, children, className, ...rest }:
  { to: string; children: ReactNode; className?: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>,
) {
  const { navigate } = useRouter();
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

/** Matches '/families/:id' against the current path. */
export function useParams(pattern: string): Record<string, string> | null {
  const { path } = useRouter();
  const pp = pattern.split('/').filter(Boolean);
  const ap = path.split('/').filter(Boolean);
  if (pp.length !== ap.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    const p = pp[i]!;
    const a = ap[i]!;
    if (p.startsWith(':')) out[p.slice(1)] = decodeURIComponent(a);
    else if (p !== a) return null;
  }
  return out;
}
