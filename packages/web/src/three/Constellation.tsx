import { useEffect, useRef, useState } from 'react';
import { createConstellation, webglAvailable, type ConstellationHandle, type NodeSpec } from './constellation.ts';
import { useRouter } from '../lib/router.tsx';
import { Badge } from '../ui/kit.tsx';

/**
 * The 3D map, with an honest 2D fallback.
 *
 * If WebGL is missing the same nodes render as a grid of buttons carrying the
 * same numbers and the same links. Nothing is only reachable through the 3D
 * view, so losing it costs presentation, never capability. (spec 10 / 243)
 */
export function Constellation({ nodes }: { nodes: NodeSpec[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<ConstellationHandle | null>(null);
  const { navigate } = useRouter();
  const [supported] = useState(webglAvailable);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!supported || failed) return;
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const labels = labelRef.current;
    if (!wrap || !canvas || !labels) return;

    try {
      handleRef.current = createConstellation(wrap, canvas, labels, navigate);
    } catch (err) {
      // A driver that advertises WebGL and then throws is common enough on
      // older Windows laptops to be worth catching rather than white-screening.
      console.warn('[constellation] falling back to 2D:', err);
      setFailed(true);
      return;
    }
    return () => { handleRef.current?.dispose(); handleRef.current = null; };
  }, [supported, failed, navigate]);

  useEffect(() => { handleRef.current?.update(nodes); }, [nodes]);

  if (!supported || failed) return <NodeGrid nodes={nodes} note={!supported ? 'WebGL is unavailable on this device.' : 'The 3D view could not start on this device.'} />;

  return (
    <div className="relative">
      <div ref={wrapRef} className="cst-stage relative h-[380px] w-full overflow-hidden rounded-[14px] sm:h-[460px]">
        <canvas ref={canvasRef} className="block size-full" aria-hidden="true" />
        <div ref={labelRef} className="cst-layer" />
      </div>
      {/* The same information, in reading order, for assistive tech. The canvas
          above is aria-hidden, so this is the accessible version of the map. */}
      <ul className="sr-only">
        {nodes.map((n) => (
          <li key={n.id}>
            <a href={n.href}>{n.label}: {n.count ?? 'not measured'} ({n.severity})</a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NodeGrid({ nodes, note }: { nodes: NodeSpec[]; note: string }) {
  const { navigate } = useRouter();
  return (
    <div className="cst-stage rounded-[14px] p-4">
      <p className="mb-3 text-[12px]" style={{ color: 'var(--text-muted)' }}>
        {note} Showing the same map as a list &mdash; every number and link is identical.
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {nodes.map((n) => (
          <button
            key={n.id}
            onClick={() => navigate(n.href)}
            className="panel flex min-h-20 flex-col items-start justify-center gap-0.5 px-3 py-2.5 text-left transition-colors hover:brightness-110"
          >
            <span
              className="tabular text-xl font-semibold"
              style={{
                color: n.severity === 'critical' ? 'var(--color-crit-400)'
                  : n.severity === 'warning' ? 'var(--color-warn-400)'
                  : n.severity === 'ok' ? 'var(--color-teal-400)'
                  : 'var(--text-faint)',
              }}
            >
              {n.count ?? '—'}
            </span>
            <span className="text-[11px] font-semibold uppercase tracking-wide"
                  style={{ color: 'var(--text-muted)' }}>{n.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Legend, so the colour coding is stated rather than left to be inferred. */
export function ConstellationLegend() {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
      <span>Node size is the count.</span>
      <Badge tone="crit">needs action now</Badge>
      <Badge tone="warn">needs attention</Badge>
      <Badge tone="info">healthy</Badge>
      <Badge tone="neutral">nothing recorded</Badge>
    </div>
  );
}
