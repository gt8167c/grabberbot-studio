/**
 * Mounts the Blockly workspace, wires the run/stop toolbar, keeps the
 * workspace in localStorage, and ships a few example programs.
 */

import * as Blockly from 'blockly';
import type { World } from '../sim/world';
import type { Scheduler } from '../sim/scheduler';
import type { ActionStore } from './actions';
import { buildTheme, buildToolbox, defineBlocks, setActionOptionsProvider } from './blocks';
import { ProgramRunner, toSwift } from './runner';
import { $, loadJSON, saveJSON, toast } from './ui-kit';

const WS_KEY = 'gbs.workspace.v1';

export class CodingTab {
  readonly workspace: Blockly.WorkspaceSvg;
  readonly runner: ProgramRunner;
  private saveTimer = 0;

  constructor(world: World, sched: Scheduler, private actions: ActionStore) {
    defineBlocks();
    setActionOptionsProvider(() =>
      actions.actions.filter((a) => !a.id.startsWith('__')).map((a) => [`${a.icon} ${a.name}`, a.id] as [string, string]),
    );

    this.workspace = Blockly.inject($('blocklyDiv'), {
      toolbox: buildToolbox(),
      theme: buildTheme(),
      renderer: 'zelos',
      // Blockly's media sprites are not bundled, so the widgets that need them stay off.
      trashcan: false,
      zoom: { controls: false, wheel: true, startScale: 0.78, minScale: 0.35, maxScale: 1.6 },
      grid: { spacing: 28, length: 2, colour: '#222c3a', snap: false },
      move: { scrollbars: true, drag: true, wheel: true },
      sounds: false,
    });

    this.runner = new ProgramRunner(world, sched, actions);
    this.runner.onStateChange = (running) => {
      $('runBtn').classList.toggle('running', running);
      $('runningPill').hidden = !running;
    };

    this.restore();
    this.workspace.addChangeListener((e) => {
      if (e.isUiEvent) return;
      clearTimeout(this.saveTimer);
      this.saveTimer = window.setTimeout(() => this.persist(), 500);
      if (!$('codePreview').hidden) this.refreshPreview();
    });

    this.mountToolbar();
    new ResizeObserver(() => Blockly.svgResize(this.workspace)).observe($('blocklyDiv'));
  }

  // ---------------------------------------------------------------- toolbar

  private mountToolbar(): void {
    $('runBtn').onclick = () => void this.run();
    $('stopBtn').onclick = () => {
      this.runner.stop();
      this.actions.stop();
    };
    $<HTMLInputElement>('turboChk').onchange = (e) => {
      this.runner.turbo = (e.target as HTMLInputElement).checked;
      window.dispatchEvent(new CustomEvent('gbs:turbo', { detail: this.runner.turbo }));
    };
    $('clearWsBtn').onclick = () => {
      if (this.workspace.getAllBlocks(false).length && !confirm('Clear all blocks?')) return;
      this.workspace.clear();
      this.persist();
    };
    $('codePreviewBtn').onclick = () => {
      const pre = $('codePreview');
      pre.hidden = !pre.hidden;
      if (!pre.hidden) this.refreshPreview();
      Blockly.svgResize(this.workspace);
    };
    $<HTMLSelectElement>('exampleSel').onchange = (e) => {
      const sel = e.target as HTMLSelectElement;
      const key = sel.value as keyof typeof EXAMPLES;
      if (key && EXAMPLES[key]) {
        this.load(EXAMPLES[key]());
        toast('Example loaded — press ▶ to run', 'good');
      }
      sel.value = '';
    };

    // Stop programs when the big red STOP button is hit anywhere in the app.
    addEventListener('gbs:stop-all', () => this.runner.stop());
  }

  async run(): Promise<void> {
    if (this.runner.running) {
      this.runner.stop();
      return;
    }
    if (!this.workspace.getAllBlocks(false).length) {
      toast('No blocks yet — drag some in first', 'warn');
      return;
    }
    await this.runner.run(this.workspace);
  }

  private refreshPreview(): void {
    $('codePreview').textContent = toSwift(this.workspace);
  }

  // ---------------------------------------------------------------- storage

  private persist(): void {
    try {
      saveJSON(WS_KEY, Blockly.serialization.workspaces.save(this.workspace));
    } catch {
      /* ignore serialization hiccups */
    }
  }

  private restore(): void {
    const state = loadJSON<any>(WS_KEY, null);
    this.load(state ?? EXAMPLES.wallstop(), true);
  }

