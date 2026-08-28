/**
 * The 3D command map.
 *
 * Ten nodes orbiting a centre, one per system area, sized and coloured by real
 * counts. It is a navigation surface and a status read, not decoration: node
 * size is the count, the ring colour is the worst severity in that area, and
 * clicking a node opens that module.
 *
 * Rules it holds to:
 *   - it never renders when it cannot be seen (tab hidden, scrolled off);
 *   - it honours prefers-reduced-motion by not animating at all;
 *   - every GPU resource it makes, it disposes;
 *   - labels are real DOM, so they are crisp, translatable and screen-readable.
 * (spec 128 / 129 / 130 / 245 / 253)
 */
import * as THREE from 'three';

export interface NodeSpec {
  id: string;
  label: string;
  count: number | null;
  severity: 'critical' | 'warning' | 'ok' | 'idle';
  href: string;
}

export type Quality = 'high' | 'balanced' | 'low';

const SEVERITY_COLOR: Record<NodeSpec['severity'], number> = {
  critical: 0xe8735f,
  warning: 0xe5a93f,
  ok: 0x4fa896,
  idle: 0x6a6785,
};

export function detectQuality(): Quality {
  const mem = (navigator as { deviceMemory?: number }).deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 8;
  const narrow = window.innerWidth < 768;
  if (narrow || mem <= 4 || cores <= 4) return 'low';
  if (mem <= 8 || cores <= 8) return 'balanced';
  return 'high';
}

export function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch { return false; }
}

interface NodeObject {
  spec: NodeSpec;
  mesh: THREE.Mesh;
  ring: THREE.Line;
  angle: number;
  radius: number;
  y: number;
  labelEl: HTMLButtonElement;
}

export interface ConstellationHandle {
  update(nodes: NodeSpec[]): void;
  setQuality(q: Quality): void;
  resize(): void;
  dispose(): void;
}

