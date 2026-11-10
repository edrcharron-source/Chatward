// The lebai home page's ASCII black hole (Gargantua style), ported from lebai on lebserver so the Lebserver skin
// matches it exactly. Each character cell gets one photon traced backwards through a Schwarzschild-like bending
// (M = 1, horizon r = 2, photon sphere r = 3) once per resize; frames only animate the disk texture, so drawing is
// cheap. Decoration only: aria-hidden, no controls. Stops when the window is hidden and draws one still frame when the
// system asks for reduced motion.
import { useEffect, useRef } from 'react';
import './lebai.css';

const RAMP = ' .\u00b7:-=+*#%@';
const RIN = 5, ROUT = 14, DIST = 34, TILT = 10 * Math.PI / 180, SPAN = 13.5, SPIN = 5;
// cream, butter, peach, coral, dim coral, ring blue, mint
const RGB = [[255, 250, 240], [242, 220, 143], [244, 185, 143], [242, 162, 145], [150, 98, 90], [159, 196, 232], [169, 220, 191]];
const AL = 8;
const STYLE = RGB.map((c) => Array.from({ length: AL }, (_, k) => `rgba(${c[0]},${c[1]},${c[2]},${((k + 1) / AL).toFixed(3)})`));

type Hit = { type: 0; minR: number; vx: number; vy: number; vz: number } | { type: 1 } | { type: 2; r: number; phi: number; vx: number; vy: number; vz: number };
interface DiskCell { x: number; y: number; r: number; phi: number; base: number; col: number; w: number }
interface RingCell { x: number; y: number; q: number; s: number }

// trace() is lebai's, unchanged apart from types.
function trace(px: number, py: number, pz: number, vx: number, vy: number, vz: number): Hit {
  const hx = py * vz - pz * vy, hy = pz * vx - px * vz, hz = px * vy - py * vx, k = -1.5 * (hx * hx + hy * hy + hz * hz);
  let r = Math.hypot(px, py, pz), minR = r;
  let f = k / (r ** 5), ax = f * px, ay = f * py, az = f * pz;
  for (let s = 0; s < 4000; s++) {
    const dt = Math.min(1.2, 0.018 * r * r);
    const ox = px, oy = py, oz = pz;
    px += vx * dt + 0.5 * ax * dt * dt; py += vy * dt + 0.5 * ay * dt * dt; pz += vz * dt + 0.5 * az * dt * dt;
    r = Math.hypot(px, py, pz);
    f = k / (r ** 5);
    const bx = f * px, by = f * py, bz = f * pz;
    vx += 0.5 * (ax + bx) * dt; vy += 0.5 * (ay + by) * dt; vz += 0.5 * (az + bz) * dt;
    ax = bx; ay = by; az = bz;
    if (r < minR) minR = r;
    if ((oy > 0) !== (py > 0)) {                       // crossed the disk plane
      const t = oy / (oy - py), x = ox + (px - ox) * t, z = oz + (pz - oz) * t, rc = Math.hypot(x, z);
      if (rc >= RIN && rc <= ROUT) { const n = Math.hypot(vx, vy, vz); return { type: 2, r: rc, phi: Math.atan2(z, x), vx: vx / n, vy: vy / n, vz: vz / n }; }
    }
    if (r < 2.02) return { type: 1 };
    if (r > DIST * 1.5 && px * vx + py * vy + pz * vz > 0) { const n = Math.hypot(vx, vy, vz); return { type: 0, minR, vx: vx / n, vy: vy / n, vz: vz / n }; }
  }
  return { type: 1 };
}


