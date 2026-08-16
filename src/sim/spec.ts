/**
 * Hardware facts for the UBTECH JIMU GrabberBot (BuilderBots kit, JR0405).
 *
 * Sourced from the official JIMU manual + UBTECH product specs:
 *  - Servo joint mode: -120°..+120°, move time 80 ms .. 5000 ms
 *  - Servo wheel mode: continuous 360° CW/CCW, five speed presets
 *  - Servo rotation speed: 0.1 s / 60°  ->  600 °/s at full tilt
 *  - Servo torque 4 kg·cm, accuracy ~1° loaded
 *  - Control box: STM32F070, BT 3.0/4.0, 1200 mAh LiPo, 6.5-9.6 V, 1-2 A
 *  - GrabberBot: 4 servos (2 treads in wheel mode, arm + claw in joint mode),
 *    1 IR distance sensor, 1 RGB LED eye. No speaker on the box: the JIMU app
 *    plays sound from the phone, which is why sounds here come from WebAudio.
 */

export const SERVO = {
  /** Physical joint-mode limits of a JIMU servo. */
  jointMin: -120,
  jointMax: 120,
  /** Move-time limits the JIMU app enforces on a posture change. */
  minMoveMs: 80,
  maxMoveMs: 5000,
  /** 0.1 s per 60° => 600 °/s. */
  maxDegPerSec: 600,
  torqueKgCm: 4,
} as const;

/** The five wheel-mode speed presets, in servo °/s. */
export const WHEEL_SPEEDS = {
  vslow: 120,
  slow: 240,
  normal: 360,
  fast: 480,
  vfast: 600,
} as const;

export type SpeedPreset = keyof typeof WHEEL_SPEEDS;
export const SPEED_ORDER: SpeedPreset[] = ['vslow', 'slow', 'normal', 'fast', 'vfast'];
export const SPEED_LABEL: Record<SpeedPreset, string> = {
  vslow: 'Very slow',
  slow: 'Slow',
  normal: 'Normal',
  fast: 'Fast',
  vfast: 'Very fast',
};

/** GrabberBot chassis geometry, in metres. */
export const CHASSIS = {
  /** Drive sprocket radius — converts servo °/s into m/s at the tread. */
  wheelRadius: 0.022,
  /** Distance between the two treads (differential-drive track width). */
  trackWidth: 0.145,
  bodyLength: 0.215,
  bodyWidth: 0.165,
  /** Collision radius used for the chassis. */
  radius: 0.105,
  /** Where the IR sensor sits, relative to body centre (forward, up). */
  irOffset: { forward: 0.1, up: 0.055 },
} as const;

/** Mechanical travel of the arm and claw servos on this particular build. */
export const ARM = {
  min: -15,
  max: 75,
  /** Arm angle at which the claw sits on the floor. */
  floor: -15,
  carry: 45,
  /**
   * Shoulder pivot to the point between the fingertips. The three segment
   * lengths below sum to this, so the 3D model and the physics agree on
   * exactly where the claw closes.
   */
  reach: 0.22,
  boomLength: 0.105,
  forearmLength: 0.065,
} as const;

export const CLAW = {
  /** 0° = fully clamped, 70° = wide open. */
  min: 0,
  max: 70,
  /** Commanding at or below this angle means "clamp" — the grip intent. */
  gripAngle: 22,
  openAngle: 55,
  /** Reach of the grab check from the claw centre. */
  grabRadius: 0.062,

  // --- finger geometry, shared by the renderer and the grip solver ---
  /** Length of a finger, from its hinge to the tip. */
  fingerLength: 0.062,
  /** Sideways offset of each finger hinge from the claw centreline. */
  hingeOffsetX: 0.011,
  /**
   * Distance along the finger to the middle of the grip pad. Chosen so the pad
   * sits at ARM.reach when the claw is closed on typical cargo, which keeps the
   * rendered pads and the grab solver on the same point.
   */
  padDistance: 0.055,
  /** Finger swing at fully open, in radians. */
  maxSpreadRad: 0.85,
} as const;

/** Half the gap between the grip pads at a given claw angle, in metres. */
export function clawHalfGap(angle: number): number {
  const spread = (clamp(angle, CLAW.min, CLAW.max) / CLAW.max) * CLAW.maxSpreadRad;
  return CLAW.hingeOffsetX + CLAW.padDistance * Math.sin(spread);
}

/**
 * The claw angle at which the pads first touch something of this half-width —
 * i.e. where the servo stalls instead of closing further.
 */
export function clawAngleForHalfWidth(halfWidth: number): number {
  const s = (halfWidth - CLAW.hingeOffsetX) / CLAW.padDistance;
  if (s <= 0) return CLAW.min;
  const spread = Math.asin(Math.min(1, s));
  return clamp((spread / CLAW.maxSpreadRad) * CLAW.max, CLAW.min, CLAW.max);
}

/** IR distance sensor: reports centimetres, saturating at maxRange. */
export const IR = {
  minRange: 2,
  maxRange: 80,
  /** Half-angle of the sensor cone used for the fan of probe rays. */
  coneDeg: 7,
} as const;

export const BATTERY = {
  capacityMah: 1200,
  /** Simulated drain, in % per second, so a hard-driven bot fades believably. */
  idleDrainPctPerSec: 0.006,
  driveDrainPctPerSec: 0.05,
  servoDrainPctPerSec: 0.02,
  chargePctPerSec: 0.9,
} as const;

/** Arena is a square pen with low walls, in metres. */
export const ARENA = { half: 1.25, wallHeight: 0.11 } as const;

/** Convert a wheel-mode servo speed (°/s) into linear tread speed (m/s). */
export function servoDegPerSecToMs(degPerSec: number): number {
  return (degPerSec * Math.PI / 180) * CHASSIS.wheelRadius;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
