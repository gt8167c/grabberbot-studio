/**
 * Three.js view of the arena. Nothing here decides anything — it reads World
 * state every frame and poses the meshes to match.
 *
 * The robot is built from the same numbers the physics uses (ARM.reach,
 * CLAW.hingeOffsetX, …), so what you see is literally where the claw is.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { ARENA, ARM, CHASSIS, CLAW, IR } from '../sim/spec';
import type { World, Cargo } from '../sim/world';

/* ------------------------------------------------------------------ helpers */

/** Box with softened edges — plastic parts never have knife-sharp corners. */
function roundedBox(w: number, h: number, d: number, r = 0.006): THREE.BufferGeometry {
  const rr = Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4);
  const s = new THREE.Shape();
  s.moveTo(-w / 2 + rr, -h / 2);
  s.lineTo(w / 2 - rr, -h / 2);
  s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + rr);
  s.lineTo(w / 2, h / 2 - rr);
  s.quadraticCurveTo(w / 2, h / 2, w / 2 - rr, h / 2);
  s.lineTo(-w / 2 + rr, h / 2);
  s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - rr);
  s.lineTo(-w / 2, -h / 2 + rr);
  s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + rr, -h / 2);

  const bevel = Math.min(rr * 0.6, d / 2 - 1e-4);
  const inner = Math.max(1e-4, d - bevel * 2);
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: inner,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 5,
  });
  geo.translate(0, 0, -inner / 2);
  geo.computeVertexNormals();
  return geo;
}

const TREAD_R = 0.031;
const TREAD_HALF = CHASSIS.bodyLength / 2 - TREAD_R;

/**
 * Walk the tread's stadium outline. `s` is arc length around the loop, so
 * grousers travel the straights *and* wrap the sprockets like a real belt.
 */
function stadiumAt(s: number, lift = 0): { x: number; y: number; rot: number } {
  const straight = TREAD_HALF * 2;
  const arc = Math.PI * TREAD_R;
  const perimeter = straight * 2 + arc * 2;
  let t = ((s % perimeter) + perimeter) % perimeter;

  let x: number, y: number, rot: number;
  if (t < straight) {
    x = -TREAD_HALF + t; y = TREAD_R; rot = 0;
  } else if ((t -= straight) < arc) {
    const th = Math.PI / 2 - (t / arc) * Math.PI;
    x = TREAD_HALF + Math.cos(th) * TREAD_R; y = Math.sin(th) * TREAD_R; rot = Math.PI / 2 - th;
  } else if ((t -= arc) < straight) {
    x = TREAD_HALF - t; y = -TREAD_R; rot = Math.PI;
  } else {
    t -= straight;
    const th = -Math.PI / 2 - (t / arc) * Math.PI;
    x = -TREAD_HALF + Math.cos(th) * TREAD_R; y = Math.sin(th) * TREAD_R; rot = Math.PI / 2 - th;
  }

  // Outward normal is (sin rot, cos rot) in this profile, so grousers can be
  // seated proud of the belt instead of sunk halfway into it.
  return { x: x + Math.sin(rot) * lift, y: y + Math.cos(rot) * lift, rot };
}

/** Subtle worn-concrete floor, generated rather than shipped as an asset. */
function floorTexture(): THREE.Texture {
  const n = 512;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d')!;
  g.fillStyle = '#242c39';
  g.fillRect(0, 0, n, n);

  const img = g.getImageData(0, 0, n, n);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = (Math.random() - 0.5) * 16;
    img.data[i] += v;
    img.data[i + 1] += v;
    img.data[i + 2] += v;
  }
  g.putImageData(img, 0, 0);

  g.strokeStyle = 'rgba(255,255,255,0.035)';
  g.lineWidth = 2;
  for (let i = 1; i < 4; i++) {
    const p = (i / 4) * n;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, n); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(n, p); g.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/* ------------------------------------------------------------------- scene */

export class Scene3D {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;

  private botGroup = new THREE.Group();
  private armPivot = new THREE.Group();
  private clawLeft = new THREE.Group();
  private clawRight = new THREE.Group();
  private ledMesh!: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
  private ledLight!: THREE.PointLight;
  private beam!: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  private beamDot!: THREE.Mesh;
  /** Grousers per side, animated around the belt loop. */
  private grousers: Array<{ mesh: THREE.Mesh; base: number; side: number }> = [];
  private beltOffset = { left: 0, right: 0 };