export function LebaiBlackHole({ maxHeight = 0.5 }: { maxHeight?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const cx = cv?.getContext('2d');
    if (!cv || !cx) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const buckets: Array<Array<number | string>> = Array.from({ length: RGB.length * AL }, () => []);
    let cols = 0, rows = 0, CW = 0, CH = 0, disk: DiskCell[] = [], ring: RingCell[] = [], hole: number[] = [];
    let built = false, timer: ReturnType<typeof setTimeout> | null = null, raf = 0, alive = true;
    const font = () => { cx.font = `600 ${(CH * 0.78).toFixed(1)}px 'JetBrains Mono', Consolas, monospace`; cx.textAlign = 'center'; cx.textBaseline = 'middle'; };

    function build(): boolean {
      const W = Math.min(cv!.parentElement?.clientWidth ?? 0, 1000);
      if (!W) return false;
      cols = W < 480 ? 64 : W < 760 ? 92 : 120; rows = Math.round(cols * 0.29);
      CW = Math.min(W / cols, innerHeight * maxHeight / (rows * 2)); CH = CW * 2;
      const dpr = Math.min(devicePixelRatio || 1, 2);
      cv!.width = Math.round(cols * CW * dpr); cv!.height = Math.round(rows * CH * dpr);
      cv!.style.width = cols * CW + 'px'; cv!.style.height = rows * CH + 'px';
      cx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      font();
      // camera a little above the disk plane, looking at the hole
      const cy = DIST * Math.sin(TILT), cz = -DIST * Math.cos(TILT);
      const fx = 0, fy = -cy / DIST, fz = -cz / DIST;                                  // forward
      const rx = 1, ry = 0, rz = 0;                                                    // right
      const ux = fy * rz - fz * ry, uy = fz * rx - fx * rz, uz = fx * ry - fy * rx;   // up = forward x right
      const su = 2 * SPAN / cols, sv = su * CH / CW;
      disk = []; ring = []; hole = [];
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const u = (i + 0.5 - cols / 2) * su, v = -(j + 0.5 - rows / 2) * sv + 0.7;
        const dx = fx * DIST + rx * u + ux * v, dy = fy * DIST + ry * u + uy * v, dz = fz * DIST + rz * u + uz * v;
        const n = Math.hypot(dx, dy, dz);
        const h = trace(0, cy, cz, dx / n, dy / n, dz / n), x = (i + 0.5) * CW, y = (j + 0.5) * CH;
        if (h.type === 1) hole.push(i, j);
        else if (h.type === 2) {
          // Doppler beaming: orbit velocity (counter-clockwise seen from above) against the photon direction
          const beta = 0.62 / Math.sqrt(h.r), bx = -Math.sin(h.phi) * beta, bz = Math.cos(h.phi) * beta;
          const g = Math.sqrt(1 - beta * beta) / (1 + bx * h.vx + bz * h.vz);
          const edge = Math.min(1, (ROUT - h.r) / 4), inner = Math.min(1, (h.r - RIN) / 0.6 + 0.35);
          const base = Math.min(1.6, 1.25 * (RIN / h.r) ** 0.8 * g ** 2.4 * edge * inner);
          const tr = (h.r - RIN) / (ROUT - RIN);
          disk.push({ x, y, r: h.r, phi: h.phi, base, col: tr < 0.1 ? 0 : tr < 0.26 ? 1 : tr < 0.48 ? 2 : tr < 0.75 ? 3 : 4, w: SPIN * h.r ** -1.5 });
        } else {
          const q = 1 - (h.minR - 3) / 0.32;
          if (q > 0) ring.push({ x, y, q: Math.min(1, q), s: (i * 7 + j * 13) % 17 });
        }
      }
      built = true;
      return true;
    }

    function draw(ms: number) {
      const t = reduce ? 0 : ms / 1000;
      cx!.clearRect(0, 0, cols * CW, rows * CH);
      cx!.fillStyle = '#000';
      for (let k = 0; k < hole.length; k += 2) cx!.fillRect(hole[k] * CW - 0.5, hole[k + 1] * CH - 0.5, CW + 1, CH + 1);
      for (const b of buckets) b.length = 0;
      const L = RAMP.length - 1;
      for (const c of disk) {
        const p = c.phi - t * c.w;
        const tex = 0.55 + 0.22 * Math.sin(7 * p + 2.1 * c.r) + 0.18 * Math.sin(17 * p - 1.3 * c.r + 2 * Math.sin(3 * p)) + 0.1 * Math.sin(41 * p + 5 * c.r);
        const b = Math.max(0, Math.min(1, c.base * (0.45 + 0.75 * tex)));
        if (b < 0.05) continue;
        buckets[c.col * AL + Math.min(AL - 1, (0.2 + 0.85 * b) * AL | 0)].push(c.x, c.y, RAMP[Math.max(1, Math.round(b * L))]);
      }
      for (const c of ring) {
        const q = c.q * (0.8 + 0.2 * Math.sin(t * 1.7 + c.s));
        buckets[(q > 0.75 ? 6 : 5) * AL + Math.min(AL - 1, (0.25 + 0.75 * q) * AL | 0)].push(c.x, c.y, q > 0.7 ? 'o' : q > 0.4 ? '\u00b7' : '.');
      }
      for (let k = 0; k < buckets.length; k++) {
        const b = buckets[k];
        if (!b.length) continue;
        cx!.fillStyle = STYLE[k / AL | 0][k % AL];
        for (let n = 0; n < b.length; n += 3) cx!.fillText(b[n + 2] as string, b[n] as number, b[n + 1] as number);
      }
    }

    function loop(ms: number) {
      timer = null;
      if (!alive || document.hidden) return;
      draw(ms);
      if (!reduce) timer = setTimeout(() => { raf = requestAnimationFrame(loop); }, 33);
    }
    function start() {
      if (!built && !build()) return;
      if (reduce) { draw(0); return; }
      if (!timer) raf = requestAnimationFrame(loop);
    }
    const onVisible = () => { if (!document.hidden) start(); };
    let rz: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => { if (rz) clearTimeout(rz); rz = setTimeout(() => { built = false; start(); }, 200); };
    document.addEventListener('visibilitychange', onVisible);
    addEventListener('resize', onResize);
    raf = requestAnimationFrame(start);
    void document.fonts?.ready.then(() => { if (alive && built) { font(); if (reduce) draw(0); } });
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
      if (rz) clearTimeout(rz);
      document.removeEventListener('visibilitychange', onVisible);
      removeEventListener('resize', onResize);
    };
  }, [maxHeight]);
  return <canvas ref={ref} className="cw-lebai-hole" aria-hidden="true" />;
}

