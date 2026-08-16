/**
 * Walks the block tree directly instead of generating JavaScript. That buys
 * three things Scratch users expect: live block highlighting, an instant stop
 * that unwinds cleanly, and hat blocks running concurrently.
 */

import * as Blockly from 'blockly';
import { ARM, CLAW, clamp } from '../sim/spec';
import type { SpeedPreset } from '../sim/spec';
import type { DriveDir } from '../sim/robot';
import type { World } from '../sim/world';
import type { Scheduler } from '../sim/scheduler';
import { AbortedError } from '../sim/scheduler';
import { audio } from '../sim/audio';
import type { SoundName } from '../sim/audio';
import type { ActionStore } from './actions';

const ARM_POSE_ANGLE: Record<string, number> = { up: 70, carry: ARM.carry, floor: ARM.floor };

export class ProgramRunner {
  running = false;
  onStateChange?: (running: boolean) => void;
  /** Highlighting costs a repaint per block; turbo skips it. */
  turbo = false;

  private token = 0;
  private vars = new Map<string, unknown>();
  private ws: Blockly.WorkspaceSvg | null = null;

  constructor(
    private world: World,
    private sched: Scheduler,
    private actions: ActionStore,
  ) {}

  // ---------------------------------------------------------------- lifecycle

  async run(ws: Blockly.WorkspaceSvg): Promise<void> {
    this.stop();
    const token = ++this.token;
    this.ws = ws;
    this.vars.clear();
    this.running = true;
    this.onStateChange?.(true);

    const tops = ws.getTopBlocks(true).filter((b) => b.isEnabled());
    const flagHats = tops.filter((b) => b.type === 'gb_when_flag');
    const irHats = tops.filter((b) => b.type === 'gb_when_ir_below');
    // Loose stacks with no hat still run, so a beginner's first blocks do something.
    const loose = tops.filter(
      (b) => !b.outputConnection && !b.previousConnection?.targetBlock() &&
        b.type !== 'gb_when_flag' && b.type !== 'gb_when_ir_below' && !!b.previousConnection,
    );

    const threads: Array<Promise<void>> = [
      ...flagHats.map((h) => this.runStack(h.getNextBlock(), token)),
      ...loose.map((b) => this.runStack(b, token)),
      ...irHats.map((h) => this.runIrHat(h, token)),
    ];

    try {
      await Promise.all(threads);
    } catch (e) {
      if (!(e instanceof AbortedError)) throw e;
    } finally {
      if (token === this.token) this.finish();
    }
  }

  stop(): void {
    if (!this.running && this.token === 0) return;
    this.token++;
    this.sched.cancelAll();
    this.finish();
  }

  private finish(): void {
    this.running = false;
    this.world.robot.stopWheels();
    this.ws?.highlightBlock(null);
    this.onStateChange?.(false);
  }

  private ck(token: number): void {
    if (token !== this.token) throw new AbortedError();
  }

  private highlight(block: Blockly.Block): void {
    if (!this.turbo) this.ws?.highlightBlock(block.id);
  }

  // ---------------------------------------------------------------- hats

  /** Edge-triggered: fires on entry into range, re-arms once the object leaves. */
  private async runIrHat(hat: Blockly.Block, token: number): Promise<void> {
    const body = hat.getNextBlock();
    for (;;) {
      this.ck(token);
      const threshold = () => Number(this.val(hat, 'CM', 15));
      await this.sched.waitUntil(() => this.world.robot.irDistance < threshold());
      this.ck(token);
      await this.runStack(body, token);
      this.ck(token);
      await this.sched.waitUntil(() => this.world.robot.irDistance >= threshold());
    }
  }

  private async runStack(start: Blockly.Block | null, token: number): Promise<void> {
    let b = start;
    while (b) {
      this.ck(token);
      await this.exec(b, token);
      b = b.getNextBlock();
    }
  }

