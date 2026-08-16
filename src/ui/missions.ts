/**
 * Missions: small, checkable goals that give the arena a point. Each one
 * rebuilds the pen, then watches world state every frame to decide progress.
 */

import type { ArenaSetup, World } from '../sim/world';
import { sandboxSetup } from '../sim/world';
import { audio } from '../sim/audio';
import { $, confetti, el, loadJSON, saveJSON, showModal } from './ui-kit';

export interface Mission {
  id: string;
  icon: string;
  title: string;
  desc: string;
  hint: string;
  setup(): ArenaSetup;
  /** Called every frame while active. `s` is per-attempt scratch state. */
  check(world: World, s: Record<string, number>, dt: number): { text: string; done: boolean };
}

export const MISSIONS: Mission[] = [
  {
    id: 'first-drive',
    icon: '🚗',
    title: 'First Drive',
    desc: 'Drive the GrabberBot onto the green pad.',
    hint: 'Try the joystick, or a “drive forward 100 cm” block.',
    setup: () => ({
      robot: { x: 0, z: -1, heading: 0 },
      zones: [{ x: 0, z: 0.8, radius: 0.26, color: '#3ddc55', label: 'GOAL' }],
      cargo: [],
      obstacles: [],
    }),
    check: (w) => {
      const z = w.zones[0];
      const d = Math.hypot(w.robot.x - z.x, w.robot.z - z.z);
      return {
        text: d <= z.radius ? 'On the pad!' : `${(d * 100).toFixed(0)} cm to go`,
        done: d <= z.radius,
      };
    },
  },

  {
    id: 'park',
    icon: '📏',
    title: 'Careful Parking',
    desc: 'Stop with the IR sensor reading between 8 and 12 cm from the wall — and hold it for 2 seconds.',
    hint: 'Drive forward, then “wait until object closer than 12 cm”, then stop the treads.',
    setup: () => ({
      robot: { x: 0, z: -1, heading: 0 },
      obstacles: [{ x: 0, z: 0.75, kind: 'block', radius: 0.34, height: 0.2, color: '#4a5568' }],
      cargo: [],
      zones: [],
    }),
    check: (w, s, dt) => {
      const ir = w.robot.irDistance;
      const still = Math.abs(w.robot.leftServoDeg) < 1 && Math.abs(w.robot.rightServoDeg) < 1;
      const inBand = ir >= 8 && ir <= 12;
      s.hold = inBand && still ? (s.hold ?? 0) + dt : 0;
      if (s.hold >= 2) return { text: 'Parked perfectly!', done: true };
      if (inBand && still) return { text: `Hold it… ${(2 - s.hold).toFixed(1)}s`, done: false };
      return { text: `IR ${ir.toFixed(1)} cm — need 8–12 cm, stopped`, done: false };
    },
  },

  {
    id: 'deliver',
    icon: '📦',
    title: 'Grab & Deliver',
    desc: 'Pick up the blue crate and drop it inside the yellow zone.',
    hint: 'Open the claw, put the arm on the floor, drive up to the crate, then grab and carry.',
    setup: () => ({
      robot: { x: -0.7, z: -0.7, heading: Math.PI / 4 },
      cargo: [{ x: 0.15, z: 0.15, kind: 'crate', color: '#35d0ff', id: 'target' }],
      zones: [{ x: 0.85, z: -0.85, radius: 0.26, color: '#ffc400', label: 'DROP' }],
      obstacles: [],
    }),
    check: (w) => {
      const c = w.cargo.find((x) => x.id === 'target');
      const z = w.zones[0];
      if (!c) return { text: '—', done: false };
      const d = Math.hypot(c.x - z.x, c.z - z.z);
      if (!c.held && d <= z.radius) return { text: 'Delivered!', done: true };
      if (c.held) return { text: `Carrying — ${(d * 100).toFixed(0)} cm to the zone`, done: false };
      return { text: 'Grab the blue crate', done: false };
    },
  },

  {
    id: 'slalom',
    icon: '🚧',
    title: 'Cone Slalom',
    desc: 'Reach the far pad without bumping into anything.',
    hint: 'Short drives and 90° turns are easier to control than one long run.',
    setup: () => ({
      robot: { x: -0.95, z: -0.95, heading: 0 },
      obstacles: [
        { x: -0.95, z: -0.2, kind: 'cone' },
        { x: -0.3, z: 0.25, kind: 'cone' },
        { x: 0.3, z: -0.25, kind: 'cone' },
        { x: 0.35, z: 0.7, kind: 'cone' },
        { x: -0.4, z: -0.6, kind: 'cone' },
      ],
      zones: [{ x: 0.95, z: 0.95, radius: 0.24, color: '#3ddc55', label: 'GOAL' }],
      cargo: [],
    }),
    check: (w) => {
      const z = w.zones[0];
      const d = Math.hypot(w.robot.x - z.x, w.robot.z - z.z);
      if (d <= z.radius && w.stats.bumps === 0) return { text: 'Clean run!', done: true };
      if (d <= z.radius) return { text: `Made it, but ${w.stats.bumps} bump(s) — reset to try clean`, done: false };
      return { text: `${(d * 100).toFixed(0)} cm to go · ${w.stats.bumps} bump(s)`, done: false };
    },
  },

  {
    id: 'nightshift',
    icon: '🌙',
    title: 'Night Shift',
    desc: 'Deliver BOTH barrels to the drop zone. Keep the LED on so the crew can see you.',
    hint: 'A “repeat 2” loop with your grab-and-carry blocks inside saves a lot of dragging.',
    setup: () => ({
      robot: { x: 0, z: -1, heading: 0 },
      cargo: [
        { x: -0.55, z: 0.5, kind: 'barrel', id: 'b1' },
        { x: 0.55, z: 0.5, kind: 'barrel', id: 'b2' },
      ],
      zones: [{ x: 0, z: -0.55, radius: 0.3, color: '#ffc400', label: 'DROP' }],
      obstacles: [{ x: 0, z: 0.95, kind: 'cone' }],
    }),
    check: (w) => {
      const z = w.zones[0];
      const inZone = w.cargo.filter((c) => !c.held && Math.hypot(c.x - z.x, c.z - z.z) <= z.radius).length;
      const lit = w.robot.ledColor !== null;
      if (inZone === 2 && lit) return { text: 'Both delivered, lights on!', done: true };
      if (inZone === 2) return { text: 'Both delivered — now turn the LED on', done: false };
      return { text: `${inZone}/2 delivered${lit ? '' : ' · LED is off!'}`, done: false };
    },
  },
];