/** The LEBSERVER pixel wordmark from lebai. */
export function LebaiLogo() {
  return (
            <svg className="cw-lebai-logo" viewBox="0 0 125 16" role="img" aria-label="LEBSERVER" shapeRendering="crispEdges"><defs><linearGradient id="cwLbGrad" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="16"><stop offset="0" stopColor="#fffaf0"/><stop offset=".26" stopColor="#f2dc8f"/><stop offset=".58" stopColor="#f4b98f"/><stop offset=".9" stopColor="#f2a291"/><stop offset="1" stopColor="#e0968a"/></linearGradient></defs><g fill="url(#cwLbGrad)"><rect x="0" y="0.45" width="6" height="1.1"/><rect x="1" y="2.45" width="4" height="1.1"/><rect x="1" y="4.45" width="4" height="1.1"/><rect x="1" y="6.45" width="4" height="1.1"/><rect x="1" y="8.45" width="4" height="1.1"/><rect x="1" y="10.45" width="4" height="1.1"/><rect x="1" y="12.45" width="4" height="1.1"/><rect x="9" y="12.45" width="2" height="1.1"/><rect x="0" y="14.45" width="11" height="1.1"/><rect x="14" y="0.45" width="11" height="1.1"/><rect x="15" y="2.45" width="4" height="1.1"/><rect x="23" y="2.45" width="2" height="1.1"/><rect x="15" y="4.45" width="4" height="1.1"/><rect x="15" y="6.45" width="8" height="1.1"/><rect x="15" y="8.45" width="8" height="1.1"/><rect x="15" y="10.45" width="4" height="1.1"/><rect x="15" y="12.45" width="4" height="1.1"/><rect x="23" y="12.45" width="2" height="1.1"/><rect x="14" y="14.45" width="11" height="1.1"/><rect x="28" y="0.45" width="10" height="1.1"/><rect x="29" y="2.45" width="4" height="1.1"/><rect x="35" y="2.45" width="4" height="1.1"/><rect x="29" y="4.45" width="4" height="1.1"/><rect x="35" y="4.45" width="4" height="1.1"/><rect x="29" y="6.45" width="9" height="1.1"/><rect x="29" y="8.45" width="9" height="1.1"/><rect x="29" y="10.45" width="4" height="1.1"/><rect x="35" y="10.45" width="4" height="1.1"/><rect x="29" y="12.45" width="4" height="1.1"/><rect x="35" y="12.45" width="4" height="1.1"/><rect x="28" y="14.45" width="10" height="1.1"/><rect x="43" y="0.45" width="10" height="1.1"/><rect x="42" y="2.45" width="5" height="1.1"/><rect x="51" y="2.45" width="2" height="1.1"/><rect x="42" y="4.45" width="5" height="1.1"/><rect x="43" y="6.45" width="9" height="1.1"/><rect x="48" y="8.45" width="5" height="1.1"/><rect x="48" y="10.45" width="5" height="1.1"/><rect x="42" y="12.45" width="2" height="1.1"/><rect x="48" y="12.45" width="5" height="1.1"/><rect x="42" y="14.45" width="10" height="1.1"/><rect x="56" y="0.45" width="11" height="1.1"/><rect x="57" y="2.45" width="4" height="1.1"/><rect x="65" y="2.45" width="2" height="1.1"/><rect x="57" y="4.45" width="4" height="1.1"/><rect x="57" y="6.45" width="8" height="1.1"/><rect x="57" y="8.45" width="8" height="1.1"/><rect x="57" y="10.45" width="4" height="1.1"/><rect x="57" y="12.45" width="4" height="1.1"/><rect x="65" y="12.45" width="2" height="1.1"/><rect x="56" y="14.45" width="11" height="1.1"/><rect x="70" y="0.45" width="10" height="1.1"/><rect x="71" y="2.45" width="4" height="1.1"/><rect x="77" y="2.45" width="4" height="1.1"/><rect x="71" y="4.45" width="4" height="1.1"/><rect x="77" y="4.45" width="4" height="1.1"/><rect x="71" y="6.45" width="9" height="1.1"/><rect x="71" y="8.45" width="4" height="1.1"/><rect x="76" y="8.45" width="4" height="1.1"/><rect x="71" y="10.45" width="4" height="1.1"/><rect x="77" y="10.45" width="4" height="1.1"/><rect x="71" y="12.45" width="4" height="1.1"/><rect x="77" y="12.45" width="4" height="1.1"/><rect x="70" y="14.45" width="6" height="1.1"/><rect x="77" y="14.45" width="4" height="1.1"/><rect x="84" y="0.45" width="5" height="1.1"/><rect x="92" y="0.45" width="5" height="1.1"/><rect x="85" y="2.45" width="4" height="1.1"/><rect x="92" y="2.45" width="4" height="1.1"/><rect x="85" y="4.45" width="4" height="1.1"/><rect x="92" y="4.45" width="4" height="1.1"/><rect x="86" y="6.45" width="4" height="1.1"/><rect x="91" y="6.45" width="4" height="1.1"/><rect x="86" y="8.45" width="4" height="1.1"/><rect x="91" y="8.45" width="4" height="1.1"/><rect x="87" y="10.45" width="7" height="1.1"/><rect x="87" y="12.45" width="7" height="1.1"/><rect x="88" y="14.45" width="5" height="1.1"/><rect x="100" y="0.45" width="11" height="1.1"/><rect x="101" y="2.45" width="4" height="1.1"/><rect x="109" y="2.45" width="2" height="1.1"/><rect x="101" y="4.45" width="4" height="1.1"/><rect x="101" y="6.45" width="8" height="1.1"/><rect x="101" y="8.45" width="8" height="1.1"/><rect x="101" y="10.45" width="4" height="1.1"/><rect x="101" y="12.45" width="4" height="1.1"/><rect x="109" y="12.45" width="2" height="1.1"/><rect x="100" y="14.45" width="11" height="1.1"/><rect x="114" y="0.45" width="10" height="1.1"/><rect x="115" y="2.45" width="4" height="1.1"/><rect x="121" y="2.45" width="4" height="1.1"/><rect x="115" y="4.45" width="4" height="1.1"/><rect x="121" y="4.45" width="4" height="1.1"/><rect x="115" y="6.45" width="9" height="1.1"/><rect x="115" y="8.45" width="4" height="1.1"/><rect x="120" y="8.45" width="4" height="1.1"/><rect x="115" y="10.45" width="4" height="1.1"/><rect x="121" y="10.45" width="4" height="1.1"/><rect x="115" y="12.45" width="4" height="1.1"/><rect x="121" y="12.45" width="4" height="1.1"/><rect x="114" y="14.45" width="6" height="1.1"/><rect x="121" y="14.45" width="4" height="1.1"/></g></svg>
  );
}
