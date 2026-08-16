/**
 * The block language: a Scratch-shaped palette (Blockly's `zelos` renderer)
 * whose vocabulary is GrabberBot's actual hardware — treads, arm, claw,
 * LED eye, IR sensor.
 */

import * as Blockly from 'blockly';

const C = {
  events: '#FFBF00',
  drive: '#4C97FF',
  arm: '#FF8A00',
  light: '#9966FF',
  sound: '#CF63CF',
  sensing: '#5CB1D6',
  control: '#FFAB19',
  operators: '#59C059',
  variables: '#FF8C1A',
};

const DIRS: Array<[string, string]> = [
  ['forward', 'forward'],
  ['backward', 'backward'],
  ['spin left', 'left'],
  ['spin right', 'right'],
];

const SPEEDS: Array<[string, string]> = [
  ['very slow', 'vslow'],
  ['slow', 'slow'],
  ['normal', 'normal'],
  ['fast', 'fast'],
  ['very fast', 'vfast'],
];

const COLORS: Array<[string, string]> = [
  ['red', '#ff2d2d'],
  ['orange', '#ff9f1c'],
  ['yellow', '#ffd21e'],
  ['green', '#3ddc55'],
  ['cyan', '#35d0ff'],
  ['violet', '#7a5cff'],
  ['white', '#ffffff'],
];

const SOUNDS: Array<[string, string]> = [
  ['horn', 'horn'],
  ['siren', 'siren'],
  ['chirp', 'chirp'],
  ['laser', 'laser'],
  ['beep', 'beep'],
];

const ARM_POSES: Array<[string, string]> = [
  ['up high', 'up'],
  ['carry', 'carry'],
  ['down to floor', 'floor'],
];

/** Number socket with a shadow value, so every slot arrives pre-filled. */
const num = (n: number) => ({ shadow: { type: 'math_number', fields: { NUM: n } } });