  /** Loop bodies that never wait would freeze the page — force one frame. */
  private async loopGuard(before: number): Promise<void> {
    if (this.sched.time === before) await this.sched.wait(1 / 60);
  }

  // ---------------------------------------------------------------- statements

  private async exec(b: Blockly.Block, token: number): Promise<void> {
    this.highlight(b);
    const bot = this.world.robot;

    switch (b.type) {
      // ---- drive ----
      case 'gb_drive_time':
        await bot.driveFor(b.getFieldValue('DIR') as DriveDir, Number(this.val(b, 'SECS', 1)));
        break;
      case 'gb_drive_distance': {
        const cm = Number(this.val(b, 'CM', 30));
        const sign = b.getFieldValue('DIR') === 'backward' ? -1 : 1;
        await bot.driveDistance((sign * cm) / 100);
        break;
      }
      case 'gb_drive_start':
        bot.driveDir(b.getFieldValue('DIR') as DriveDir);
        break;
      case 'gb_stop_driving':
        bot.stopWheels();
        break;
      case 'gb_turn':
        await bot.turnBy(Number(this.val(b, 'DEG', 90)), b.getFieldValue('DIR') as 'left' | 'right');
        break;
      case 'gb_set_speed':
        bot.setSpeedPreset(b.getFieldValue('SPEED') as SpeedPreset);
        break;
      case 'gb_set_wheels':
        bot.setWheels(Number(this.val(b, 'L', 0)), Number(this.val(b, 'R', 0)));
        break;

      // ---- arm / claw ----
      case 'gb_arm_pose':
        await bot.moveArmTo(ARM_POSE_ANGLE[b.getFieldValue('POSE')] ?? ARM.carry, 800);
        break;
      case 'gb_arm_to':
        await bot.moveArmTo(Number(this.val(b, 'ANGLE', 45)), Number(this.val(b, 'MS', 700)));
        break;
      case 'gb_claw':
        await (b.getFieldValue('ACT') === 'grab' ? bot.closeClaw() : bot.openClaw());
        break;
      case 'gb_claw_to':
        await bot.moveClawTo(Number(this.val(b, 'ANGLE', 30)), Number(this.val(b, 'MS', 400)));
        break;
      case 'gb_run_action': {
        const id = b.getFieldValue('ACTION');
        if (id) await this.actions.play(id);
        break;
      }

      // ---- light / sound ----
      case 'gb_led':
        bot.setLed(b.getFieldValue('COLOR'));
        break;
      case 'gb_led_off':
        bot.setLed(null);
        break;
      case 'gb_led_blink':
        await bot.blinkLed(b.getFieldValue('COLOR'), Number(this.val(b, 'TIMES', 3)));
        break;
      case 'gb_sound':
        audio.play(b.getFieldValue('SOUND') as SoundName);
        break;

      // ---- control ----
      case 'gb_wait':
        await this.sched.wait(clamp(Number(this.val(b, 'SECS', 1)), 0, 600));
        break;
      case 'gb_forever':
        for (;;) {
          this.ck(token);
          const t0 = this.sched.time;
          await this.runStack(b.getInputTargetBlock('DO'), token);
          await this.loopGuard(t0);
        }
      case 'gb_wait_until':
        await this.sched.waitUntil(() => {
          try {
            return !!this.val(b, 'COND', false);
          } catch {
            return true;
          }
        });
        break;
      case 'gb_stop_program':
        throw new AbortedError();

      case 'controls_repeat_ext': {
        const n = clamp(Math.floor(Number(this.val(b, 'TIMES', 4))), 0, 100000);
        for (let i = 0; i < n; i++) {
          this.ck(token);
          const t0 = this.sched.time;
          await this.runStack(b.getInputTargetBlock('DO'), token);
          await this.loopGuard(t0);
        }
        break;
      }
      case 'controls_whileUntil': {
        const until = b.getFieldValue('MODE') === 'UNTIL';
        for (;;) {
          this.ck(token);
          const raw = !!this.val(b, 'BOOL', false);
          if (until ? raw : !raw) break;
          const t0 = this.sched.time;
          await this.runStack(b.getInputTargetBlock('DO'), token);
          await this.loopGuard(t0);
        }
        break;
      }
      case 'controls_if': {
        let done = false;
        for (let i = 0; ; i++) {
          const cond = b.getInput(`IF${i}`);
          if (!cond) break;
          if (this.val(b, `IF${i}`, false)) {
            await this.runStack(b.getInputTargetBlock(`DO${i}`), token);
            done = true;
            break;
          }
        }
        if (!done && b.getInput('ELSE')) {
          await this.runStack(b.getInputTargetBlock('ELSE'), token);
        }
        break;
      }

      // ---- variables ----
      case 'variables_set':
        this.vars.set(this.varKey(b), this.val(b, 'VALUE', 0));
        break;
      case 'math_change': {
        const k = this.varKey(b);
        this.vars.set(k, Number(this.vars.get(k) ?? 0) + Number(this.val(b, 'DELTA', 1)));
        break;
      }

      default:
        // Unknown statement blocks are skipped rather than killing the program.
        break;
    }
  }

