/**
 * The GrabberBot itself: four servos, an IR eye, an LED, and a battery.
 *
 * Servo map (matches how the kit is wired — IDs are printed on the servos):
 *   #1 left tread   — wheel mode
 *   #2 right tread  — wheel mode
 *   #3 arm boom     — joint mode
 *   #4 claw         — joint mode
 */

import { ARM, BATTERY, CHASSIS, CLAW, SERVO, SPEED_ORDER, WHEEL_SPEEDS, clamp, clawHalfGap, servoDegPerSecToMs } from './spec';
import type { SpeedPreset } from './spec';
import type { Scheduler } from './scheduler';
import { audio } from './audio';

export type DriveDir = 'forward' | 'backward' | 'left' | 'right';

/** A joint-mode servo travelling from one angle to another over a set time. */
interface JointMove {
  from: number;
  to: number;
  startedAt: number;
  durSec: number;
}

export class Robot {
  /** Position on the arena floor, metres. */
  x = 0;
  z = -0.75;
  /** Heading in radians; 0 means "forward" points along +Z. */
  heading = 0;

  /** Signed wheel-mode servo speeds, °/s. Positive drives that tread forward. */
  leftServoDeg = 0;
  rightServoDeg = 0;

  armAngle = 20;
  /** Where the claw actually is — may stall short of the command on an object. */
  clawAngle: number = CLAW.openAngle;
  /**
   * Where the claw was *told* to go. Grip intent lives here, because a servo
   * clamped on a crate is still gripping even though it never reached 0°.
   */
  clawCommand: number = CLAW.openAngle;
  /** Mechanical stop set by whatever is between the fingers. 0 = nothing. */
  clawBlockAngle = 0;
  private armMove: JointMove | null = null;
  private clawMove: JointMove | null = null;

  /** null = LED off. */
  ledColor: string | null = '#35d0ff';
  ledBlinkUntil = 0;

  /** Latest IR reading in cm; World refreshes this each tick. */
  irDistance = 80;

  batteryPct = 100;
  charging = false;

  speedPreset: SpeedPreset = 'normal';

  /** Cumulative heading change, so `turnBy` can measure a turn that wraps. */
  headingTravel = 0;
  /** Cumulative forward distance travelled, metres. */
  odometer = 0;
  /** Set by World when the chassis is jammed against a wall or obstacle. */
  blocked = false;

  constructor(private sched: Scheduler) {}

  // ---------------------------------------------------------------- geometry

  get forward(): { x: number; z: number } {
    return { x: Math.sin(this.heading), z: Math.cos(this.heading) };
  }

  /** World position of the IR sensor and the direction it looks. */
  get irOrigin(): { x: number; z: number; y: number } {
    const f = this.forward;
    return {
      x: this.x + f.x * CHASSIS.irOffset.forward,
      z: this.z + f.z * CHASSIS.irOffset.forward,
      y: CHASSIS.irOffset.up,
    };
  }

  /** World position of the point between the claw fingers. */
  get clawTip(): { x: number; z: number; y: number } {
    const rad = (this.armAngle * Math.PI) / 180;
    const fwd = 0.045 + ARM.reach * Math.cos(rad);
    const up = 0.1 + ARM.reach * Math.sin(rad);
    const f = this.forward;
    return { x: this.x + f.x * fwd, z: this.z + f.z * fwd, y: up };
  }

  /** True when the servo is *trying* to clamp, whether or not it got there. */
  get isGripping(): boolean {
    return this.clawCommand <= CLAW.gripAngle;
  }

  /** Half the distance between the grip pads right now, in metres. */
  get clawHalfGapM(): number {
    return clawHalfGap(this.clawAngle);
  }

  get wheelSpeedMs(): { left: number; right: number } {
    return {
      left: servoDegPerSecToMs(this.leftServoDeg),
      right: servoDegPerSecToMs(this.rightServoDeg),
    };
  }

  // ---------------------------------------------------------------- tick