  private cargoMeshes = new Map<string, THREE.Object3D>();
  private staticGroup = new THREE.Group();

  // Shared materials — one instance each keeps the draw calls cheap.
  private mat!: {
    yellow: THREE.MeshPhysicalMaterial;
    yellowDim: THREE.MeshPhysicalMaterial;
    dark: THREE.MeshPhysicalMaterial;
    servo: THREE.MeshPhysicalMaterial;
    rubber: THREE.MeshStandardMaterial;
    metal: THREE.MeshStandardMaterial;
    glass: THREE.MeshPhysicalMaterial;
  };

  followCam = true;
  private lastFollow = new THREE.Vector3(0, 1.5, -2.4);

  constructor(private host: HTMLElement, private world: World) {
    this.scene.background = new THREE.Color(0x0a0e15);
    this.scene.fog = new THREE.Fog(0x0a0e15, 4.5, 9.5);

    this.camera = new THREE.PerspectiveCamera(46, 1, 0.03, 60);
    this.camera.position.set(1.9, 1.6, -2.1);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Filmic response + a real IBL is most of what separates "toy render" from
    // "photo of a toy".
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    host.appendChild(this.renderer.domElement);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.42;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.45;
    this.controls.maxDistance = 7;
    this.controls.maxPolarAngle = Math.PI / 2.06;
    this.controls.target.set(0, 0.1, 0);
    this.controls.addEventListener('start', () => { this.followCam = false; this.onFollowChange?.(false); });

    this.buildMaterials();
    this.buildLights();
    this.buildArena();
    this.buildRobot();
    this.scene.add(this.staticGroup);

    this.resize();
    new ResizeObserver(() => this.resize()).observe(host);
  }

  onFollowChange?: (on: boolean) => void;

  // ---------------------------------------------------------------- build

  private buildMaterials(): void {
    const plastic = (color: number, extra: Partial<THREE.MeshPhysicalMaterialParameters> = {}) =>
      new THREE.MeshPhysicalMaterial({
        color,
        roughness: 0.38,
        metalness: 0,
        clearcoat: 0.65,
        clearcoatRoughness: 0.28,
        ...extra,
      });

    this.mat = {
      yellow: plastic(0xf5b700),
      yellowDim: plastic(0xd39a00, { roughness: 0.5, clearcoat: 0.4 }),
      dark: plastic(0x232a36, { roughness: 0.48 }),
      servo: plastic(0xe9edf3, { roughness: 0.42, clearcoat: 0.5 }),
      rubber: new THREE.MeshStandardMaterial({ color: 0x14181f, roughness: 0.95, metalness: 0.02 }),
      metal: new THREE.MeshStandardMaterial({ color: 0x9aa4b2, roughness: 0.32, metalness: 0.92 }),
      glass: new THREE.MeshPhysicalMaterial({
        color: 0x9fd8ff, roughness: 0.08, metalness: 0, transmission: 0.85,
        thickness: 0.01, transparent: true, opacity: 0.55,
      }),
    };
  }