export function createConstellation(
  container: HTMLElement,
  canvas: HTMLCanvasElement,
  labelLayer: HTMLElement,
  onSelect: (href: string) => void,
): ConstellationHandle {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let quality = detectQuality();

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(0, 3.4, 9.2);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: quality !== 'low', alpha: true, powerPreference: 'low-power',
  });
  renderer.setClearColor(0x000000, 0);

  // Tracked so dispose() can be exhaustive rather than hopeful.
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(x: T): T => { disposables.push(x); return x; };

  // ------------------------------------------------------------- lighting
  // Deliberately simple: one key, one fill, one ambient. No shadow maps -
  // shadows on abstract nodes cost frames and communicate nothing. (spec 256/257)
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.DirectionalLight(0xfff2e8, 1.15);
  key.position.set(4, 6, 5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x8fa8ff, 0.35);
  fill.position.set(-5, -2, -4);
  scene.add(fill);

  // --------------------------------------------------------------- centre
  const coreGeo = track(new THREE.IcosahedronGeometry(0.62, 3));
  const coreMat = track(new THREE.MeshStandardMaterial({
    color: 0xf2be4c, emissive: 0xc9922a, emissiveIntensity: 0.42,
    roughness: 0.32, metalness: 0.15,
  }));
  const core = new THREE.Mesh(coreGeo, coreMat);
  scene.add(core);

  // One soft halo. The single place glow is allowed. (spec 230 / 231)
  const haloGeo = track(new THREE.SphereGeometry(0.95, 24, 24));
  const haloMat = track(new THREE.MeshBasicMaterial({
    color: 0xf2be4c, transparent: true, opacity: 0.07, side: THREE.BackSide, depthWrite: false,
  }));
  scene.add(new THREE.Mesh(haloGeo, haloMat));

  // ------------------------------------------------------------ starfield
  let stars: THREE.Points | null = null;
  function buildStars(): void {
    if (stars) { scene.remove(stars); stars.geometry.dispose(); (stars.material as THREE.Material).dispose(); }
    const n = quality === 'high' ? 420 : quality === 'balanced' ? 220 : 90;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      // Shell, not a cube: keeps them behind the nodes rather than inside them.
      const r = 16 + Math.random() * 12;
      const t = Math.random() * Math.PI * 2;
      const p = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(p) * Math.cos(t);
      pos[i * 3 + 1] = r * Math.cos(p) * 0.55;
      pos[i * 3 + 2] = r * Math.sin(p) * Math.sin(t);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({ color: 0xfdf8f2, size: 0.075, transparent: true, opacity: 0.5 });
    stars = new THREE.Points(g, m);
    scene.add(stars);
  }
  buildStars();

  // ---------------------------------------------------------------- nodes
  const nodeGeo = track(new THREE.SphereGeometry(1, 20, 20));
  const nodes: NodeObject[] = [];
  const spokes = new THREE.Group();
  scene.add(spokes);

  function ringGeometry(radius: number): THREE.BufferGeometry {
    const segments = quality === 'low' ? 48 : 96;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
  }

  function clearNodes(): void {
    for (const n of nodes) {
      scene.remove(n.mesh);
      (n.mesh.material as THREE.Material).dispose();
      scene.remove(n.ring);
      n.ring.geometry.dispose();
      (n.ring.material as THREE.Material).dispose();
      n.labelEl.remove();
    }
    nodes.length = 0;
    for (const child of [...spokes.children]) {
      spokes.remove(child);
      (child as THREE.Line).geometry.dispose();
      ((child as THREE.Line).material as THREE.Material).dispose();
    }
  }

  function build(specs: NodeSpec[]): void {
    clearNodes();
    const max = Math.max(1, ...specs.map((s) => s.count ?? 0));

    specs.forEach((spec, i) => {
      // Two orbital shells so ten nodes do not collide at one radius. (spec 12)
      const shell = i % 2;
      const radius = shell === 0 ? 3.1 : 4.5;
      const inShell = specs.filter((_, j) => j % 2 === shell).length;
      const indexInShell = Math.floor(i / 2);
      const angle = (indexInShell / Math.max(1, inShell)) * Math.PI * 2 + (shell ? 0.4 : 0);
      const y = shell === 0 ? 0.28 : -0.42;

      // Size carries the count, but stays inside a readable band: a node with
      // 400 records must not swallow the screen. sqrt keeps big numbers legible.
      const t = (spec.count ?? 0) / max;
      const scale = 0.2 + Math.sqrt(t) * 0.26;

      const color = SEVERITY_COLOR[spec.severity];
      const mat = new THREE.MeshStandardMaterial({
        color, roughness: 0.42, metalness: 0.08,
        emissive: color, emissiveIntensity: spec.severity === 'idle' ? 0.05 : 0.2,
      });
      const mesh = new THREE.Mesh(nodeGeo, mat);
      mesh.scale.setScalar(scale);
      mesh.userData.href = spec.href;
      scene.add(mesh);

      const ringMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.13 });
      const ring = new THREE.Line(ringGeometry(radius), ringMat);
      ring.position.y = y;
      scene.add(ring);

      const spokeMat = new THREE.LineBasicMaterial({
        color: 0xfdf8f2, transparent: true, opacity: 0.07,
      });
      const spokeGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0),
      ]);
      spokes.add(new THREE.Line(spokeGeo, spokeMat));

      // Real button, real text. Keyboard-reachable and screen-reader-visible
      // without a WebGL context existing at all. (spec 126 / 247)
      const labelEl = document.createElement('button');
      labelEl.type = 'button';
      labelEl.className = 'cst-label';
      labelEl.dataset.severity = spec.severity;
      labelEl.innerHTML =
        `<span class="cst-label__n">${spec.count ?? '&mdash;'}</span>` +
        `<span class="cst-label__t">${spec.label}</span>`;
      labelEl.setAttribute('aria-label',
        `${spec.label}: ${spec.count ?? 'not measured'}. Open ${spec.label}.`);
      labelEl.addEventListener('click', () => onSelect(spec.href));
      labelLayer.appendChild(labelEl);

      nodes.push({ spec, mesh, ring, angle, radius, y, labelEl });
    });
  }

  // ------------------------------------------------------------- interaction
  const ray = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let hovered: NodeObject | null = null;

  function pointerMove(e: PointerEvent): void {
    const r = canvas.getBoundingClientRect();
    pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  }
  function pointerClick(): void {
    if (hovered) onSelect(hovered.spec.href);
  }
  canvas.addEventListener('pointermove', pointerMove);
  canvas.addEventListener('click', pointerClick);

  // ------------------------------------------------------------- run loop
  let raf = 0;
  let running = false;
  let visible = true;
  let spin = 0;
  let last = performance.now();

  const io = new IntersectionObserver(
    ([entry]) => { visible = entry?.isIntersecting ?? true; visible ? start() : stop(); },
    { threshold: 0.01 },
  );
  io.observe(container);

  function onVisibility(): void {
    document.hidden ? stop() : (visible && start());
  }
  document.addEventListener('visibilitychange', onVisibility);

  function frame(now: number): void {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (!reduceMotion) {
      // Slow enough to read as "alive", not as "spinning". (spec 12)
      spin += dt * 0.055;
      core.rotation.y += dt * 0.12;
      if (stars) stars.rotation.y += dt * 0.006;
    }

    const spokeChildren = spokes.children as THREE.Line[];
    nodes.forEach((n, i) => {
      const a = n.angle + spin * (n.radius < 4 ? 1 : -0.62);
      n.mesh.position.set(Math.cos(a) * n.radius, n.y, Math.sin(a) * n.radius);

      const spoke = spokeChildren[i];
      if (spoke) {
        const p = spoke.geometry.attributes.position as THREE.BufferAttribute;
        p.setXYZ(1, n.mesh.position.x, n.mesh.position.y, n.mesh.position.z);
        p.needsUpdate = true;
      }
    });

    // Hover test after positions are final, so the highlight cannot lag a frame.
    ray.setFromCamera(pointer, camera);
    const hits = ray.intersectObjects(nodes.map((n) => n.mesh), false);
    const hit = hits[0]?.object;
    const next = hit ? nodes.find((n) => n.mesh === hit) ?? null : null;
    if (next !== hovered) {
      hovered?.labelEl.classList.remove('is-hover');
      next?.labelEl.classList.add('is-hover');
      hovered = next;
      canvas.style.cursor = next ? 'pointer' : 'default';
    }

    // Project each node to screen space and place its DOM label there.
    const rect = canvas.getBoundingClientRect();
    for (const n of nodes) {
      const v = n.mesh.position.clone().project(camera);
      const x = (v.x * 0.5 + 0.5) * rect.width;
      const y = (-v.y * 0.5 + 0.5) * rect.height;
      n.labelEl.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0) translate(-50%, -50%)`;
      // Fade the ones behind the core so the front row stays readable.
      const depth = (v.z + 1) / 2;
      n.labelEl.style.opacity = String(Math.max(0.35, 1.25 - depth * 1.3));
      n.labelEl.style.zIndex = String(Math.round((1 - depth) * 100));
    }

    renderer.render(scene, camera);
  }

  function start(): void {
    if (running || document.hidden || !visible) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function stop(): void {
    if (!running) return;
    running = false;
    cancelAnimationFrame(raf);
  }

  function resize(): void {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    const cap = quality === 'high' ? 2 : quality === 'balanced' ? 1.5 : 1;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // One frame on resize even while paused, so it is never a blank box.
    if (!running) renderer.render(scene, camera);
  }

  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();
  start();

  return {
    update(specs) { build(specs); resize(); },
    setQuality(q) { quality = q; buildStars(); resize(); },
    resize,
    dispose() {
      stop();
      io.disconnect();
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('pointermove', pointerMove);
      canvas.removeEventListener('click', pointerClick);
      clearNodes();
      if (stars) {
        scene.remove(stars);
        stars.geometry.dispose();
        (stars.material as THREE.Material).dispose();
        stars = null;
      }
      for (const d of disposables) d.dispose();
      renderer.dispose();
      // Frees the GPU context immediately instead of waiting for GC, which
      // matters when the operator navigates in and out of the dashboard.
      renderer.forceContextLoss();
      scene.clear();
    },
  };
}
