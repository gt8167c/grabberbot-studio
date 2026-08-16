/**
 * The Actions tab: JIMU's Pose-Record-Play, rebuilt as a keyframe list.
 *
 * A "movement" in the real app is a sequence of postures, each with its own
 * transition time (80–5000 ms). Same model here, plus LED/sound/drive per
 * frame because those make far more interesting canned routines.
 */

import { ARM, CLAW, SERVO, clamp } from '../sim/spec';
import type { SpeedPreset } from '../sim/spec';
import type { DriveDir } from '../sim/robot';
import type { World } from '../sim/world';
import type { Scheduler } from '../sim/scheduler';
import { audio } from '../sim/audio';
import type { SoundName } from '../sim/audio';
import { $, el, loadJSON, saveJSON, toast } from './ui-kit';

export interface Frame {
  /** null means "leave this servo where it is". */
  arm: number | null;
  claw: number | null;
  /** Transition time for this posture, in ms. */
  ms: number;
  led: string | null;
  sound: SoundName | null;
  drive: { dir: DriveDir; speed: SpeedPreset; sec: number } | null;
}

export interface Action {
  id: string;
  name: string;
  icon: string;
  frames: Frame[];
  builtin?: boolean;
}

const ICONS = ['🦾', '👋', '📦', '🔄', '⚡', '🎯', '🚜', '💃'];
const STORE_KEY = 'gbs.actions.v1';
const SLOT_KEY = 'gbs.slots.v1';

export function newFrame(partial: Partial<Frame> = {}): Frame {
  return { arm: null, claw: null, ms: 600, led: null, sound: null, drive: null, ...partial };
}

function builtins(): Action[] {
  return [
    {
      id: 'b_wave', name: 'Wave', icon: '👋', builtin: true,
      frames: [
        newFrame({ arm: 65, ms: 500, led: '#ffc400' }),
        newFrame({ claw: 10, ms: 260, sound: 'chirp' }),
        newFrame({ claw: 60, ms: 260 }),
        newFrame({ claw: 10, ms: 260 }),
        newFrame({ claw: 55, ms: 260 }),
        newFrame({ arm: 20, ms: 600 }),
      ],
    },
    {
      id: 'b_pick', name: 'Pick up', icon: '📦', builtin: true,
      frames: [
        newFrame({ claw: CLAW.max, ms: 350 }),
        newFrame({ arm: ARM.floor, ms: 800 }),
        newFrame({ claw: 0, ms: 500, sound: 'grab' }),
        newFrame({ arm: ARM.carry, ms: 800 }),
      ],
    },
    {
      id: 'b_dump', name: 'Dump', icon: '🪣', builtin: true,
      frames: [
        newFrame({ arm: 60, ms: 700 }),
        newFrame({ claw: CLAW.max, ms: 400, sound: 'drop' }),
        newFrame({ arm: 20, ms: 700 }),
      ],
    },
    {
      id: 'b_spin', name: 'Spin', icon: '🔄', builtin: true,
      frames: [
        newFrame({ led: '#7a5cff', ms: 120, sound: 'laser' }),
        newFrame({ drive: { dir: 'right', speed: 'fast', sec: 1.4 }, ms: 120 }),
        newFrame({ led: '#35d0ff', ms: 120 }),
      ],
    },
    {
      id: 'b_hello', name: 'Hello!', icon: '⚡', builtin: true,
      frames: [
        newFrame({ led: '#ff2d2d', ms: 160, sound: 'horn' }),
        newFrame({ arm: 55, claw: 20, ms: 450 }),
        newFrame({ led: '#3ddc55', ms: 160 }),
        newFrame({ arm: 20, claw: 55, ms: 450 }),
      ],
    },
  ];
}

export class ActionStore {
  actions: Action[] = [];
  /** Eight controller buttons, each holding an action id (or null). */
  slots: (string | null)[] = [null, null, null, null, null, null, null, null];
  playing: string | null = null;
  private draft: Action | null = null;
  private playToken = 0;
  onChange?: () => void;

  constructor(private world: World, private sched: Scheduler) {
    const saved = loadJSON<Action[]>(STORE_KEY, []);
    this.actions = [...builtins(), ...saved.filter((a) => !a.builtin)];
    const savedSlots = loadJSON<(string | null)[]>(SLOT_KEY, []);
    if (savedSlots.length === 8) this.slots = savedSlots;
    else this.slots = ['b_wave', 'b_pick', 'b_dump', 'b_spin', 'b_hello', null, null, null];
  }