  // ---------------------------------------------------------------- values

  private varKey(b: Blockly.Block): string {
    const f = b.getField('VAR') as Blockly.FieldVariable | null;
    return f?.getVariable()?.getId() ?? b.getFieldValue('VAR') ?? '?';
  }

  /** Evaluate the block plugged into `input`, or return `def`. */
  private val(b: Blockly.Block, input: string, def: unknown): unknown {
    const t = b.getInputTargetBlock(input);
    return t ? this.evalBlock(t) : def;
  }

  private evalBlock(b: Blockly.Block): unknown {
    const bot = this.world.robot;
    switch (b.type) {
      case 'math_number':
        return Number(b.getFieldValue('NUM'));
      case 'text':
        return b.getFieldValue('TEXT');
      case 'logic_boolean':
        return b.getFieldValue('BOOL') === 'TRUE';

      case 'math_arithmetic': {
        const a = Number(this.val(b, 'A', 0));
        const c = Number(this.val(b, 'B', 0));
        switch (b.getFieldValue('OP')) {
          case 'ADD': return a + c;
          case 'MINUS': return a - c;
          case 'MULTIPLY': return a * c;
          case 'DIVIDE': return c === 0 ? 0 : a / c;
          case 'POWER': return Math.pow(a, c);
          default: return 0;
        }
      }
      case 'math_random_int': {
        const lo = Math.ceil(Number(this.val(b, 'FROM', 1)));
        const hi = Math.floor(Number(this.val(b, 'TO', 10)));
        return lo > hi ? lo : lo + Math.floor(Math.random() * (hi - lo + 1));
      }
      case 'logic_compare': {
        const a = this.val(b, 'A', 0) as number;
        const c = this.val(b, 'B', 0) as number;
        switch (b.getFieldValue('OP')) {
          case 'EQ': return a === c;
          case 'NEQ': return a !== c;
          case 'LT': return a < c;
          case 'LTE': return a <= c;
          case 'GT': return a > c;
          case 'GTE': return a >= c;
          default: return false;
        }
      }
      case 'logic_operation': {
        const a = !!this.val(b, 'A', false);
        const c = !!this.val(b, 'B', false);
        return b.getFieldValue('OP') === 'AND' ? a && c : a || c;
      }
      case 'logic_negate':
        return !this.val(b, 'BOOL', false);
      case 'variables_get':
        return this.vars.get(this.varKey(b)) ?? 0;

      // ---- sensing ----
      case 'gb_ir':
        return Math.round(bot.irDistance * 10) / 10;
      case 'gb_ir_closer':
        return bot.irDistance < Number(this.val(b, 'CM', 15));
      case 'gb_holding':
        return this.world.heldId !== null;
      case 'gb_bumped':
        return this.sched.time - this.world.lastBumpAt < 0.6;
      case 'gb_battery':
        return Math.round(bot.batteryPct);
      case 'gb_arm_angle':
        return Math.round(bot.armAngle);

      default:
        return 0;
    }
  }
}