  private buildLights(): void {
    this.scene.add(new THREE.HemisphereLight(0xbcd8ff, 0x141a24, 0.5));

    const key = new THREE.DirectionalLight(0xfff2dc, 2.4);
    key.position.set(2.2, 3.6, 1.9);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const d = 2.1;
    key.shadow.camera.left = -d;
    key.shadow.camera.right = d;
    key.shadow.camera.top = d;
    key.shadow.camera.bottom = -d;
    key.shadow.camera.far = 12;
    key.shadow.normalBias = 0.02;
    key.shadow.bias = -0.0004;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0x8fbcff, 0.55);
    fill.position.set(-2.4, 1.5, -1.2);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0x35d0ff, 0.7);
    rim.position.set(-1.2, 1.1, -2.6);
    this.scene.add(rim);
  }

  private buildArena(): void {
    const half = ARENA.half;

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(half * 2, half * 2),
      new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.88, metalness: 0.04 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // Low perimeter walls with a hazard-stripe cap.
    const t = 0.045;
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x2a3444, roughness: 0.72, metalness: 0.08 });
    const specs: Array<[number, number, number, number]> = [
      [0, half + t / 2, half * 2 + t * 2, t],
      [0, -half - t / 2, half * 2 + t * 2, t],
      [half + t / 2, 0, t, half * 2],
      [-half - t / 2, 0, t, half * 2],
    ];
    for (const [x, z, sx, sz] of specs) {
      const w = new THREE.Mesh(roundedBox(sx, ARENA.wallHeight, sz, 0.008), wallMat);
      w.position.set(x, ARENA.wallHeight / 2, z);
      w.castShadow = true;
      w.receiveShadow = true;
      this.scene.add(w);

      const cap = new THREE.Mesh(
        new THREE.BoxGeometry(sx, 0.014, sz),
        new THREE.MeshStandardMaterial({ color: 0xf5b700, roughness: 0.45, metalness: 0.15 }),
      );
      cap.position.set(x, ARENA.wallHeight + 0.007, z);
      cap.castShadow = true;
      this.scene.add(cap);
    }
  }

  /** One tread assembly: belt, sprockets, road wheels, side frame, grousers. */
  private buildTread(side: number): THREE.Group {
    const g = new THREE.Group();
    const width = 0.052;

    // Belt body — a stadium profile extruded across the tread width.
    const shape = new THREE.Shape();
    shape.absarc(TREAD_HALF, 0, TREAD_R, -Math.PI / 2, Math.PI / 2, false);
    shape.absarc(-TREAD_HALF, 0, TREAD_R, Math.PI / 2, (3 * Math.PI) / 2, false);
    shape.closePath();
    const beltGeo = new THREE.ExtrudeGeometry(shape, {
      depth: width, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.003, bevelSegments: 2, curveSegments: 16,
    });
    beltGeo.translate(0, 0, -width / 2);
    beltGeo.rotateY(-Math.PI / 2); // profile runs fore/aft, extrusion across the hull
    const belt = new THREE.Mesh(beltGeo, this.mat.rubber);
    belt.castShadow = true;
    belt.receiveShadow = true;
    g.add(belt);

    // Drive sprocket (rear) and idler (front), plus small road wheels.
    for (const [zEnd, isSprocket] of [[-1, true], [1, false]] as Array<[number, boolean]>) {
      const hub = new THREE.Mesh(
        new THREE.CylinderGeometry(TREAD_R * 0.66, TREAD_R * 0.66, width + 0.008, 20),
        this.mat.metal,
      );
      hub.rotation.z = Math.PI / 2;
      hub.position.set(0, 0, zEnd * TREAD_HALF);
      hub.castShadow = true;
      g.add(hub);

      if (isSprocket) {
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          const tooth = new THREE.Mesh(new THREE.BoxGeometry(width + 0.012, 0.009, 0.009), this.mat.metal);
          tooth.position.set(0, Math.sin(a) * TREAD_R * 0.72, zEnd * TREAD_HALF + Math.cos(a) * TREAD_R * 0.72);
          tooth.rotation.x = -a;
          g.add(tooth);
        }
      }
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(TREAD_R * 0.3, TREAD_R * 0.3, width + 0.016, 12), this.mat.yellowDim);
      cap.rotation.z = Math.PI / 2;
      cap.position.set(0, 0, zEnd * TREAD_HALF);
      g.add(cap);
    }
    for (const zz of [-0.035, 0.035]) {
      const rw = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, width - 0.006, 14), this.mat.dark);
      rw.rotation.z = Math.PI / 2;
      rw.position.set(0, -TREAD_R * 0.45, zz);
      g.add(rw);
    }

    // Small yellow side plate between the wheels — enough to read as structure
    // without hiding the belt and grousers running around it.
    const frame = new THREE.Mesh(roundedBox(0.078, 0.026, 0.009, 0.005), this.mat.yellow);
    frame.rotation.y = Math.PI / 2;
    frame.position.set(side * (width / 2 + 0.004), 0, 0);
    frame.castShadow = true;
    g.add(frame);

    // Grousers: evenly spaced around the loop, advanced by wheel speed.
    const count = 20;
    const perimeter = TREAD_HALF * 4 + Math.PI * TREAD_R * 2;
    const grouserGeo = new THREE.BoxGeometry(width + 0.006, 0.007, 0.016);
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(grouserGeo, this.mat.dark);
      m.castShadow = true;
      g.add(m);
      this.grousers.push({ mesh: m, base: (i / count) * perimeter, side });
    }

    g.position.set((side * CHASSIS.bodyWidth) / 2, TREAD_R, 0);
    g.name = side < 0 ? 'treadL' : 'treadR';
    return g;
  }

  private buildControlBox(): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.Mesh(roundedBox(0.096, 0.056, 0.082, 0.008), this.mat.dark);
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);

    const panel = new THREE.Mesh(roundedBox(0.074, 0.004, 0.062, 0.004), this.mat.servo);
    panel.position.y = 0.029;
    g.add(panel);

    // Power indicator, mirrored from the header chip.
    const pwr = new THREE.Mesh(
      new THREE.CylinderGeometry(0.004, 0.004, 0.003, 10),
      new THREE.MeshStandardMaterial({ color: 0x3ddc55, emissive: 0x3ddc55, emissiveIntensity: 1.6 }),
    );
    pwr.position.set(-0.026, 0.032, 0.02);
    g.add(pwr);

    // Servo bus ports along the flank.
    for (let i = 0; i < 3; i++) {
      const port = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.009, 0.013), this.mat.metal);
      port.position.set(0.049, 0.004, -0.024 + i * 0.024);
      g.add(port);
    }
    return g;
  }

  private buildArm(): void {
    const shoulder = new THREE.Group();
    shoulder.position.set(0, 0.1, 0.045);

    // Shoulder servo body straddling the pivot.
    const body = new THREE.Mesh(roundedBox(0.052, 0.048, 0.042, 0.006), this.mat.servo);
    body.castShadow = true;
    shoulder.add(body);
    for (const s of [-1, 1]) {
      const horn = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.006, 16), this.mat.yellowDim);
      horn.rotation.z = Math.PI / 2;
      horn.position.x = s * 0.027;
      shoulder.add(horn);
    }
    this.botGroup.add(shoulder);

    // --- boom ---
    const boom = new THREE.Mesh(roundedBox(0.03, 0.034, ARM.boomLength, 0.007), this.mat.yellow);
    boom.position.set(0, 0, ARM.boomLength / 2);
    boom.castShadow = true;
    this.armPivot.add(boom);
    // Lightening holes, like the real connector beams.
    for (let i = 0; i < 3; i++) {
      const hole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.006, 0.006, 0.034, 10),
        this.mat.yellowDim,
      );
      hole.rotation.x = Math.PI / 2;
      hole.rotation.z = Math.PI / 2;
      hole.position.set(0, 0, 0.028 + i * 0.026);
      this.armPivot.add(hole);
    }

    // --- elbow servo ---
    const elbow = new THREE.Mesh(roundedBox(0.044, 0.04, 0.036, 0.006), this.mat.servo);
    elbow.position.set(0, 0, ARM.boomLength);
    elbow.castShadow = true;
    this.armPivot.add(elbow);

    // --- stick ---
    const stick = new THREE.Mesh(roundedBox(0.024, 0.026, ARM.forearmLength, 0.006), this.mat.dark);
    stick.position.set(0, 0, ARM.boomLength + ARM.forearmLength / 2);
    stick.castShadow = true;
    this.armPivot.add(stick);

    // --- claw servo at the wrist ---
    const hingeZ = ARM.boomLength + ARM.forearmLength;
    const wrist = new THREE.Mesh(roundedBox(0.04, 0.034, 0.026, 0.005), this.mat.servo);
    wrist.position.set(0, 0, hingeZ - 0.012);
    wrist.castShadow = true;
    this.armPivot.add(wrist);

    // --- fingers ---
    // Left finger sits at -X and must swing further -X to open, so its rotation
    // is the negative of the spread; the right one mirrors it.
    for (const side of [-1, 1]) {
      const finger = side < 0 ? this.clawLeft : this.clawRight;
      finger.position.set(side * CLAW.hingeOffsetX, 0, hingeZ);

      const hinge = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.026, 12), this.mat.metal);
      hinge.rotation.x = Math.PI / 2;
      hinge.rotation.z = Math.PI / 2;
      finger.add(hinge);

      const jaw = new THREE.Mesh(roundedBox(0.013, 0.028, CLAW.fingerLength, 0.005), this.mat.yellow);
      jaw.position.set(0, 0, CLAW.fingerLength / 2);
      jaw.castShadow = true;
      finger.add(jaw);

      // Grip pad on the inner face, at exactly the distance the solver uses.
      const pad = new THREE.Mesh(
        roundedBox(0.005, 0.022, 0.026, 0.002),
        new THREE.MeshStandardMaterial({ color: 0x1b1f27, roughness: 0.9 }),
      );
      pad.position.set(-side * 0.008, 0, CLAW.padDistance);
      finger.add(pad);

      // Tip hooks inward so the jaws look like they can actually cradle a load.
      const tipGeo = roundedBox(0.011, 0.024, 0.026, 0.004);
      const tip = new THREE.Mesh(tipGeo, this.mat.yellowDim);
      tip.position.set(-side * 0.007, 0, CLAW.fingerLength + 0.008);
      tip.rotation.y = -side * 0.5;
      tip.castShadow = true;
      finger.add(tip);

      this.armPivot.add(finger);
    }
  }

  /** A couple of servo cables, because the real robot is full of them. */
  private buildCables(): void {
    const mk = (pts: THREE.Vector3[]) => {
      const curve = new THREE.CatmullRomCurve3(pts);
      const mesh = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 24, 0.0035, 6, false),
        new THREE.MeshStandardMaterial({ color: 0x11151b, roughness: 0.7 }),
      );
      mesh.castShadow = true;
      return mesh;
    };
    this.botGroup.add(mk([
      new THREE.Vector3(0.05, 0.118, -0.03),
      new THREE.Vector3(0.058, 0.135, 0.005),
      new THREE.Vector3(0.03, 0.122, 0.038),
      new THREE.Vector3(0.024, 0.105, 0.045),
    ]));
    this.botGroup.add(mk([
      new THREE.Vector3(0.05, 0.108, -0.04),
      new THREE.Vector3(0.07, 0.085, -0.06),
      new THREE.Vector3(0.078, 0.05, -0.07),
    ]));
  }

  private buildRobot(): void {
    this.botGroup.add(this.buildTread(-1));
    this.botGroup.add(this.buildTread(1));

    // --- hull ---
    const deck = new THREE.Mesh(roundedBox(CHASSIS.bodyWidth - 0.012, 0.028, CHASSIS.bodyLength - 0.02, 0.01), this.mat.yellow);
    deck.position.y = 0.076;
    deck.castShadow = true;
    deck.receiveShadow = true;
    this.botGroup.add(deck);

    const skirt = new THREE.Mesh(roundedBox(CHASSIS.bodyWidth - 0.03, 0.03, CHASSIS.bodyLength - 0.05, 0.008), this.mat.dark);
    skirt.position.y = 0.05;
    skirt.castShadow = true;
    this.botGroup.add(skirt);

    // Connector studs across the deck — the JIMU look.
    for (let ix = -1; ix <= 1; ix++) {
      for (let iz = -1; iz <= 1; iz++) {
        const stud = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.005, 10), this.mat.yellowDim);
        stud.position.set(ix * 0.042, 0.092, iz * 0.05 - 0.01);
        this.botGroup.add(stud);
      }
    }

    const box = this.buildControlBox();
    box.position.set(0, 0.118, -0.048);
    this.botGroup.add(box);

    // --- cab + LED eye ---
    const cab = new THREE.Mesh(roundedBox(0.084, 0.056, 0.066, 0.011), this.mat.yellow);
    cab.position.set(0, 0.118, 0.036);
    cab.castShadow = true;
    this.botGroup.add(cab);

    const visor = new THREE.Mesh(roundedBox(0.07, 0.03, 0.005, 0.004), this.mat.glass);
    visor.position.set(0, 0.128, 0.07);
    this.botGroup.add(visor);

    const bezel = new THREE.Mesh(new THREE.TorusGeometry(0.019, 0.005, 10, 22), this.mat.dark);
    bezel.position.set(0, 0.118, 0.0705);
    this.botGroup.add(bezel);

    this.ledMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.017, 24, 18),
      new THREE.MeshStandardMaterial({ color: 0x35d0ff, emissive: 0x35d0ff, emissiveIntensity: 2.4, roughness: 0.2 }),
    );
    this.ledMesh.position.set(0, 0.118, 0.071);
    this.botGroup.add(this.ledMesh);

    this.ledLight = new THREE.PointLight(0x35d0ff, 0.9, 1.2);
    this.ledLight.position.set(0, 0.12, 0.085);
    this.botGroup.add(this.ledLight);

    // --- IR sensor module ---
    const irBody = new THREE.Mesh(roundedBox(0.052, 0.026, 0.016, 0.004), this.mat.dark);
    irBody.position.set(0, CHASSIS.irOffset.up, CHASSIS.irOffset.forward);
    irBody.castShadow = true;
    this.botGroup.add(irBody);
    for (const lensX of [-0.013, 0.013]) {
      const lens = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0075, 0.0075, 0.004, 14),
        new THREE.MeshPhysicalMaterial({ color: 0x2a1010, roughness: 0.12, metalness: 0.1, clearcoat: 1 }),
      );
      lens.rotation.x = Math.PI / 2;
      lens.position.set(lensX, CHASSIS.irOffset.up, CHASSIS.irOffset.forward + 0.009);
      this.botGroup.add(lens);
    }

    this.beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.004, 0.028, 1, 14, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xff3b3b, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.beam.rotation.x = Math.PI / 2;
    this.botGroup.add(this.beam);

    this.beamDot = new THREE.Mesh(
      new THREE.SphereGeometry(0.014, 14, 10),
      new THREE.MeshBasicMaterial({ color: 0xff3b3b, transparent: true, opacity: 0.8, depthWrite: false }),
    );
    this.botGroup.add(this.beamDot);

    this.botGroup.add(this.armPivot);
    this.armPivot.position.set(0, 0.1, 0.045);
    this.buildArm();
    this.buildCables();

    this.scene.add(this.botGroup);
  }

  // ---------------------------------------------------------------- arena sync

  syncArena(): void {
    this.staticGroup.clear();
    this.cargoMeshes.clear();

    for (const z of this.world.zones) {
      const col = new THREE.Color(z.color);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(z.radius - 0.022, z.radius, 48),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(z.x, 0.004, z.z);
      this.staticGroup.add(ring);

      const fill = new THREE.Mesh(
        new THREE.CircleGeometry(z.radius - 0.022, 48),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.1, side: THREE.DoubleSide }),
      );
      fill.rotation.x = -Math.PI / 2;
      fill.position.set(z.x, 0.003, z.z);
      this.staticGroup.add(fill);
    }

    for (const o of this.world.obstacles) {
      if (o.kind === 'cone') {
        const cone = new THREE.Mesh(
          new THREE.ConeGeometry(o.radius, o.height, 24),
          new THREE.MeshStandardMaterial({ color: new THREE.Color(o.color), roughness: 0.55 }),
        );
        cone.position.set(o.x, o.height / 2, o.z);
        cone.castShadow = true;
        this.staticGroup.add(cone);

        const band = new THREE.Mesh(
          new THREE.CylinderGeometry(o.radius * 0.62, o.radius * 0.72, 0.018, 24),
          new THREE.MeshStandardMaterial({ color: 0xf2f4f8, roughness: 0.5 }),
        );
        band.position.set(o.x, o.height * 0.46, o.z);
        this.staticGroup.add(band);

        const base = new THREE.Mesh(roundedBox(o.radius * 2.2, 0.014, o.radius * 2.2, 0.004), this.mat.dark);
        base.position.set(o.x, 0.007, o.z);
        base.castShadow = true;
        base.receiveShadow = true;
        this.staticGroup.add(base);
      } else {
        const block = new THREE.Mesh(
          roundedBox(o.radius * 1.8, o.height, o.radius * 1.8, 0.01),
          new THREE.MeshStandardMaterial({ color: new THREE.Color(o.color), roughness: 0.7, metalness: 0.1 }),
        );
        block.position.set(o.x, o.height / 2, o.z);
        block.castShadow = true;
        block.receiveShadow = true;
        this.staticGroup.add(block);
      }
    }

    for (const c of this.world.cargo) {
      const obj = this.makeCargoMesh(c);
      this.cargoMeshes.set(c.id, obj);
      this.staticGroup.add(obj);
    }
  }

  private makeCargoMesh(c: Cargo): THREE.Object3D {
    const col = new THREE.Color(c.color);
    const mat = new THREE.MeshPhysicalMaterial({
      color: col,
      roughness: 0.4,
      metalness: 0.08,
      clearcoat: 0.5,
      clearcoatRoughness: 0.3,
      emissive: col.clone().multiplyScalar(0.1),
    });

    const group = new THREE.Group();
    let mesh: THREE.Mesh;
    if (c.kind === 'crate') {
      mesh = new THREE.Mesh(roundedBox(c.radius * 1.6, c.height, c.radius * 1.6, 0.006), mat);
      const strap = new THREE.Mesh(
        new THREE.BoxGeometry(c.radius * 1.66, 0.007, c.radius * 1.66),
        new THREE.MeshStandardMaterial({ color: 0xf3f6fa, roughness: 0.45 }),
      );
      group.add(strap);
    } else if (c.kind === 'barrel') {
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(c.radius, c.radius, c.height, 24), mat);
      for (const yy of [-c.height * 0.26, c.height * 0.26]) {
        const rib = new THREE.Mesh(
          new THREE.TorusGeometry(c.radius * 1.02, 0.004, 8, 24),
          new THREE.MeshStandardMaterial({ color: 0x2b323d, roughness: 0.6 }),
        );
        rib.rotation.x = Math.PI / 2;
        rib.position.y = yy;
        group.add(rib);
      }
    } else {
      mesh = new THREE.Mesh(new THREE.SphereGeometry(c.radius, 28, 20), mat);
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return group;
  }

  // ---------------------------------------------------------------- per frame

  update(dt: number): void {
    const bot = this.world.robot;

    this.botGroup.position.set(bot.x, 0, bot.z);
    this.botGroup.rotation.y = bot.heading;

    // Belts advance at true tread speed and carry the grousers around the loop.
    const { left, right } = bot.wheelSpeedMs;
    this.beltOffset.left += left * dt;
    this.beltOffset.right += right * dt;
    for (const gr of this.grousers) {
      const off = gr.side < 0 ? this.beltOffset.left : this.beltOffset.right;
      const p = stadiumAt(gr.base + off, 0.0035);
      // Profile x is fore/aft (mesh z); +rot tips the plate's face from up to
      // forward, matching the outward normal as it wraps the sprocket.
      gr.mesh.position.set(0, p.y, p.x);
      gr.mesh.rotation.x = p.rot;
    }

    this.armPivot.rotation.x = -(bot.armAngle * Math.PI) / 180;

    // Higher claw angle = wider gap. Left finger swings -X, right swings +X.
    const spread = (bot.clawAngle / CLAW.max) * CLAW.maxSpreadRad;
    this.clawLeft.rotation.y = -spread;
    this.clawRight.rotation.y = spread;

    // LED
    const mat = this.ledMesh.material;
    if (bot.ledColor) {
      const col = new THREE.Color(bot.ledColor);
      mat.color.copy(col);
      mat.emissive.copy(col);
      mat.emissiveIntensity = 2.6;
      this.ledLight.color.copy(col);
      this.ledLight.intensity = 1;
    } else {
      mat.color.setHex(0x2b3038);
      mat.emissive.setHex(0x000000);
      mat.emissiveIntensity = 0;
      this.ledLight.intensity = 0;
    }

    // IR beam length tracks the live reading.
    const distM = bot.irDistance / 100;
    const hit = bot.irDistance < IR.maxRange - 0.5;
    this.beam.scale.set(1, distM, 1);
    this.beam.position.set(0, CHASSIS.irOffset.up, CHASSIS.irOffset.forward + distM / 2);
    const beamMat = this.beam.material;
    beamMat.opacity = hit ? 0.28 : 0.09;
    beamMat.color.setHex(bot.irDistance < 15 ? 0xff3b3b : 0x35d0ff);
    this.beamDot.visible = hit;
    this.beamDot.position.set(0, CHASSIS.irOffset.up, CHASSIS.irOffset.forward + distM);
    (this.beamDot.material as THREE.MeshBasicMaterial).color.copy(beamMat.color);

    // Cargo
    for (const c of this.world.cargo) {
      const m = this.cargoMeshes.get(c.id);
      if (!m) continue;
      m.position.set(c.x, c.y, c.z);
      m.rotation.y += c.spin * dt;
      if (c.held) m.rotation.y = bot.heading;
    }

    // Camera
    if (this.followCam) {
      const f = bot.forward;
      const want = new THREE.Vector3(bot.x - f.x * 0.95 + 0.15, 0.82, bot.z - f.z * 0.95);
      this.lastFollow.lerp(want, Math.min(1, dt * 3.2));
      this.camera.position.copy(this.lastFollow);
      this.controls.target.lerp(new THREE.Vector3(bot.x, 0.14, bot.z), Math.min(1, dt * 4.5));
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  setFollow(on: boolean): void {
    this.followCam = on;
    if (on) this.lastFollow.copy(this.camera.position);
  }

  resize(): void {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    // updateStyle must stay on: without it the canvas keeps its drawing-buffer
    // size in CSS pixels and overflows the pane, hiding most of the scene.
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