export class MissionTab {
  active: Mission | null = null;
  private state: Record<string, number> = {};
  private completed: string[] = loadJSON<string[]>('gbs.missions.v1', []);
  onArenaChange?: () => void;

  constructor(private world: World) {
    this.render();
    $('mbAbort').onclick = () => this.stop();
    $('winClose').onclick = () => showModal('winModal', false);
  }

  private render(): void {
    const list = $('missionList');
    list.innerHTML = '';
    for (const m of MISSIONS) {
      const done = this.completed.includes(m.id);
      const row = el('div', `mission${done ? ' done' : ''}${this.active?.id === m.id ? ' active' : ''}`);
      row.innerHTML = `
        <div class="m-icon">${m.icon}</div>
        <div class="m-text"><b>${m.title}</b><span>${m.desc}</span></div>
        <div class="m-badge">${done ? '✅' : '▶'}</div>`;
      row.onclick = () => this.start(m);
      list.appendChild(row);
    }

    const sandbox = el('div', 'mission');
    sandbox.innerHTML = `
      <div class="m-icon">🧪</div>
      <div class="m-text"><b>Free play</b><span>Back to the sandbox arena — crates, barrels, cones and a drop zone.</span></div>
      <div class="m-badge">↺</div>`;
    sandbox.onclick = () => {
      this.stop();
      this.world.loadSetup(sandboxSetup());
      this.onArenaChange?.();
    };
    list.appendChild(sandbox);
  }

  start(m: Mission): void {
    this.active = m;
    this.state = {};
    this.world.loadSetup(m.setup());
    this.onArenaChange?.();

    $('missionBanner').hidden = false;
    $('mbIcon').textContent = m.icon;
    $('mbTitle').textContent = m.title;
    $('mbProgress').textContent = m.hint;
    this.render();
  }

  stop(): void {
    this.active = null;
    $('missionBanner').hidden = true;
    this.render();
  }

  /** Re-run the current mission's setup (the reset button). */
  resetActive(): boolean {
    if (!this.active) return false;
    this.state = {};
    this.world.loadSetup(this.active.setup());
    this.onArenaChange?.();
    return true;
  }

  update(dt: number): void {
    if (!this.active) return;
    const res = this.active.check(this.world, this.state, dt);
    $('mbProgress').textContent = res.text;
    if (!res.done) return;

    const m = this.active;
    this.stop();
    if (!this.completed.includes(m.id)) {
      this.completed.push(m.id);
      saveJSON('gbs.missions.v1', this.completed);
    }
    audio.play('win');
    confetti();
    $('winTitle').textContent = `${m.icon}  ${m.title} complete!`;
    $('winBody').textContent = m.desc;
    showModal('winModal', true);
    this.render();
  }
}
