/**
 * GrabberBot Studio — bootstrap.
 *
 * Owns the single animation loop: advance sim time, let the UI read it,
 * then draw. Everything else is wired up here and left to its own module.
 */

import './styles.css';

import { Scheduler } from './sim/scheduler';
import { World, sandboxSetup } from './sim/world';
import { audio } from './sim/audio';
import { Scene3D } from './view/scene3d';
import { Minimap } from './view/minimap';
import { ActionStore, mountActionsTab } from './ui/actions';
import { ControlTab } from './ui/control';
import { CodingTab } from './ui/coding';
import { MissionTab } from './ui/missions';
import { $, showModal, toast } from './ui/ui-kit';

const sched = new Scheduler();
const world = new World(sched);
const scene = new Scene3D($('viewport'), world);
const minimap = new Minimap($<HTMLCanvasElement>('minimap'), world);
const actions = new ActionStore(world, sched);
const control = new ControlTab(world, actions);
const coding = new CodingTab(world, sched, actions);
const missions = new MissionTab(world);

scene.syncArena();
mountActionsTab(actions, world);
actions.onChange = () => {
  control.renderSlots();
};

missions.onArenaChange = () => {
  scene.syncArena();
  minimap.clearTrail();
  coding.runner.stop();
  actions.stop();
};

// Handy from the browser console: gbs.world.robot.x, gbs.scene.camera, …
(window as any).gbs = { world, scene, sched, actions, control, coding, missions };

/* ---------------------------------------------------------------- tabs */

const tabs = Array.from(document.querySelectorAll<HTMLElement>('.tab'));
for (const tab of tabs) {
  tab.onclick = () => {
    const name = tab.dataset.tab!;
    tabs.forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll<HTMLElement>('.panel').forEach((p) => {
      p.classList.toggle('active', p.id === `panel-${name}`);
    });
    // Blockly measures itself, so it needs a nudge once its panel is visible.
    if (name === 'coding') requestAnimationFrame(() => coding.refreshLayout());
  };
}

/* ---------------------------------------------------------------- header */

let soundOn = true;
$('soundToggle').onclick = () => {
  soundOn = !soundOn;
  audio.setEnabled(soundOn);
  $('soundToggle').textContent = soundOn ? '🔊' : '🔇';
};

$('battChip').onclick = () => {
  world.robot.charging = !world.robot.charging;
  toast(world.robot.charging ? 'Charger plugged in' : 'Running on battery', 'info', 1500);
};

$('btChip').onclick = () => {
  toast('Simulated link — no real Bluetooth is used', 'info', 2200);
};

$('helpBtn').onclick = () => showModal('helpModal', true);
$('helpClose').onclick = () => showModal('helpModal', false);

addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    showModal('helpModal', false);
    showModal('winModal', false);
  }
});

/* ---------------------------------------------------------------- world HUD */

$('camModeBtn').onclick = () => {
  scene.setFollow(!scene.followCam);
  $('camModeBtn').classList.toggle('on', scene.followCam);
};
$('camModeBtn').classList.toggle('on', scene.followCam);
scene.onFollowChange = (on) => $('camModeBtn').classList.toggle('on', on);

$('resetArenaBtn').onclick = () => {
  coding.runner.stop();
  actions.stop();
  if (!missions.resetActive()) world.loadSetup(sandboxSetup());
  scene.syncArena();
  minimap.clearTrail();
  toast('Arena reset', 'info', 1200);
};

/* ---------------------------------------------------------------- splitter */

(() => {
  const splitter = $('splitter');
  const studio = $('studioPanel');
  let dragging = false;

  splitter.addEventListener('pointerdown', (e) => {
    dragging = true;
    splitter.classList.add('dragging');
    splitter.setPointerCapture(e.pointerId);
  });
  splitter.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const w = Math.max(320, Math.min(innerWidth - 320, e.clientX));
    studio.style.width = `${w}px`;
  });
  const stop = () => {
    dragging = false;
    splitter.classList.remove('dragging');
    coding.refreshLayout();
  };
  splitter.addEventListener('pointerup', stop);
  splitter.addEventListener('pointercancel', stop);
})();