const BLOCKS: any[] = [
  // ---------------------------------------------------------------- events
  {
    type: 'gb_when_flag',
    message0: 'when ▶ clicked',
    nextStatement: null,
    colour: C.events,
    tooltip: 'Everything under here runs when you press Run.',
  },
  {
    type: 'gb_when_ir_below',
    message0: 'when object closer than %1 cm',
    args0: [{ type: 'input_value', name: 'CM', check: 'Number' }],
    nextStatement: null,
    colour: C.events,
    tooltip: 'Runs each time the IR sensor first sees something this close.',
  },

  // ---------------------------------------------------------------- drive
  {
    type: 'gb_drive_time',
    message0: 'drive %1 for %2 seconds',
    args0: [
      { type: 'field_dropdown', name: 'DIR', options: DIRS },
      { type: 'input_value', name: 'SECS', check: 'Number' },
    ],
    previousStatement: null, nextStatement: null, inputsInline: true,
    colour: C.drive,
    tooltip: 'Runs both tread servos in wheel mode, then stops.',
  },
  {
    type: 'gb_drive_distance',
    message0: 'drive %1 %2 cm',
    args0: [
      { type: 'field_dropdown', name: 'DIR', options: [['forward', 'forward'], ['backward', 'backward']] },
      { type: 'input_value', name: 'CM', check: 'Number' },
    ],
    previousStatement: null, nextStatement: null, inputsInline: true,
    colour: C.drive,
  },
  {
    type: 'gb_drive_start',
    message0: 'start driving %1',
    args0: [{ type: 'field_dropdown', name: 'DIR', options: DIRS }],
    previousStatement: null, nextStatement: null,
    colour: C.drive,
    tooltip: 'Starts the treads and moves straight on to the next block.',
  },
  {
    type: 'gb_stop_driving',
    message0: 'stop treads',
    previousStatement: null, nextStatement: null,
    colour: C.drive,
  },
  {
    type: 'gb_turn',
    message0: 'turn %1 %2 degrees',
    args0: [
      { type: 'field_dropdown', name: 'DIR', options: [['right ↻', 'right'], ['left ↺', 'left']] },
      { type: 'input_value', name: 'DEG', check: 'Number' },
    ],
    previousStatement: null, nextStatement: null, inputsInline: true,
    colour: C.drive,
  },
  {
    type: 'gb_set_speed',
    message0: 'set wheel speed to %1',
    args0: [{ type: 'field_dropdown', name: 'SPEED', options: SPEEDS }],
    previousStatement: null, nextStatement: null,
    colour: C.drive,
    tooltip: 'The five wheel-mode speeds a JIMU servo supports.',
  },
  {
    type: 'gb_set_wheels',
    message0: 'set treads: left %1 °/s  right %2 °/s',
    args0: [
      { type: 'input_value', name: 'L', check: 'Number' },
      { type: 'input_value', name: 'R', check: 'Number' },
    ],
    previousStatement: null, nextStatement: null, inputsInline: true,
    colour: C.drive,
    tooltip: 'Direct servo control, -600 to 600 °/s. Great for curves.',
  },

  // ---------------------------------------------------------------- arm/claw
  {
    type: 'gb_arm_pose',
    message0: 'move arm %1',
    args0: [{ type: 'field_dropdown', name: 'POSE', options: ARM_POSES }],
    previousStatement: null, nextStatement: null,
    colour: C.arm,
  },
  {
    type: 'gb_arm_to',
    message0: 'move arm to %1 ° over %2 ms',
    args0: [
      { type: 'input_value', name: 'ANGLE', check: 'Number' },
      { type: 'input_value', name: 'MS', check: 'Number' },
    ],
    previousStatement: null, nextStatement: null, inputsInline: true,
    colour: C.arm,
    tooltip: 'Joint mode: the servo takes 80–5000 ms to reach the angle.',
  },
  {
    type: 'gb_claw',
    message0: '%1 claw',
    args0: [{ type: 'field_dropdown', name: 'ACT', options: [['grab with', 'grab'], ['open', 'open']] }],
    previousStatement: null, nextStatement: null,
    colour: C.arm,
  },
  {
    type: 'gb_claw_to',
    message0: 'move claw to %1 ° over %2 ms',
    args0: [
      { type: 'input_value', name: 'ANGLE', check: 'Number' },
      { type: 'input_value', name: 'MS', check: 'Number' },
    ],
    previousStatement: null, nextStatement: null, inputsInline: true,
    colour: C.arm,
  },
  {
    type: 'gb_run_action',
    message0: 'play action %1',
    args0: [{ type: 'field_dropdown', name: 'ACTION', options: () => actionOptions() }],
    previousStatement: null, nextStatement: null,
    colour: C.arm,
    tooltip: 'Plays a movement you built on the Actions tab.',
  },

  // ---------------------------------------------------------------- light
  {
    type: 'gb_led',
    message0: 'set LED to %1',
    args0: [{ type: 'field_dropdown', name: 'COLOR', options: COLORS }],
    previousStatement: null, nextStatement: null,
    colour: C.light,
  },
  {
    type: 'gb_led_off',
    message0: 'turn LED off',
    previousStatement: null, nextStatement: null,
    colour: C.light,
  },
  {
    type: 'gb_led_blink',
    message0: 'blink LED %1 %2 times',
    args0: [
      { type: 'field_dropdown', name: 'COLOR', options: COLORS },
      { type: 'input_value', name: 'TIMES', check: 'Number' },
    ],
    previousStatement: null, nextStatement: null, inputsInline: true,
    colour: C.light,
  },

  // ---------------------------------------------------------------- sound
  {
    type: 'gb_sound',
    message0: 'play sound %1',
    args0: [{ type: 'field_dropdown', name: 'SOUND', options: SOUNDS }],
    previousStatement: null, nextStatement: null,
    colour: C.sound,
  },

  // ---------------------------------------------------------------- sensing
  {
    type: 'gb_ir',
    message0: 'IR distance (cm)',
    output: 'Number',
    colour: C.sensing,
    tooltip: 'Reads 2–80 cm. 80 means nothing is in range.',
  },
  {
    type: 'gb_ir_closer',
    message0: 'object closer than %1 cm?',
    args0: [{ type: 'input_value', name: 'CM', check: 'Number' }],
    output: 'Boolean', inputsInline: true,
    colour: C.sensing,
  },
  {
    type: 'gb_holding',
    message0: 'holding something?',
    output: 'Boolean',
    colour: C.sensing,
  },
  {
    type: 'gb_bumped',
    message0: 'bumped into something?',
    output: 'Boolean',
    colour: C.sensing,
  },
  {
    type: 'gb_battery',
    message0: 'battery %',
    output: 'Number',
    colour: C.sensing,
  },
  {
    type: 'gb_arm_angle',
    message0: 'arm angle',
    output: 'Number',
    colour: C.sensing,
  },

  // ---------------------------------------------------------------- control
  {
    type: 'gb_wait',
    message0: 'wait %1 seconds',
    args0: [{ type: 'input_value', name: 'SECS', check: 'Number' }],
    previousStatement: null, nextStatement: null, inputsInline: true,
    colour: C.control,
  },
  {
    type: 'gb_forever',
    message0: 'forever %1 %2',
    args0: [{ type: 'input_dummy' }, { type: 'input_statement', name: 'DO' }],
    previousStatement: null,
    colour: C.control,
    tooltip: 'Repeats until you press Stop.',
  },
  {
    type: 'gb_wait_until',
    message0: 'wait until %1',
    args0: [{ type: 'input_value', name: 'COND', check: 'Boolean' }],
    previousStatement: null, nextStatement: null, inputsInline: true,
    colour: C.control,
  },
  {
    type: 'gb_stop_program',
    message0: 'stop everything',
    previousStatement: null,
    colour: C.control,
  },
];