  private persist(): void {
    saveJSON(STORE_KEY, this.actions.filter((a) => !a.builtin));
    saveJSON(SLOT_KEY, this.slots);
    this.onChange?.();
  }

  get(id: string | null): Action | undefined {
    return id ? this.actions.find((a) => a.id === id) : undefined;
  }

  // ---------------------------------------------------------------- playback

  /** Run an action's frames against the robot. Later calls cancel earlier ones. */
  async play(id: string): Promise<void> {
    const a = this.get(id);
    if (!a) return;
    const token = ++this.playToken;
    this.playing = id;
    this.onChange?.();
    const bot = this.world.robot;

    try {
      for (const f of a.frames) {
        if (token !== this.playToken) return;
        const ms = clamp(f.ms, SERVO.minMoveMs, SERVO.maxMoveMs);

        if (f.led !== null) bot.setLed(f.led === 'off' ? null : f.led);
        if (f.sound) audio.play(f.sound);

        const waits: Promise<void>[] = [];
        if (f.arm !== null) waits.push(bot.moveArmTo(f.arm, ms));
        if (f.claw !== null) waits.push(bot.moveClawTo(f.claw, ms));
        if (f.drive) {
          waits.push(bot.driveFor(f.drive.dir, f.drive.sec, f.drive.speed));
        }
        if (!waits.length) waits.push(this.sched.wait(ms / 1000));
        await Promise.all(waits);
      }
    } finally {
      if (token === this.playToken) {
        this.playing = null;
        this.onChange?.();
      }
    }
  }

  stop(): void {
    this.playToken++;
    this.playing = null;
    this.world.robot.stopWheels();
    this.onChange?.();
  }

  // ---------------------------------------------------------------- editing

  createDraft(): Action {
    this.draft = {
      id: `a_${Date.now().toString(36)}`,
      name: '',
      icon: ICONS[0],
      frames: [newFrame({ arm: this.world.robot.armAngle, claw: this.world.robot.clawAngle })],
    };
    return this.draft;
  }

  editDraft(id: string): Action | null {
    const a = this.get(id);
    if (!a) return null;
    // Editing a built-in forks it into a new user action, leaving the original.
    this.draft = a.builtin
      ? { ...structuredClone(a), id: `a_${Date.now().toString(36)}`, name: `${a.name} copy`, builtin: false }
      : structuredClone(a);
    return this.draft;
  }

  get currentDraft(): Action | null {
    return this.draft;
  }

  saveDraft(): boolean {
    if (!this.draft) return false;
    if (!this.draft.name.trim()) this.draft.name = 'My action';
    if (!this.draft.frames.length) return false;
    const i = this.actions.findIndex((a) => a.id === this.draft!.id);
    if (i >= 0) this.actions[i] = this.draft;
    else this.actions.push(this.draft);
    this.persist();
    this.draft = null;
    return true;
  }

  closeDraft(): void {
    this.draft = null;
  }

  remove(id: string): void {
    const a = this.get(id);
    if (a?.builtin) {
      toast('Built-in actions can’t be deleted', 'warn');
      return;
    }
    this.actions = this.actions.filter((x) => x.id !== id);
    this.slots = this.slots.map((s) => (s === id ? null : s));
    this.persist();
  }

  assignSlot(index: number, id: string | null): void {
    this.slots[index] = id;
    this.persist();
  }
}

/* ================================================================= view === */