  update(dt: number): void {
    this.stepJoint('arm', dt);
    this.stepJoint('claw', dt);

    // Battery: idle draw, plus servo draw proportional to what is moving.
    if (this.charging) {
      this.batteryPct = Math.min(100, this.batteryPct + BATTERY.chargePctPerSec * dt);
    } else {
      const wheelLoad = (Math.abs(this.leftServoDeg) + Math.abs(this.rightServoDeg)) / (2 * SERVO.maxDegPerSec);
      const jointLoad = (this.armMove ? 1 : 0) + (this.clawMove ? 1 : 0);
      const drain =
        BATTERY.idleDrainPctPerSec +
        wheelLoad * BATTERY.driveDrainPctPerSec +
        jointLoad * BATTERY.servoDrainPctPerSec;
      this.batteryPct = Math.max(0, this.batteryPct - drain * dt);
      // A flat pack cannot hold the servo bus up — the real bot goes limp too.
      if (this.batteryPct <= 0) this.setWheels(0, 0);
    }

    const load = this.batteryPct <= 0
      ? 0
      : Math.min(1, (Math.abs(this.leftServoDeg) + Math.abs(this.rightServoDeg)) / (2 * SERVO.maxDegPerSec));
    audio.setMotorLoad(this.blocked && load > 0 ? Math.min(1, load + 0.35) : load);
  }

  private stepJoint(which: 'arm' | 'claw', _dt: number): void {
    const mv = which === 'arm' ? this.armMove : this.clawMove;
    if (!mv) return;
    const t = mv.durSec <= 0 ? 1 : clamp((this.sched.time - mv.startedAt) / mv.durSec, 0, 1);
    // Ease in/out: real servos accelerate and settle, they do not step.
    const e = t * t * (3 - 2 * t);
    let angle = mv.from + (mv.to - mv.from) * e;

    if (which === 'arm') {
      this.armAngle = angle;
    } else {
      // The fingers cannot pass through whatever they are holding: the servo
      // stalls against it, exactly like the real one straining on a crate.
      if (angle < this.clawBlockAngle) angle = this.clawBlockAngle;
      this.clawAngle = angle;
    }

    if (t >= 1) {
      if (which === 'arm') this.armMove = null;
      else this.clawMove = null;
    }
  }

  /** Clamp the claw against a mechanical stop (an object between the pads). */
  setClawBlock(angle: number): void {
    this.clawBlockAngle = clamp(angle, CLAW.min, CLAW.max);
    if (this.clawAngle < this.clawBlockAngle) this.clawAngle = this.clawBlockAngle;
  }

  // ---------------------------------------------------------------- wheels

  setSpeedPreset(p: SpeedPreset): void {
    this.speedPreset = p;
  }

  cycleSpeed(delta: number): SpeedPreset {
    const i = clamp(SPEED_ORDER.indexOf(this.speedPreset) + delta, 0, SPEED_ORDER.length - 1);
    this.speedPreset = SPEED_ORDER[i];
    return this.speedPreset;
  }

  /** Direct tread control, in servo °/s (clamped to the servo's real ceiling). */
  setWheels(leftDeg: number, rightDeg: number): void {
    const lim = SERVO.maxDegPerSec;
    this.leftServoDeg = clamp(leftDeg, -lim, lim);
    this.rightServoDeg = clamp(rightDeg, -lim, lim);
  }

  /** Analogue drive from a joystick: both axes in -1..1. */
  setDriveAxes(driveAxis: number, turnAxis: number, preset = this.speedPreset): void {
    const top = WHEEL_SPEEDS[preset];
    let l = (driveAxis + turnAxis) * top;
    let r = (driveAxis - turnAxis) * top;
    const peak = Math.max(Math.abs(l), Math.abs(r));
    if (peak > top) {
      l = (l / peak) * top;
      r = (r / peak) * top;
    }
    this.setWheels(l, r);
  }

  driveDir(dir: DriveDir, preset = this.speedPreset): void {
    const s = WHEEL_SPEEDS[preset];
    switch (dir) {
      case 'forward': this.setWheels(s, s); break;
      case 'backward': this.setWheels(-s, -s); break;
      // Treads counter-rotate, so the bot spins on the spot like the real one.
      case 'left': this.setWheels(-s, s); break;
      case 'right': this.setWheels(s, -s); break;
    }
  }

  stopWheels(): void {
    this.setWheels(0, 0);
  }

  async driveFor(dir: DriveDir, seconds: number, preset = this.speedPreset): Promise<void> {
    this.driveDir(dir, preset);
    await this.sched.wait(clamp(seconds, 0, 120));
    this.stopWheels();
  }