/* ---------------------------------------------------------------- events */

world.on((ev, data) => {
  if (ev === 'grab') toast(`Grabbed the ${data.kind}`, 'good', 1400);
  if (ev === 'deliver') toast(`Delivered to ${data.zone.label}!`, 'good', 1800);
});

let turbo = false;
addEventListener('gbs:turbo', (e) => {
  turbo = !!(e as CustomEvent).detail;
});

/* ---------------------------------------------------------------- loop */

let last = performance.now();
let battTimer = 0;
let lowBatteryWarned = false;

function frame(now: number): void {
  requestAnimationFrame(frame);

  // Clamp so a backgrounded tab does not teleport the robot on return.
  const realDt = Math.min((now - last) / 1000, 0.05);
  last = now;
  const dt = realDt * (turbo ? 3 : 1);

  // Physics first, then the scheduler releases anything whose time has come.
  world.update(dt);
  sched.tick(dt);

  control.update(dt);
  missions.update(dt);

  scene.update(dt);
  minimap.draw(dt);

  battTimer += realDt;
  if (battTimer > 0.5) {
    battTimer = 0;
    updateBatteryChip();
  }
}

function updateBatteryChip(): void {
  const bot = world.robot;
  const pct = Math.round(bot.batteryPct);
  $('battPct').textContent = `${pct}%`;
  const fill = $('battFill');
  fill.style.width = `${Math.max(2, pct)}%`;
  fill.style.background = pct < 20 ? '#ff4d4d' : pct < 50 ? '#ffc400' : '#3ddc55';

  // Mirrors the real control box LED: red charging, green full, flashing when running.
  const dot = $('pwrDot');
  const driving = Math.abs(bot.leftServoDeg) + Math.abs(bot.rightServoDeg) > 1;
  dot.className = `pwr-dot ${bot.charging ? 'charging' : pct >= 99 ? 'full' : driving ? 'running' : 'full'}`;

  if (pct < 15 && !lowBatteryWarned && !bot.charging) {
    lowBatteryWarned = true;
    toast('Battery low — click the battery chip to charge', 'warn', 3200);
  }
  if (pct > 25) lowBatteryWarned = false;
}

/* ---------------------------------------------------------------- help */

const HELP_HTML = `
<p>A playable model of the <b>UBTECH JIMU GrabberBot</b> (BuilderBots kit) and its app,
built to the kit's real hardware numbers.</p>

<h4>The robot</h4>
<ul>
  <li><b>4 servos</b> — #1/#2 drive the treads in <i>wheel mode</i> (five speed presets, up to 600 °/s),
      #3/#4 run the arm and claw in <i>joint mode</i> (moves take 80–5000 ms, like the real app).</li>
  <li><b>IR distance sensor</b> reading 2–80 cm.</li>
  <li><b>RGB LED eye</b>, and a 1200 mAh battery that actually drains.</li>
</ul>

<h4>Tabs</h4>
<ul>
  <li><b>Drive</b> — joystick, arm/claw sliders, LED, sounds, and eight action buttons.</li>
  <li><b>Actions</b> — JIMU's Pose·Record·Play: build a movement out of postures, each with its own time.</li>
  <li><b>Code</b> — Scratch-style blocks. <code>{ }</code> shows your program as Swift, like the JIMU app does.</li>
  <li><b>Missions</b> — five challenges the simulator checks for you.</li>
</ul>

<h4>Keyboard</h4>
<ul>
  <li><code>W A S D</code> or arrows — drive · <code>Space</code> — all stop</li>
  <li><code>Q</code> / <code>E</code> — open / grab claw · <code>R</code> / <code>F</code> — arm up / down</li>
  <li><code>[</code> <code>]</code> — wheel speed preset</li>
</ul>

<p style="opacity:.7;margin-top:14px">Nothing here talks to real hardware — the Bluetooth chip is decorative.</p>`;

$('helpBody').innerHTML = HELP_HTML;
updateBatteryChip();
requestAnimationFrame(frame);