/** Actions dropdown is filled at runtime from the Actions tab. */
let actionOptionsProvider: () => Array<[string, string]> = () => [['—', '']];
export function setActionOptionsProvider(fn: () => Array<[string, string]>): void {
  actionOptionsProvider = fn;
}
function actionOptions(): Array<[string, string]> {
  const opts = actionOptionsProvider();
  return opts.length ? opts : [['—', '']];
}

/** Hat blocks need `block.hat` set; jsonInit does not cover it. */
const HATS = new Set(['gb_when_flag', 'gb_when_ir_below']);

export function defineBlocks(): void {
  for (const json of BLOCKS) {
    Blockly.Blocks[json.type] = {
      init(this: Blockly.Block) {
        this.jsonInit(json);
        if (HATS.has(json.type)) (this as any).hat = 'cap';
      },
    };
  }
}

export function buildTheme(): Blockly.Theme {
  return Blockly.Theme.defineTheme('grabberbot', {
    name: 'grabberbot',
    base: Blockly.Themes.Classic,
    componentStyles: {
      workspaceBackgroundColour: '#131a24',
      toolboxBackgroundColour: '#171e29',
      toolboxForegroundColour: '#e6edf6',
      flyoutBackgroundColour: '#1d2634',
      flyoutForegroundColour: '#93a3b8',
      flyoutOpacity: 1,
      scrollbarColour: '#3a4759',
      scrollbarOpacity: 0.5,
      insertionMarkerColour: '#ffc400',
      insertionMarkerOpacity: 0.7,
      markerColour: '#ffc400',
      cursorColour: '#ffc400',
      selectedGlowColour: '#ffc400',
      gridColour: '#222c3a',
    },
    fontStyle: { family: 'Inter, Segoe UI, system-ui, sans-serif', weight: 'bold', size: 11 },
    startHats: false,
  } as any);
}

