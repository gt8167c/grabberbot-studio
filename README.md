# 🦾 GrabberBot Studio

A simulator and Scratch-style visual programming environment for the **UBTECH JIMU
GrabberBot** (BuilderBots kit, JR0405) — the tracked excavator build with the long
arm and claw.

Drive it, pose it, program it with blocks, and run missions, all in the browser.
Nothing talks to real hardware; the Bluetooth chip in the header is decorative.

Four tabs — **Drive**, **Actions**, **Code**, **Missions** — beside a live 3D
arena with a top-down minimap.

---

## Running it

Needs [Node.js](https://nodejs.org) 18 or newer. Works the same on macOS, Windows
and Linux.

```bash
npm install
```

```bash
npm run dev
```

Then open <http://localhost:5173>.

### No-install option

`npm run build` produces **`dist/index.html`** as one fully self-contained file —
no server, no network. Double-click it, or drag it into any browser. That single
file is the whole app, so it also works from a USB stick or a shared drive.

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Single-file production build → `dist/index.html` |
| `npm run build:artifact` | Also emits `dist/artifact.html` (body fragment for embedding) |
| `npm run typecheck` | TypeScript check, no emit |

---

## What's modelled

Everything below comes from the kit's published specs and the official JIMU
manual, so the numbers on screen are the real ones.

### Servos (4)

| ID | Job | Mode | Range |
| --- | --- | --- | --- |
| #1 | Left tread | wheel | continuous, 5 speed presets |
| #2 | Right tread | wheel | continuous, 5 speed presets |
| #3 | Arm boom | joint | mechanical travel −15°…75° |
| #4 | Claw | joint | 0° clamped … 70° wide |

* Joint moves take **80–5000 ms**, exactly the window the JIMU app enforces, and
  are clamped to what 600 °/s (0.1 s per 60°) can physically deliver.
* Wheel speeds are the five real presets — very slow / slow / normal / fast /
  very fast — mapped to 120 / 240 / 360 / 480 / 600 °/s.
* Servo torque, tread geometry and track width feed a differential-drive model,
  so turns and speeds behave like the physical robot.

### Sensors and electronics

* **IR distance sensor** — reads 2–80 cm, raycast across a small cone; 80 means
  nothing in range.
* **RGB LED eye** — programmable colour, casts real light in the 3D scene.
* **1200 mAh LiPo** — drains under load, recharges when you click the battery
  chip. The power dot mirrors the real control box: red charging, green charged,
  flashing green while running.
* The control box has **no speaker** — on the real robot the phone makes the
  noise, so all sounds here are synthesised in WebAudio.

---

## The four tabs

**Drive** — virtual joystick (or `WASD`/arrows), the five wheel-speed presets,
arm and claw sliders, LED swatches, a sound board, eight assignable action
buttons, and live telemetry: IR sparkline, per-servo readouts, battery.

**Actions** — JIMU's *Pose · Record · Play*, as a keyframe timeline. Each posture
carries its own transition time, plus optional LED, sound and drive steps.
"Capture pose" snapshots the robot's current servo angles. Five actions ship
built in; yours are saved to `localStorage`.

**Code** — [Blockly](https://developers.google.com/blockly) with the `zelos`
renderer, so it looks and snaps together like Scratch. Categories: Events, Drive,
Arm & Claw, Light, Sound, Sensing, Control, Operators, Variables. Programs run on
a custom async interpreter that walks the block tree, which gives live block
highlighting, an instant stop, and concurrent hat blocks. The `{ }` button shows
your blocks as Swift — the same trick the real JIMU app does.

**Missions** — five checked challenges: First Drive, Careful Parking (hold
8–12 cm on the IR for two seconds), Grab & Deliver, Cone Slalom (no bumps), and
Night Shift. Completions persist.

---

## Keyboard

| Keys | Action |
| --- | --- |
| `W` `A` `S` `D` / arrows | Drive |
| `Space` | All stop |
| `Q` / `E` | Open / grab claw |
| `R` / `F` | Arm to carry / floor |
| `[` `]` | Wheel speed preset down / up |
| `Esc` | Close dialogs |

---

## Layout

```
src/
  sim/      spec.ts      hardware numbers, single source of truth
            robot.ts     servos, kinematics, battery
            world.ts     arena physics, IR raycast, grab logic
            scheduler.ts sim-time clock driving every wait
            audio.ts     WebAudio sound synthesis
  view/     scene3d.ts   Three.js arena + GrabberBot model
            minimap.ts   top-down radar
  ui/       control.ts   Drive tab      actions.ts  Actions tab (PRP)
            blocks.ts    block palette  coding.ts   Blockly host + examples
            runner.ts    interpreter + Swift codegen
            missions.ts  challenges     ui-kit.ts   toasts, modals, confetti
```

The simulation never reads the DOM and the views never write simulation state,
so the physics can be driven headlessly — handy for testing.

`window.gbs` exposes `{ world, scene, sched, actions, control, coding, missions }`
in the browser console if you want to poke at the robot directly:

```js
gbs.world.robot.driveDir('forward')
```

---

## Known simplifications

* Cargo is grabbed when it falls inside the claw's reach with the fingers closed;
  there is no finger-level contact physics.
* Objects slide rather than tumble, and never stack.
* The arm is modelled as one straight boom for both physics and rendering, rather
  than the real two-link boom-and-stick linkage.
