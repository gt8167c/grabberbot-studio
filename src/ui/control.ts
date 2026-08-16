/**
 * The Drive tab: joystick, arm/claw servos, LED, sound board, action buttons
 * and the telemetry read-out. This is the "hold the robot in your hands" tab.
 */

import { ARM, CLAW, SPEED_LABEL, SPEED_ORDER, WHEEL_SPEEDS, clamp } from '../sim/spec';
import type { SpeedPreset } from '../sim/spec';
import type { World } from '../sim/world';
import { audio } from '../sim/audio';
import type { SoundName } from '../sim/audio';
import type { ActionStore } from './actions';
import { $, el, toast } from './ui-kit';

export class ControlTab {
  /** Joystick / keyboard axes, both -1..1. */
  private driveAxis = 0;
  private turnAxis = 0;
  private keys = new Set<string>();
  private slotPickIndex: number | null = null;
  private irHistory: number[] = [];
  private irTimer = 0;
  /** True while a program or action owns the wheels, so we don't fight it. */
  externalDriveOwner = false;

  constructor(private world: World, private actions: ActionStore) {
    this.mountJoystick();
    this.mountSpeed();
    this.mountArmClaw();
    this.mountLed();
    this.mountSounds();
    this.mountSlots();
    this.mountKeyboard();

    $('stopAllBtn').onclick = () => {
      this.driveAxis = this.turnAxis = 0;
      this.resetKnob();
      this.world.robot.stopWheels();
      this.actions.stop();
      window.dispatchEvent(new CustomEvent('gbs:stop-all'));
      toast('All stop', 'warn', 1200);
    };
  }

  // ---------------------------------------------------------------- joystick

  private resetKnob(): void {
    $('joyKnob').style.transform = 'translate(0px, 0px)';
  }

