/**
 * The arena: floor, walls, cargo the claw can pick up, obstacles the treads
 * bump into, and delivery zones. Also owns the IR raycast and the grab test,
 * because both need to know about everything in the pen.
 */

import { ARENA, CHASSIS, CLAW, IR, clamp } from './spec';
import { Robot } from './robot';
import { Scheduler } from './scheduler';
import { audio } from './audio';

export type CargoKind = 'crate' | 'barrel' | 'ball';

export interface Cargo {
  id: string;
  kind: CargoKind;
  x: number;
  z: number;
  y: number;
  radius: number;
  height: number;
  color: string;
  held: boolean;
  /** Spin, purely cosmetic, so pushed cargo looks alive. */
  spin: number;
}

export interface Obstacle {
  id: string;
  kind: 'cone' | 'block';
  x: number;
  z: number;
  radius: number;
  height: number;
  color: string;
}

export interface Zone {
  id: string;
  x: number;
  z: number;
  radius: number;
  color: string;
  label: string;
}

export interface ArenaSetup {
  robot?: { x: number; z: number; heading: number };
  cargo?: Array<Partial<Cargo> & { x: number; z: number }>;
  obstacles?: Array<Partial<Obstacle> & { x: number; z: number }>;
  zones?: Array<Partial<Zone> & { x: number; z: number }>;
}

type WorldEvent = 'grab' | 'drop' | 'bump' | 'deliver';

const CARGO_DEFAULTS: Record<CargoKind, { radius: number; height: number; color: string }> = {
  crate: { radius: 0.045, height: 0.075, color: '#35d0ff' },
  barrel: { radius: 0.04, height: 0.09, color: '#ff8a00' },
  ball: { radius: 0.038, height: 0.076, color: '#7a5cff' },
};

export class World {
  robot: Robot;
  cargo: Cargo[] = [];
  obstacles: Obstacle[] = [];
  zones: Zone[] = [];
  heldId: string | null = null;

  stats = { bumps: 0, grabs: 0, delivers: 0 };
  /** Sim time of the most recent bump, so blocks can ask "did I just hit something?". */
  lastBumpAt = -99;
  /** Bumped into something this instant — drives the "blocked" servo groan. */
  private bumpCooldown = 0;
  private listeners: Array<(ev: WorldEvent, data?: any) => void> = [];
  private seq = 0;

  constructor(public sched: Scheduler) {
    this.robot = new Robot(sched);
    this.loadSetup(sandboxSetup());
  }

  on(fn: (ev: WorldEvent, data?: any) => void): void {
    this.listeners.push(fn);
  }

  private emit(ev: WorldEvent, data?: any): void {
    this.listeners.forEach((l) => l(ev, data));
  }

  // ---------------------------------------------------------------- setup

  loadSetup(setup: ArenaSetup): void {
    const r = setup.robot ?? { x: 0, z: -0.85, heading: 0 };
    this.robot.reset(r.x, r.z, r.heading);
    this.heldId = null;
    this.stats = { bumps: 0, grabs: 0, delivers: 0 };

    this.cargo = (setup.cargo ?? []).map((c) => {
      const kind = (c.kind ?? 'crate') as CargoKind;
      const d = CARGO_DEFAULTS[kind];
      return {
        id: c.id ?? `cargo${this.seq++}`,
        kind,
        x: c.x,
        z: c.z,
        y: (c.height ?? d.height) / 2,
        radius: c.radius ?? d.radius,
        height: c.height ?? d.height,
        color: c.color ?? d.color,
        held: false,
        spin: 0,
      };
    });

    this.obstacles = (setup.obstacles ?? []).map((o) => ({
      id: o.id ?? `obs${this.seq++}`,
      kind: (o.kind ?? 'cone') as 'cone' | 'block',
      x: o.x,
      z: o.z,
      radius: o.radius ?? (o.kind === 'block' ? 0.1 : 0.055),
      height: o.height ?? (o.kind === 'block' ? 0.14 : 0.12),
      color: o.color ?? (o.kind === 'block' ? '#4a5568' : '#ff5a1f'),
    }));

    this.zones = (setup.zones ?? []).map((z) => ({
      id: z.id ?? `zone${this.seq++}`,
      x: z.x,
      z: z.z,
      radius: z.radius ?? 0.22,
      color: z.color ?? '#3ddc55',
      label: z.label ?? 'DROP',
    }));
  }

  // ---------------------------------------------------------------- tick