export function mountActionsTab(store: ActionStore, world: World): void {
  const list = $('actionList');
  const editor = $('actionEditor');
  const nameInput = $<HTMLInputElement>('actionName');
  const iconPick = $('iconPick');
  const frameList = $('frameList');

  const renderList = () => {
    list.innerHTML = '';
    if (!store.actions.length) {
      list.appendChild(el('div', 'empty-note', 'No actions yet — make one!'));
      return;
    }
    for (const a of store.actions) {
      const row = el('div', `action-row${store.playing === a.id ? ' playing' : ''}`);
      const total = a.frames.reduce((s, f) => s + f.ms + (f.drive ? f.drive.sec * 1000 : 0), 0);
      row.innerHTML = `
        <span class="a-icon">${a.icon}</span>
        <span class="a-name">${escapeHtml(a.name)}${a.builtin ? '' : ' <span style="opacity:.5;font-size:10px">•</span>'}</span>
        <span class="a-meta">${a.frames.length}f · ${(total / 1000).toFixed(1)}s</span>`;
      const btns = el('div', 'a-btns');
      const playBtn = el('button', 'mini-btn', store.playing === a.id ? '⏹' : '▶');
      playBtn.onclick = () => (store.playing === a.id ? store.stop() : void store.play(a.id));
      const editBtn = el('button', 'mini-btn', '✏️');
      editBtn.onclick = () => { store.editDraft(a.id); renderEditor(); };
      const delBtn = el('button', 'mini-btn', '🗑');
      delBtn.onclick = () => store.remove(a.id);
      btns.append(playBtn, editBtn, delBtn);
      row.appendChild(btns);
      list.appendChild(row);
    }
  };

  const renderEditor = () => {
    const d = store.currentDraft;
    editor.hidden = !d;
    if (!d) return;

    nameInput.value = d.name;
    nameInput.oninput = () => { d.name = nameInput.value; };

    iconPick.innerHTML = '';
    for (const ic of ICONS) {
      const b = el('button', d.icon === ic ? 'sel' : '', ic);
      b.onclick = () => { d.icon = ic; renderEditor(); };
      iconPick.appendChild(b);
    }

    frameList.innerHTML = '';
    d.frames.forEach((f, i) => {
      const card = el('div', 'frame');
      card.appendChild(frameHead(d, i, renderEditor));
      const grid = el('div', 'frame-grid');
      grid.append(
        rangeField('Arm', f.arm, ARM.min, ARM.max, '°', (v) => { f.arm = v; }),
        rangeField('Claw', f.claw, CLAW.min, CLAW.max, '°', (v) => { f.claw = v; }),
        numberField('Time (ms)', f.ms, SERVO.minMoveMs, SERVO.maxMoveMs, (v) => { f.ms = v; }),
        selectField('LED', f.led ?? '', LED_OPTS, (v) => { f.led = v === '' ? null : v; }),
        selectField('Sound', f.sound ?? '', SOUND_OPTS, (v) => { f.sound = (v || null) as SoundName | null; }),
        driveField(f, renderEditor),
      );
      card.appendChild(grid);
      frameList.appendChild(card);
    });
  };

  const frameHead = (d: Action, i: number, refresh: () => void): HTMLElement => {
    const head = el('div', 'frame-head');
    head.innerHTML = `<span class="fh-idx">${i + 1}</span><span>Posture ${i + 1}</span>`;
    const spacer = el('span');
    spacer.style.flex = '1';
    head.appendChild(spacer);
    const up = el('button', 'mini-btn', '↑');
    up.onclick = () => { if (i > 0) { [d.frames[i - 1], d.frames[i]] = [d.frames[i], d.frames[i - 1]]; refresh(); } };
    const down = el('button', 'mini-btn', '↓');
    down.onclick = () => { if (i < d.frames.length - 1) { [d.frames[i + 1], d.frames[i]] = [d.frames[i], d.frames[i + 1]]; refresh(); } };
    const del = el('button', 'mini-btn', '✕');
    del.onclick = () => { d.frames.splice(i, 1); refresh(); };
    head.append(up, down, del);
    return head;
  };

  // --- toolbar wiring ---
  $('newActionBtn').onclick = () => { store.createDraft(); renderEditor(); };
  $('closeEditorBtn').onclick = () => { store.closeDraft(); renderEditor(); };
  $('addFrameBtn').onclick = () => {
    store.currentDraft?.frames.push(newFrame());
    renderEditor();
  };
  $('capturePoseBtn').onclick = () => {
    const d = store.currentDraft;
    if (!d) return;
    d.frames.push(newFrame({
      arm: Math.round(world.robot.armAngle),
      claw: Math.round(world.robot.clawAngle),
      led: world.robot.ledColor ?? 'off',
    }));
    renderEditor();
    toast('Pose captured from the robot', 'good', 1600);
  };
  $('previewActionBtn').onclick = async () => {
    const d = store.currentDraft;
    if (!d) return;
    const tmpId = `__preview_${d.id}`;
    const existing = store.actions.findIndex((a) => a.id === tmpId);
    const clone: Action = { ...structuredClone(d), id: tmpId };
    if (existing >= 0) store.actions[existing] = clone;
    else store.actions.push(clone);
    await store.play(tmpId);
    store.actions = store.actions.filter((a) => a.id !== tmpId);
  };
  $('saveActionBtn').onclick = () => {
    if (store.saveDraft()) {
      toast('Action saved', 'good');
      renderEditor();
      renderList();
    }
  };

  store.onChange = () => { renderList(); };
  renderList();
  renderEditor();
}