  private mountJoystick(): void {
    const pad = $('joystick');
    const knob = $('joyKnob');
    const maxR = 46;
    let active = false;

    const setFrom = (clientX: number, clientY: number) => {
      const r = pad.getBoundingClientRect();
      let dx = clientX - (r.left + r.width / 2);
      let dy = clientY - (r.top + r.height / 2);
      const d = Math.hypot(dx, dy);
      if (d > maxR) {
        dx = (dx / d) * maxR;
        dy = (dy / d) * maxR;
      }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      this.driveAxis = clamp(-dy / maxR, -1, 1);
      this.turnAxis = clamp(dx / maxR, -1, 1);
    };

    pad.addEventListener('pointerdown', (e) => {
      active = true;
      pad.setPointerCapture(e.pointerId);
      pad.classList.add('dragging');
      setFrom(e.clientX, e.clientY);
    });
    pad.addEventListener('pointermove', (e) => {
      if (active) setFrom(e.clientX, e.clientY);
    });
    const end = (e: PointerEvent) => {
      if (!active) return;
      active = false;
      pad.classList.remove('dragging');
      try { pad.releasePointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      this.driveAxis = this.turnAxis = 0;
      this.resetKnob();
    };
    pad.addEventListener('pointerup', end);
    pad.addEventListener('pointercancel', end);
  }

  private mountSpeed(): void {
    const host = $('speedPresets');
    host.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        const p = (b as HTMLElement).dataset.speed as SpeedPreset;
        this.world.robot.setSpeedPreset(p);
        this.refreshSpeed();
        toast(`Wheel speed: ${SPEED_LABEL[p]} (${WHEEL_SPEEDS[p]} °/s)`, 'info', 1400);
      });
    });
    this.refreshSpeed();
  }

  refreshSpeed(): void {
    const cur = this.world.robot.speedPreset;
    $('speedPresets').querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', (b as HTMLElement).dataset.speed === cur);
    });
  }

  // ---------------------------------------------------------------- arm/claw

  private mountArmClaw(): void {
    const arm = $<HTMLInputElement>('armSlider');
    const claw = $<HTMLInputElement>('clawSlider');
    arm.min = String(ARM.min);
    arm.max = String(ARM.max);
    claw.min = String(CLAW.min);
    claw.max = String(CLAW.max);

    arm.oninput = () => this.world.robot.setArmImmediate(Number(arm.value));
    claw.oninput = () => this.world.robot.setClawImmediate(Number(claw.value));

    $('armUpBtn').onclick = () => void this.world.robot.moveArmTo(ARM.carry, 700);
    $('armDownBtn').onclick = () => void this.world.robot.moveArmTo(ARM.floor, 800);
    $('clawOpenBtn').onclick = () => void this.world.robot.openClaw();
    $('clawGrabBtn').onclick = () => void this.world.robot.closeClaw();
  }

  // ---------------------------------------------------------------- led/sound

  private mountLed(): void {
    const host = $('ledSwatches');
    host.querySelectorAll('.swatch').forEach((s) => {
      s.addEventListener('click', () => {
        const c = (s as HTMLElement).dataset.color!;
        this.world.robot.setLed(c === 'off' ? null : c);
        host.querySelectorAll('.swatch').forEach((x) => x.classList.remove('sel'));
        s.classList.add('sel');
      });
    });
  }

  private mountSounds(): void {
    document.querySelectorAll('.sound-row .btn').forEach((b) => {
      b.addEventListener('click', () => audio.play((b as HTMLElement).dataset.sound as SoundName));
    });
  }

  // ---------------------------------------------------------------- slots

  private mountSlots(): void {
    $('slotEditBtn').onclick = () => {
      this.slotPickIndex = this.slotPickIndex === null ? -1 : null;
      toast(this.slotPickIndex === null ? 'Done editing' : 'Tap a button to reassign it', 'info', 1800);
      this.renderSlots();
    };
    this.renderSlots();
  }

  renderSlots(): void {
    const grid = $('slotGrid');
    grid.innerHTML = '';
    this.actions.slots.forEach((id, i) => {
      const a = this.actions.get(id);
      const btn = el('button', `slot${a ? '' : ' empty'}${this.actions.playing === id ? ' playing' : ''}${this.slotPickIndex !== null ? ' picking' : ''}`);
      btn.innerHTML = a ? `${a.icon}<span>${a.name}</span>` : `<span style="font-size:15px">＋</span>`;
      btn.onclick = () => {
        if (this.slotPickIndex !== null) {
          this.cycleSlot(i);
          return;
        }
        if (!a) {
          toast('Empty button — press ✏️ edit to assign an action', 'warn');
          return;
        }
        if (this.actions.playing === a.id) this.actions.stop();
        else void this.actions.play(a.id);
      };
      grid.appendChild(btn);
    });
  }

  /** In edit mode a tap steps the slot through the available actions. */
  private cycleSlot(index: number): void {
    const ids: (string | null)[] = [null, ...this.actions.actions.filter((a) => !a.id.startsWith('__')).map((a) => a.id)];
    const cur = ids.indexOf(this.actions.slots[index] ?? null);
    const next = ids[(cur + 1) % ids.length];
    this.actions.assignSlot(index, next);
    this.renderSlots();
  }

  // ---------------------------------------------------------------- keyboard

  private mountKeyboard(): void {
    const isTyping = (t: EventTarget | null) => {
      const n = t as HTMLElement | null;
      return !!n && (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.isContentEditable);
    };

    addEventListener('keydown', (e) => {
      if (isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if (DRIVE_KEYS.has(k)) {
        this.keys.add(k);
        e.preventDefault();
      }
      if (k === ' ') {
        e.preventDefault();
        $('stopAllBtn').click();
      }
      if (k === 'q') void this.world.robot.openClaw();
      if (k === 'e') void this.world.robot.closeClaw();
      if (k === 'r') void this.world.robot.moveArmTo(ARM.carry, 600);
      if (k === 'f') void this.world.robot.moveArmTo(ARM.floor, 700);
      if (k === '[') { this.world.robot.cycleSpeed(-1); this.refreshSpeed(); }
      if (k === ']') { this.world.robot.cycleSpeed(1); this.refreshSpeed(); }
    });

    addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    addEventListener('blur', () => this.keys.clear());
  }

  // ---------------------------------------------------------------- per-frame

  update(dt: number): void {
    let drive = this.driveAxis;
    let turn = this.turnAxis;

    if (this.keys.has('w') || this.keys.has('arrowup')) drive += 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) drive -= 1;
    if (this.keys.has('a') || this.keys.has('arrowleft')) turn -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) turn += 1;
    drive = clamp(drive, -1, 1);
    turn = clamp(turn, -1, 1);

    // Manual input always wins — grabbing the stick takes the wheels back.
    // Releasing it only stops the treads if *we* were the ones driving, so a
    // running program or action keeps its own hold on the wheels.
    const manual = Math.abs(drive) > 0.02 || Math.abs(turn) > 0.02;
    if (manual) {
      this.world.robot.setDriveAxes(drive, turn);
      this.wasManual = true;
    } else if (this.wasManual) {
      this.world.robot.stopWheels();
      this.wasManual = false;
    }

    this.updateTelemetry(dt);
  }

  private wasManual = false;

  private updateTelemetry(dt: number): void {
    const bot = this.world.robot;

    $('armVal').textContent = `${Math.round(bot.armAngle)}°`;
    $('clawVal').textContent = `${Math.round(bot.clawAngle)}°`;
    const armSlider = $<HTMLInputElement>('armSlider');
    const clawSlider = $<HTMLInputElement>('clawSlider');
    if (document.activeElement !== armSlider) armSlider.value = String(Math.round(bot.armAngle));
    if (document.activeElement !== clawSlider) clawSlider.value = String(Math.round(bot.clawAngle));

    $('sv1').textContent = `${Math.round(bot.leftServoDeg)}°/s`;
    $('sv2').textContent = `${Math.round(bot.rightServoDeg)}°/s`;
    $('sv3').textContent = `${Math.round(bot.armAngle)}°`;
    $('sv4').textContent = `${Math.round(bot.clawAngle)}°${bot.isGripping ? ' 🤏' : ''}`;

    const irEl = $('irValue');
    const d = bot.irDistance;
    irEl.textContent = d >= 79.5 ? '— no target' : `${d.toFixed(1)} cm`;
    irEl.classList.toggle('near', d < 15);

    this.irTimer += dt;
    if (this.irTimer > 0.05) {
      this.irTimer = 0;
      this.irHistory.push(d);
      if (this.irHistory.length > 110) this.irHistory.shift();
      this.drawSpark();
    }
  }

  private drawSpark(): void {
    const c = $<HTMLCanvasElement>('irSpark');
    const dpr = Math.min(devicePixelRatio, 2);
    const w = c.clientWidth || 220;
    const h = 44;
    if (c.width !== w * dpr) {
      c.width = w * dpr;
      c.height = h * dpr;
    }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    g.strokeStyle = 'rgba(255,255,255,0.07)';
    g.lineWidth = 1;
    [0.25, 0.5, 0.75].forEach((f) => {
      g.beginPath();
      g.moveTo(0, h * f);
      g.lineTo(w, h * f);
      g.stroke();
    });

    if (this.irHistory.length < 2) return;
    const n = this.irHistory.length;
    g.beginPath();
    this.irHistory.forEach((v, i) => {
      const x = (i / (n - 1)) * w;
      const y = h - (clamp(v, 0, 80) / 80) * (h - 3) - 1.5;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    });
    const last = this.irHistory[n - 1];
    g.strokeStyle = last < 15 ? '#ff4d4d' : '#35d0ff';
    g.lineWidth = 1.8;
    g.stroke();

    g.lineTo(w, h);
    g.lineTo(0, h);
    g.closePath();
    g.fillStyle = last < 15 ? 'rgba(255,77,77,0.14)' : 'rgba(53,208,255,0.12)';
    g.fill();
  }
}

const DRIVE_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);

export { SPEED_ORDER };
