/**
 * Top-down radar. Same data as the 3D view, but readable at a glance:
 * where the bot is pointing, what the IR beam is touching, where cargo sits.
 */

import { ARENA, CHASSIS, IR } from '../sim/spec';
import type { World } from '../sim/world';

export class Minimap {
  private ctx: CanvasRenderingContext2D;
  private size = 210;
  private trail: Array<{ x: number; z: number }> = [];
  private trailTimer = 0;

  constructor(private canvas: HTMLCanvasElement, private world: World) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  private resize(): void {
    const dpr = Math.min(devicePixelRatio, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.size = rect.width || 210;
    this.canvas.width = this.size * dpr;
    this.canvas.height = this.size * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** World metres -> canvas pixels. +Z (robot forward at heading 0) draws up. */
  private p(x: number, z: number): [number, number] {
    const pad = 10;
    const span = this.size - pad * 2;
    const s = span / (ARENA.half * 2);
    return [pad + (x + ARENA.half) * s, pad + (ARENA.half - z) * s];
  }

  private get scale(): number {
    return (this.size - 20) / (ARENA.half * 2);
  }

  draw(dt: number): void {
    const g = this.ctx;
    const bot = this.world.robot;
    const s = this.scale;

    this.trailTimer += dt;
    if (this.trailTimer > 0.12) {
      this.trailTimer = 0;
      this.trail.push({ x: bot.x, z: bot.z });
      if (this.trail.length > 90) this.trail.shift();
    }

    g.clearRect(0, 0, this.size, this.size);

    // floor + grid
    const [x0, y0] = this.p(-ARENA.half, ARENA.half);
    const side = ARENA.half * 2 * s;
    g.fillStyle = 'rgba(20, 27, 38, 0.9)';
    g.fillRect(x0, y0, side, side);
    g.strokeStyle = 'rgba(53, 208, 255, 0.13)';
    g.lineWidth = 1;
    for (let i = 1; i < 10; i++) {
      const t = (i / 10) * side;
      g.beginPath(); g.moveTo(x0 + t, y0); g.lineTo(x0 + t, y0 + side); g.stroke();
      g.beginPath(); g.moveTo(x0, y0 + t); g.lineTo(x0 + side, y0 + t); g.stroke();
    }
    g.strokeStyle = '#ffc400';
    g.lineWidth = 2;
    g.strokeRect(x0, y0, side, side);

    // zones
    for (const z of this.world.zones) {
      const [zx, zy] = this.p(z.x, z.z);
      g.beginPath();
      g.arc(zx, zy, z.radius * s, 0, Math.PI * 2);
      g.fillStyle = hexA(z.color, 0.16);
      g.fill();
      g.strokeStyle = z.color;
      g.lineWidth = 1.6;
      g.setLineDash([4, 3]);
      g.stroke();
      g.setLineDash([]);
    }

    // trail
    if (this.trail.length > 1) {
      g.beginPath();
      this.trail.forEach((t, i) => {
        const [tx, ty] = this.p(t.x, t.z);
        i ? g.lineTo(tx, ty) : g.moveTo(tx, ty);
      });
      g.strokeStyle = 'rgba(255, 196, 0, 0.3)';
      g.lineWidth = 1.5;
      g.stroke();
    }

    // obstacles
    for (const o of this.world.obstacles) {
      const [ox, oy] = this.p(o.x, o.z);
      g.beginPath();
      g.arc(ox, oy, Math.max(3, o.radius * s), 0, Math.PI * 2);
      g.fillStyle = o.color;
      g.fill();
    }

    // cargo
    for (const c of this.world.cargo) {
      const [cx, cy] = this.p(c.x, c.z);
      const r = Math.max(3, c.radius * s);
      g.fillStyle = c.color;
      if (c.kind === 'crate') {
        g.fillRect(cx - r, cy - r, r * 2, r * 2);
      } else {
        g.beginPath();
        g.arc(cx, cy, r, 0, Math.PI * 2);
        g.fill();
      }
      if (c.held) {
        g.strokeStyle = '#fff';
        g.lineWidth = 1.8;
        g.beginPath();
        g.arc(cx, cy, r + 3, 0, Math.PI * 2);
        g.stroke();
      }
    }

    // IR cone
    const io = bot.irOrigin;
    const [ix, iy] = this.p(io.x, io.z);
    const dist = (bot.irDistance / 100) * s;
    const a0 = bot.heading - (IR.coneDeg * Math.PI) / 180;
    const a1 = bot.heading + (IR.coneDeg * Math.PI) / 180;
    g.beginPath();
    g.moveTo(ix, iy);
    // Canvas y grows downward while world +z draws up, hence -cos/+sin swap.
    g.lineTo(ix + Math.sin(a0) * dist, iy - Math.cos(a0) * dist);
    g.lineTo(ix + Math.sin(a1) * dist, iy - Math.cos(a1) * dist);
    g.closePath();
    const near = bot.irDistance < 15;
    g.fillStyle = near ? 'rgba(255, 59, 59, 0.3)' : 'rgba(53, 208, 255, 0.22)';
    g.fill();

    // robot
    const [bx, by] = this.p(bot.x, bot.z);
    g.save();
    g.translate(bx, by);
    g.rotate(-bot.heading);
    const rl = CHASSIS.bodyLength * s;
    const rw = CHASSIS.bodyWidth * s;
    g.fillStyle = '#ffc400';
    g.strokeStyle = '#231a00';
    g.lineWidth = 1.4;
    g.beginPath();
    g.moveTo(0, -rl / 2 - 3);
    g.lineTo(rw / 2, rl / 2);
    g.lineTo(0, rl / 2 - 3);
    g.lineTo(-rw / 2, rl / 2);
    g.closePath();
    g.fill();
    g.stroke();
    if (bot.ledColor) {
      g.fillStyle = bot.ledColor;
      g.beginPath();
      g.arc(0, -rl / 2 + 1, 2.6, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();

    // scale caption
    g.fillStyle = 'rgba(148, 163, 184, 0.75)';
    g.font = '9px ui-monospace, monospace';
    g.fillText(`${(ARENA.half * 2).toFixed(1)} m arena`, x0 + 3, y0 + side + 8);
  }

  clearTrail(): void {
    this.trail = [];
  }
}

function hexA(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