/* ==================================================== Swift-ish code preview */

/**
 * The real JIMU app can show your blocks as Swift. Same idea here — it makes
 * the jump from blocks to text feel small.
 */
export function toSwift(ws: Blockly.WorkspaceSvg): string {
  const tops = ws.getTopBlocks(true).filter((b) => b.isEnabled() && !b.outputConnection);
  if (!tops.length) return '// Drag some blocks in to see the code.\n';

  const out: string[] = ['import JimuKit', '', 'let robot = GrabberBot()', ''];
  for (const t of tops) {
    if (t.type === 'gb_when_flag') {
      out.push('robot.onStart {', ...stack(t.getNextBlock(), 1), '}', '');
    } else if (t.type === 'gb_when_ir_below') {
      out.push(`robot.onIRCloserThan(${value(t, 'CM', '15')}) {`, ...stack(t.getNextBlock(), 1), '}', '');
    } else {
      out.push(...stack(t, 0), '');
    }
  }
  return out.join('\n');
}

const pad = (n: number) => '    '.repeat(n);

function stack(b: Blockly.Block | null, depth: number): string[] {
  const lines: string[] = [];
  let cur = b;
  while (cur) {
    lines.push(...line(cur, depth));
    cur = cur.getNextBlock();
  }
  return lines;
}

function value(b: Blockly.Block, input: string, def: string): string {
  const t = b.getInputTargetBlock(input);
  if (!t) return def;
  switch (t.type) {
    case 'math_number': return String(Number(t.getFieldValue('NUM')));
    case 'logic_boolean': return t.getFieldValue('BOOL') === 'TRUE' ? 'true' : 'false';
    case 'gb_ir': return 'robot.irDistance';
    case 'gb_holding': return 'robot.isHolding';
    case 'gb_bumped': return 'robot.didBump';
    case 'gb_battery': return 'robot.battery';
    case 'gb_arm_angle': return 'robot.armAngle';
    case 'gb_ir_closer': return `(robot.irDistance < ${value(t, 'CM', '15')})`;
    case 'variables_get': return varName(t);
    case 'logic_negate': return `!(${value(t, 'BOOL', 'false')})`;
    case 'math_random_int': return `Int.random(in: ${value(t, 'FROM', '1')}...${value(t, 'TO', '10')})`;
    case 'math_arithmetic': {
      const op = { ADD: '+', MINUS: '-', MULTIPLY: '*', DIVIDE: '/', POWER: '**' }[t.getFieldValue('OP') as string] ?? '+';
      return `(${value(t, 'A', '0')} ${op} ${value(t, 'B', '0')})`;
    }
    case 'logic_compare': {
      const op = { EQ: '==', NEQ: '!=', LT: '<', LTE: '<=', GT: '>', GTE: '>=' }[t.getFieldValue('OP') as string] ?? '==';
      return `(${value(t, 'A', '0')} ${op} ${value(t, 'B', '0')})`;
    }
    case 'logic_operation':
      return `(${value(t, 'A', 'false')} ${t.getFieldValue('OP') === 'AND' ? '&&' : '||'} ${value(t, 'B', 'false')})`;
    default:
      return def;
  }
}

function varName(b: Blockly.Block): string {
  const f = b.getField('VAR') as Blockly.FieldVariable | null;
  return (f?.getVariable()?.name ?? 'value').replace(/\s+/g, '_');
}