/* ---------------------------------------------------------------- fields */

const LED_OPTS: Array<[string, string]> = [
  ['', '— no change —'],
  ['#ff2d2d', 'Red'], ['#ff9f1c', 'Orange'], ['#ffd21e', 'Yellow'],
  ['#3ddc55', 'Green'], ['#35d0ff', 'Cyan'], ['#7a5cff', 'Violet'],
  ['#ffffff', 'White'], ['off', 'Off'],
];

const SOUND_OPTS: Array<[string, string]> = [
  ['', '— none —'], ['horn', 'Horn'], ['siren', 'Siren'], ['chirp', 'Chirp'],
  ['laser', 'Laser'], ['beep', 'Beep'], ['grab', 'Grab'], ['drop', 'Drop'],
];

function wrap(label: string): HTMLElement {
  const f = el('div', 'frame-field');
  f.appendChild(el('label', undefined, label));
  return f;
}

function rangeField(
  label: string, value: number | null, min: number, max: number, unit: string,
  onSet: (v: number | null) => void,
): HTMLElement {
  const f = wrap(label);
  const readout = el('span', 'fv', value === null ? 'no change' : `${Math.round(value)}${unit}`);
  const input = el('input') as HTMLInputElement;
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.value = String(value ?? (min + max) / 2);
  input.oninput = () => {
    const v = Number(input.value);
    onSet(v);
    readout.textContent = `${Math.round(v)}${unit}`;
    toggle.textContent = 'clear';
  };
  const toggle = el('button', 'mini-btn', value === null ? 'set' : 'clear');
  toggle.style.marginLeft = '0';
  toggle.onclick = () => {
    if (toggle.textContent === 'clear') {
      onSet(null);
      readout.textContent = 'no change';
      toggle.textContent = 'set';
    } else {
      const v = Number(input.value);
      onSet(v);
      readout.textContent = `${Math.round(v)}${unit}`;
      toggle.textContent = 'clear';
    }
  };
  const row = el('div');
  row.style.cssText = 'display:flex;gap:6px;align-items:center';
  row.append(readout, toggle);
  f.append(row, input);
  return f;
}

function numberField(label: string, value: number, min: number, max: number, onSet: (v: number) => void): HTMLElement {
  const f = wrap(label);
  const input = el('input') as HTMLInputElement;
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.step = '10';
  input.value = String(value);
  input.onchange = () => {
    const v = clamp(Number(input.value) || min, min, max);
    input.value = String(v);
    onSet(v);
  };
  f.appendChild(input);
  return f;
}

function selectField(label: string, value: string, opts: Array<[string, string]>, onSet: (v: string) => void): HTMLElement {
  const f = wrap(label);
  const sel = el('select') as HTMLSelectElement;
  for (const [v, t] of opts) {
    const o = el('option', undefined, t) as HTMLOptionElement;
    o.value = v;
    sel.appendChild(o);
  }
  sel.value = value;
  sel.onchange = () => onSet(sel.value);
  f.appendChild(sel);
  return f;
}

function driveField(f: Frame, refresh: () => void): HTMLElement {
  const box = wrap('Drive');
  const sel = el('select') as HTMLSelectElement;
  for (const [v, t] of [['', '— none —'], ['forward', 'Forward'], ['backward', 'Back'], ['left', 'Spin left'], ['right', 'Spin right']] as Array<[string, string]>) {
    const o = el('option', undefined, t) as HTMLOptionElement;
    o.value = v;
    sel.appendChild(o);
  }
  sel.value = f.drive?.dir ?? '';
  sel.onchange = () => {
    f.drive = sel.value ? { dir: sel.value as DriveDir, speed: 'normal', sec: 1 } : null;
    refresh();
  };
  box.appendChild(sel);
  if (f.drive) {
    const secs = el('input') as HTMLInputElement;
    secs.type = 'number';
    secs.min = '0.1';
    secs.max = '20';
    secs.step = '0.1';
    secs.value = String(f.drive.sec);
    secs.style.marginTop = '4px';
    secs.onchange = () => { if (f.drive) f.drive.sec = clamp(Number(secs.value) || 1, 0.1, 20); };
    box.appendChild(secs);
  }
  return box;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