  /** Spin in place until the heading has swept `degrees`, or we stall. */
  async turnBy(degrees: number, dir: 'left' | 'right', preset = this.speedPreset): Promise<void> {
    const target = Math.abs(degrees);
    if (target < 0.5) return;
    const start = this.headingTravel;
    this.driveDir(dir, preset);
    const deadline = this.sched.time + 30;
    await this.sched.waitUntil(
      () => Math.abs(this.headingTravel - start) >= target || this.sched.time > deadline,
    );
    this.stopWheels();
  }

  /** Drive straight until the odometer advances by `metres`. */
  async driveDistance(metres: number, preset = this.speedPreset): Promise<void> {
    const dir: DriveDir = metres >= 0 ? 'forward' : 'backward';
    const target = Math.abs(metres);
    const start = this.odometer;
    this.driveDir(dir, preset);
    const deadline = this.sched.time + 60;
    await this.sched.waitUntil(
      () => Math.abs(this.odometer - start) >= target || this.sched.time > deadline,
    );
    this.stopWheels();
  }

  // ---------------------------------------------------------------- joints

  /**
   * Joint-mode move. `ms` is clamped to the JIMU app's real 80–5000 ms window;
   * if the requested move is faster than the servo can physically slew, the
   * duration is stretched to what 600 °/s allows.
   */
  private startJoint(which: 'arm' | 'claw', to: number, ms: number): number {
    const from = which === 'arm' ? this.armAngle : this.clawAngle;
    const lo = which === 'arm' ? ARM.min : CLAW.min;
    const hi = which === 'arm' ? ARM.max : CLAW.max;
    const target = clamp(to, Math.max(lo, SERVO.jointMin), Math.min(hi, SERVO.jointMax));

    let dur = clamp(ms, SERVO.minMoveMs, SERVO.maxMoveMs);
    const needed = (Math.abs(target - from) / SERVO.maxDegPerSec) * 1000;
    if (needed > dur) dur = Math.min(SERVO.maxMoveMs, needed);

    const move: JointMove = { from, to: target, startedAt: this.sched.time, durSec: dur / 1000 };
    if (which === 'arm') {
      this.armMove = move;
    } else {
      this.clawMove = move;
      this.clawCommand = target;
      // Opening always releases the stop; it is re-applied once something is held.
      if (target > this.clawAngle) this.clawBlockAngle = 0;
    }
    return dur / 1000;
  }

  async moveArmTo(angle: number, ms = 700): Promise<void> {
    const dur = this.startJoint('arm', angle, ms);
    await this.sched.wait(dur);
  }

  async moveClawTo(angle: number, ms = 450): Promise<void> {
    const dur = this.startJoint('claw', angle, ms);
    await this.sched.wait(dur);
  }

  /** Instant set, used by the manual sliders where the user is the servo loop. */
  setArmImmediate(angle: number): void {
    this.armMove = null;
    this.armAngle = clamp(angle, ARM.min, ARM.max);
  }

  setClawImmediate(angle: number): void {
    this.clawMove = null;
    const target = clamp(angle, CLAW.min, CLAW.max);
    this.clawCommand = target;
    if (target > this.clawAngle) this.clawBlockAngle = 0;
    this.clawAngle = Math.max(target, this.clawBlockAngle);
  }

  openClaw(ms = 450): Promise<void> {
    return this.moveClawTo(CLAW.max, ms);
  }

  closeClaw(ms = 450): Promise<void> {
    return this.moveClawTo(0, ms);
  }

  get jointsBusy(): boolean {
    return !!(this.armMove || this.clawMove);
  }

  // ---------------------------------------------------------------- led

  setLed(color: string | null): void {
    this.ledColor = color;
  }

  async blinkLed(color: string, times: number, periodMs = 260): Promise<void> {
    const prev = this.ledColor;
    for (let i = 0; i < clamp(times, 1, 30); i++) {
      this.setLed(color);
      await this.sched.wait(periodMs / 2000);
      this.setLed(null);
      await this.sched.wait(periodMs / 2000);
    }
    this.setLed(prev);
  }

  // ---------------------------------------------------------------- reset

  reset(x = 0, z = -0.75, heading = 0): void {
    this.x = x;
    this.z = z;
    this.heading = heading;
    this.leftServoDeg = this.rightServoDeg = 0;
    this.armMove = this.clawMove = null;
    this.armAngle = 20;
    this.clawAngle = CLAW.openAngle as number;
    this.clawCommand = CLAW.openAngle as number;
    this.clawBlockAngle = 0;
    this.headingTravel = 0;
    this.odometer = 0;
    this.blocked = false;
  }
}