export function buildToolbox(): any {
  return {
    kind: 'categoryToolbox',
    contents: [
      {
        kind: 'category', name: 'Events', colour: C.events,
        contents: [
          { kind: 'block', type: 'gb_when_flag' },
          { kind: 'block', type: 'gb_when_ir_below', inputs: { CM: num(15) } },
        ],
      },
      {
        kind: 'category', name: 'Drive', colour: C.drive,
        contents: [
          { kind: 'block', type: 'gb_drive_time', inputs: { SECS: num(1) } },
          { kind: 'block', type: 'gb_drive_distance', inputs: { CM: num(30) } },
          { kind: 'block', type: 'gb_turn', inputs: { DEG: num(90) } },
          { kind: 'block', type: 'gb_drive_start' },
          { kind: 'block', type: 'gb_stop_driving' },
          { kind: 'block', type: 'gb_set_speed' },
          { kind: 'block', type: 'gb_set_wheels', inputs: { L: num(300), R: num(180) } },
        ],
      },
      {
        kind: 'category', name: 'Arm & Claw', colour: C.arm,
        contents: [
          { kind: 'block', type: 'gb_arm_pose' },
          { kind: 'block', type: 'gb_claw' },
          { kind: 'block', type: 'gb_arm_to', inputs: { ANGLE: num(45), MS: num(700) } },
          { kind: 'block', type: 'gb_claw_to', inputs: { ANGLE: num(30), MS: num(400) } },
          { kind: 'block', type: 'gb_run_action' },
        ],
      },
      {
        kind: 'category', name: 'Light', colour: C.light,
        contents: [
          { kind: 'block', type: 'gb_led' },
          { kind: 'block', type: 'gb_led_off' },
          { kind: 'block', type: 'gb_led_blink', inputs: { TIMES: num(3) } },
        ],
      },
      {
        kind: 'category', name: 'Sound', colour: C.sound,
        contents: [{ kind: 'block', type: 'gb_sound' }],
      },
      {
        kind: 'category', name: 'Sensing', colour: C.sensing,
        contents: [
          { kind: 'block', type: 'gb_ir' },
          { kind: 'block', type: 'gb_ir_closer', inputs: { CM: num(15) } },
          { kind: 'block', type: 'gb_holding' },
          { kind: 'block', type: 'gb_bumped' },
          { kind: 'block', type: 'gb_arm_angle' },
          { kind: 'block', type: 'gb_battery' },
        ],
      },
      {
        kind: 'category', name: 'Control', colour: C.control,
        contents: [
          { kind: 'block', type: 'gb_wait', inputs: { SECS: num(1) } },
          { kind: 'block', type: 'controls_repeat_ext', inputs: { TIMES: num(4) } },
          { kind: 'block', type: 'gb_forever' },
          { kind: 'block', type: 'controls_if' },
          { kind: 'block', type: 'controls_if', extraState: { hasElse: true } },
          { kind: 'block', type: 'controls_whileUntil' },
          { kind: 'block', type: 'gb_wait_until' },
          { kind: 'block', type: 'gb_stop_program' },
        ],
      },
      {
        kind: 'category', name: 'Operators', colour: C.operators,
        contents: [
          { kind: 'block', type: 'math_number' },
          { kind: 'block', type: 'math_arithmetic', inputs: { A: num(1), B: num(1) } },
          { kind: 'block', type: 'math_random_int', inputs: { FROM: num(1), TO: num(10) } },
          { kind: 'block', type: 'logic_compare', inputs: { A: num(1), B: num(1) } },
          { kind: 'block', type: 'logic_operation' },
          { kind: 'block', type: 'logic_negate' },
          { kind: 'block', type: 'logic_boolean' },
        ],
      },
      { kind: 'category', name: 'Variables', colour: C.variables, custom: 'VARIABLE' },
    ],
  };
}

export { C as BLOCK_COLORS };