  load(state: any, quiet = false): void {
    try {
      Blockly.serialization.workspaces.load(state, this.workspace);
      if (!quiet) this.persist();
    } catch (err) {
      console.warn('Could not load workspace', err);
      this.workspace.clear();
    }
  }

  /** Blockly needs a nudge whenever its container becomes visible again. */
  refreshLayout(): void {
    Blockly.svgResize(this.workspace);
  }
}

/* ==================================================== example programs === */

type BlockSpec = { type: string; fields?: Record<string, unknown>; inputs?: Record<string, unknown> };

/** Numeric shadow, so every socket comes pre-filled like in the toolbox. */
const n = (v: number) => ({ shadow: { type: 'math_number', fields: { NUM: v } } });

function chain(blocks: BlockSpec[]): any {
  if (!blocks.length) return undefined;
  const [head, ...rest] = blocks;
  const node: any = { ...head };
  const next = chain(rest);
  if (next) node.next = { block: next };
  return node;
}

function program(top: BlockSpec, body: BlockSpec[]): any {
  const root: any = { ...top, x: 48, y: 40 };
  const b = chain(body);
  if (b) root.next = { block: b };
  return { blocks: { languageVersion: 0, blocks: [root] } };
}

const EXAMPLES = {
  /** Drive at a wall and stop using the IR sensor — the classic first program. */
  wallstop: () =>
    program({ type: 'gb_when_flag' }, [
      { type: 'gb_led', fields: { COLOR: '#35d0ff' } },
      { type: 'gb_set_speed', fields: { SPEED: 'normal' } },
      { type: 'gb_drive_start', fields: { DIR: 'forward' } },
      { type: 'gb_wait_until', inputs: { COND: { block: { type: 'gb_ir_closer', inputs: { CM: n(15) } } } } },
      { type: 'gb_stop_driving' },
      { type: 'gb_led', fields: { COLOR: '#ff2d2d' } },
      { type: 'gb_sound', fields: { SOUND: 'horn' } },
    ]),

  /** Find cargo, pick it up, carry it away, put it down. */
  grabcarry: () =>
    program({ type: 'gb_when_flag' }, [
      { type: 'gb_led', fields: { COLOR: '#ffd21e' } },
      { type: 'gb_claw', fields: { ACT: 'open' } },
      { type: 'gb_arm_pose', fields: { POSE: 'floor' } },
      { type: 'gb_drive_start', fields: { DIR: 'forward' } },
      { type: 'gb_wait_until', inputs: { COND: { block: { type: 'gb_ir_closer', inputs: { CM: n(12) } } } } },
      { type: 'gb_stop_driving' },
      { type: 'gb_claw', fields: { ACT: 'grab' } },
      { type: 'gb_arm_pose', fields: { POSE: 'carry' } },
      { type: 'gb_led', fields: { COLOR: '#3ddc55' } },
      { type: 'gb_turn', fields: { DIR: 'right' }, inputs: { DEG: n(150) } },
      { type: 'gb_drive_distance', fields: { DIR: 'forward' }, inputs: { CM: n(45) } },
      { type: 'gb_arm_pose', fields: { POSE: 'floor' } },
      { type: 'gb_claw', fields: { ACT: 'open' } },
      { type: 'gb_sound', fields: { SOUND: 'chirp' } },
      { type: 'gb_arm_pose', fields: { POSE: 'carry' } },
    ]),

  /** Patrol the pen forever, changing colour and backing off obstacles. */
  disco: () =>
    program({ type: 'gb_when_flag' }, [
      { type: 'gb_set_speed', fields: { SPEED: 'fast' } },
      {
        type: 'gb_forever',
        inputs: {
          DO: {
            block: chain([
              { type: 'gb_led', fields: { COLOR: '#7a5cff' } },
              { type: 'gb_drive_start', fields: { DIR: 'forward' } },
              { type: 'gb_wait_until', inputs: { COND: { block: { type: 'gb_ir_closer', inputs: { CM: n(20) } } } } },
              { type: 'gb_stop_driving' },
              { type: 'gb_led', fields: { COLOR: '#ff2d2d' } },
              { type: 'gb_sound', fields: { SOUND: 'chirp' } },
              { type: 'gb_drive_time', fields: { DIR: 'backward' }, inputs: { SECS: n(0.6) } },
              { type: 'gb_led', fields: { COLOR: '#35d0ff' } },
              { type: 'gb_turn', fields: { DIR: 'right' }, inputs: { DEG: n(75) } },
            ]),
          },
        },
      },
    ]),
};