function line(b: Blockly.Block, d: number): string[] {
  const p = pad(d);
  switch (b.type) {
    case 'gb_drive_time':
      return [`${p}robot.drive(.${b.getFieldValue('DIR')}, for: ${value(b, 'SECS', '1')})`];
    case 'gb_drive_distance':
      return [`${p}robot.drive(.${b.getFieldValue('DIR')}, cm: ${value(b, 'CM', '30')})`];
    case 'gb_drive_start':
      return [`${p}robot.startDriving(.${b.getFieldValue('DIR')})`];
    case 'gb_stop_driving':
      return [`${p}robot.stopTreads()`];
    case 'gb_turn':
      return [`${p}robot.turn(.${b.getFieldValue('DIR')}, degrees: ${value(b, 'DEG', '90')})`];
    case 'gb_set_speed':
      return [`${p}robot.wheelSpeed = .${b.getFieldValue('SPEED')}`];
    case 'gb_set_wheels':
      return [`${p}robot.setTreads(left: ${value(b, 'L', '0')}, right: ${value(b, 'R', '0')})`];
    case 'gb_arm_pose':
      return [`${p}robot.arm.move(to: .${b.getFieldValue('POSE')})`];
    case 'gb_arm_to':
      return [`${p}robot.arm.move(to: ${value(b, 'ANGLE', '45')}, ms: ${value(b, 'MS', '700')})`];
    case 'gb_claw':
      return [`${p}robot.claw.${b.getFieldValue('ACT') === 'grab' ? 'grab()' : 'open()'}`];
    case 'gb_claw_to':
      return [`${p}robot.claw.move(to: ${value(b, 'ANGLE', '30')}, ms: ${value(b, 'MS', '400')})`];
    case 'gb_run_action':
      return [`${p}robot.play(action: "${b.getFieldValue('ACTION')}")`];
    case 'gb_led':
      return [`${p}robot.led.color = "${b.getFieldValue('COLOR')}"`];
    case 'gb_led_off':
      return [`${p}robot.led.off()`];
    case 'gb_led_blink':
      return [`${p}robot.led.blink("${b.getFieldValue('COLOR')}", times: ${value(b, 'TIMES', '3')})`];
    case 'gb_sound':
      return [`${p}robot.play(sound: .${b.getFieldValue('SOUND')})`];
    case 'gb_wait':
      return [`${p}wait(seconds: ${value(b, 'SECS', '1')})`];
    case 'gb_wait_until':
      return [`${p}wait(until: ${value(b, 'COND', 'true')})`];
    case 'gb_stop_program':
      return [`${p}robot.stopAll()`];
    case 'gb_forever':
      return [`${p}while true {`, ...stack(b.getInputTargetBlock('DO'), d + 1), `${p}}`];
    case 'controls_repeat_ext':
      return [`${p}for _ in 0..<${value(b, 'TIMES', '4')} {`, ...stack(b.getInputTargetBlock('DO'), d + 1), `${p}}`];
    case 'controls_whileUntil': {
      const cond = value(b, 'BOOL', 'true');
      const test = b.getFieldValue('MODE') === 'UNTIL' ? `!(${cond})` : cond;
      return [`${p}while ${test} {`, ...stack(b.getInputTargetBlock('DO'), d + 1), `${p}}`];
    }
    case 'controls_if': {
      const lines: string[] = [];
      for (let i = 0; b.getInput(`IF${i}`); i++) {
        lines.push(`${p}${i === 0 ? 'if' : '} else if'} ${value(b, `IF${i}`, 'true')} {`);
        lines.push(...stack(b.getInputTargetBlock(`DO${i}`), d + 1));
      }
      if (b.getInput('ELSE')) {
        lines.push(`${p}} else {`, ...stack(b.getInputTargetBlock('ELSE'), d + 1));
      }
      lines.push(`${p}}`);
      return lines;
    }
    case 'variables_set':
      return [`${p}var ${varName(b)} = ${value(b, 'VALUE', '0')}`];
    case 'math_change':
      return [`${p}${varName(b)} += ${value(b, 'DELTA', '1')}`];
    default:
      return [`${p}// ${b.type}`];
  }
}
