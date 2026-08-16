/** Small shared UI helpers: toasts, confetti, modals, and DOM shorthands. */

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

export const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  html?: string,
): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};

export function toast(msg: string, kind: 'info' | 'warn' | 'good' = 'info', ms = 2400): void {
  const host = $('toasts');
  const t = el('div', `toast ${kind === 'info' ? '' : kind}`, msg);
  host.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 320);
  }, ms);
}

export function showModal(id: string, on: boolean): void {
  $(id).hidden = !on;
}

/* ------------------------------------------------------------------ confetti */

interface Bit { x: number; y: number; vx: number; vy: number; rot: number; vr: number; c: string; s: number; }

let bits: Bit[] = [];
let raf = 0;

export function confetti(): void {
  const canvas = $('confetti') as HTMLCanvasElement;
  const dpr = Math.min(devicePixelRatio, 2);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  const g = canvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  const colors = ['#ffc400', '#ff8a00', '#35d0ff', '#3ddc55', '#7a5cff', '#ffffff'];
  for (let i = 0; i < 130; i++) {
    bits.push({
      x: innerWidth / 2 + (Math.random() - 0.5) * 260,
      y: innerHeight * 0.36 + (Math.random() - 0.5) * 90,
      vx: (Math.random() - 0.5) * 9,
      vy: -6 - Math.random() * 8,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.4,
      c: colors[(Math.random() * colors.length) | 0],
      s: 5 + Math.random() * 7,
    });
  }

  if (raf) return;
  const step = () => {
    g.clearRect(0, 0, innerWidth, innerHeight);
    bits = bits.filter((b) => b.y < innerHeight + 40);
    for (const b of bits) {
      b.vy += 0.32;
      b.vx *= 0.995;
      b.x += b.vx;
      b.y += b.vy;
      b.rot += b.vr;
      g.save();
      g.translate(b.x, b.y);
      g.rotate(b.rot);
      g.fillStyle = b.c;
      g.fillRect(-b.s / 2, -b.s / 4, b.s, b.s / 2);
      g.restore();
    }
    if (bits.length) {
      raf = requestAnimationFrame(step);
    } else {
      g.clearRect(0, 0, innerWidth, innerHeight);
      raf = 0;
    }
  };
  raf = requestAnimationFrame(step);
}

/* ------------------------------------------------------------------ storage */

export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota — carry on without persistence */
  }
}