  update(dt: number): void {
    const bot = this.robot;
    bot.update(dt);

    // --- differential drive integration ---
    const { left, right } = bot.wheelSpeedMs;
    const v = (left + right) / 2;
    const omega = (right - left) / CHASSIS.trackWidth;

    const prevHeading = bot.heading;
    bot.heading += omega * dt;
    bot.headingTravel += Math.abs(omega * dt) * (180 / Math.PI);
    void prevHeading;

    const f = bot.forward;
    const nx = bot.x + f.x * v * dt;
    const nz = bot.z + f.z * v * dt;
    bot.x = nx;
    bot.z = nz;
    bot.odometer += Math.abs(v) * dt;

    // --- chassis vs walls ---
    let blocked = false;
    const lim = ARENA.half - CHASSIS.radius;
    if (bot.x > lim) { bot.x = lim; blocked = true; }
    if (bot.x < -lim) { bot.x = -lim; blocked = true; }
    if (bot.z > lim) { bot.z = lim; blocked = true; }
    if (bot.z < -lim) { bot.z = -lim; blocked = true; }

    // --- chassis vs static obstacles: obstacle wins, robot gets pushed out ---
    for (const o of this.obstacles) {
      const dx = bot.x - o.x;
      const dz = bot.z - o.z;
      const d = Math.hypot(dx, dz);
      const minD = CHASSIS.radius + o.radius;
      if (d < minD && d > 1e-6) {
        const push = (minD - d) / d;
        bot.x += dx * push;
        bot.z += dz * push;
        blocked = true;
      }
    }

    // --- chassis vs cargo: cargo is light, so it slides away ---
    for (const c of this.cargo) {
      if (c.held) continue;
      const dx = c.x - bot.x;
      const dz = c.z - bot.z;
      const d = Math.hypot(dx, dz);
      const minD = CHASSIS.radius + c.radius;
      if (d < minD && d > 1e-6) {
        const push = (minD - d) / d;
        c.x += dx * push;
        c.z += dz * push;
        c.spin += push * 6;
      }
    }

    bot.blocked = blocked;
    this.bumpCooldown = Math.max(0, this.bumpCooldown - dt);
    if (blocked && this.bumpCooldown === 0 && Math.abs(v) > 0.005) {
      this.bumpCooldown = 0.7;
      this.stats.bumps++;
      this.lastBumpAt = this.sched.time;
      this.emit('bump');
    }

    // --- cargo settling: keep it inside the pen and out of each other ---
    for (const c of this.cargo) {
      if (c.held) continue;
      const cl = ARENA.half - c.radius;
      c.x = clamp(c.x, -cl, cl);
      c.z = clamp(c.z, -cl, cl);
      c.spin *= 1 - Math.min(1, dt * 3);
      for (const o of this.obstacles) {
        const dx = c.x - o.x, dz = c.z - o.z;
        const d = Math.hypot(dx, dz), minD = c.radius + o.radius;
        if (d < minD && d > 1e-6) {
          c.x += (dx / d) * (minD - d);
          c.z += (dz / d) * (minD - d);
        }
      }
    }
    for (let i = 0; i < this.cargo.length; i++) {
      for (let j = i + 1; j < this.cargo.length; j++) {
        const a = this.cargo[i], b = this.cargo[j];
        if (a.held || b.held) continue;
        const dx = b.x - a.x, dz = b.z - a.z;
        const d = Math.hypot(dx, dz), minD = a.radius + b.radius;
        if (d < minD && d > 1e-6) {
          const p = (minD - d) / 2 / d;
          a.x -= dx * p; a.z -= dz * p;
          b.x += dx * p; b.z += dz * p;
        }
      }
    }

    this.updateGrip();
    this.robot.irDistance = this.readIR();
  }

  // ---------------------------------------------------------------- grabbing

  private updateGrip(): void {
    const bot = this.robot;
    const tip = bot.clawTip;

    if (this.heldId) {
      const held = this.cargo.find((c) => c.id === this.heldId);
      if (!held) { this.heldId = null; return; }
      if (!bot.isGripping) {
        // Released: the cargo drops straight down where the claw let go.
        held.held = false;
        held.y = held.height / 2;
        this.heldId = null;
        audio.play('drop');
        this.emit('drop', held);
        this.checkDelivery(held);
        return;
      }
      held.x = tip.x;
      held.z = tip.z;
      held.y = Math.max(held.height / 2, tip.y);
      return;
    }

    if (!bot.isGripping) return;
    // Claw just closed — is there anything between the fingers?
    for (const c of this.cargo) {
      if (c.held) continue;
      const d = Math.hypot(c.x - tip.x, c.z - tip.z);
      const vertical = Math.abs(tip.y - c.height / 2);
      if (d <= CLAW.grabRadius + c.radius && vertical < c.height * 0.9 + 0.03) {
        c.held = true;
        this.heldId = c.id;
        this.stats.grabs++;
        audio.play('grab');
        this.emit('grab', c);
        return;
      }
    }
  }

  private checkDelivery(c: Cargo): void {
    for (const z of this.zones) {
      if (Math.hypot(c.x - z.x, c.z - z.z) <= z.radius) {
        this.stats.delivers++;
        this.emit('deliver', { cargo: c, zone: z });
        return;
      }
    }
  }

  get heldCargo(): Cargo | null {
    return this.heldId ? this.cargo.find((c) => c.id === this.heldId) ?? null : null;
  }

  cargoInZone(zoneId: string): Cargo[] {
    const z = this.zones.find((q) => q.id === zoneId);
    if (!z) return [];
    return this.cargo.filter((c) => !c.held && Math.hypot(c.x - z.x, c.z - z.z) <= z.radius);
  }

  // ---------------------------------------------------------------- IR sensor

  /**
   * Fan a few rays across the sensor cone and report the nearest hit, in cm.
   * Saturates at IR.maxRange, which is what "nothing there" looks like.
   */
  readIR(): number {
    const o = this.robot.irOrigin;
    const base = this.robot.heading;
    let best = IR.maxRange / 100;

    for (const off of [-IR.coneDeg, -IR.coneDeg / 2, 0, IR.coneDeg / 2, IR.coneDeg]) {
      const a = base + (off * Math.PI) / 180;
      const dx = Math.sin(a);
      const dz = Math.cos(a);
      best = Math.min(best, this.castRay(o.x, o.z, dx, dz, o.y));
    }
    return clamp(best * 100, IR.minRange, IR.maxRange);
  }

  private castRay(ox: number, oz: number, dx: number, dz: number, eyeY: number): number {
    let best = Infinity;

    // Arena walls: the ray starts inside, so take the first boundary crossing.
    for (const [num, den] of [
      [ARENA.half - ox, dx],
      [-ARENA.half - ox, dx],
      [ARENA.half - oz, dz],
      [-ARENA.half - oz, dz],
    ] as Array<[number, number]>) {
      if (Math.abs(den) < 1e-9) continue;
      const t = num / den;
      if (t > 0) best = Math.min(best, t);
    }

    const circles: Array<{ x: number; z: number; r: number; h: number }> = [
      ...this.obstacles.map((o) => ({ x: o.x, z: o.z, r: o.radius, h: o.height })),
      ...this.cargo.filter((c) => !c.held).map((c) => ({ x: c.x, z: c.z, r: c.radius, h: c.height })),
    ];

    for (const c of circles) {
      // Too short to break the beam.
      if (c.h < eyeY * 0.7) continue;
      const fx = ox - c.x;
      const fz = oz - c.z;
      const b = 2 * (fx * dx + fz * dz);
      const cc = fx * fx + fz * fz - c.r * c.r;
      const disc = b * b - 4 * cc;
      if (disc < 0) continue;
      const sq = Math.sqrt(disc);
      const t1 = (-b - sq) / 2;
      const t2 = (-b + sq) / 2;
      const t = t1 > 0 ? t1 : t2;
      if (t > 0) best = Math.min(best, t);
    }

    return best;
  }

  /** True if the robot chassis is currently inside the given zone. */
  robotInZone(zoneId: string): boolean {
    const z = this.zones.find((q) => q.id === zoneId);
    if (!z) return false;
    return Math.hypot(this.robot.x - z.x, this.robot.z - z.z) <= z.radius;
  }
}

/** The free-play arena you get on load and on "reset". */
export function sandboxSetup(): ArenaSetup {
  return {
    robot: { x: 0, z: -0.85, heading: 0 },
    cargo: [
      { x: -0.35, z: 0.35, kind: 'crate' },
      { x: 0.35, z: 0.5, kind: 'barrel' },
      { x: 0.05, z: 0.15, kind: 'ball' },
      { x: 0.7, z: -0.3, kind: 'crate', color: '#3ddc55' },
    ],
    obstacles: [
      { x: -0.8, z: -0.1, kind: 'cone' },
      { x: 0.85, z: 0.85, kind: 'cone' },
      { x: -0.55, z: 0.9, kind: 'block' },
    ],
    zones: [{ x: 0.85, z: -0.9, radius: 0.24, color: '#ffc400', label: 'DROP' }],
  };
}
