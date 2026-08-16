/**
 * Three.js view of the arena. Nothing here decides anything — it reads World
 * state every frame and poses the meshes to match.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ARENA, ARM, CHASSIS, CLAW, IR } from '../sim/spec';
import type { World, Cargo } from '../sim/world';

const JIMU_YELLOW = 0xffc400;
const JIMU_DARK = 0x2b3646;

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
  private treadMats: THREE.MeshStandardMaterial[] = [];
  private beam!: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  private beamDot!: THREE.Mesh;

  private cargoMeshes = new Map<string, THREE.Object3D>();
  private staticGroup = new THREE.Group();

  followCam = true;
  private lastFollow = new THREE.Vector3(0, 1.5, -2.4);

  constructor(private host: HTMLElement, private world: World) {
    this.scene.background = new THREE.Color(0x080b11);
    this.scene.fog = new THREE.Fog(0x080b11, 4.5, 9);

    this.camera = new THREE.PerspectiveCamera(48, 1, 0.05, 60);
    this.camera.position.set(1.9, 1.6, -2.1);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.6;
    this.controls.maxDistance = 7;
    this.controls.maxPolarAngle = Math.PI / 2.06;
    this.controls.target.set(0, 0.1, 0);
    // Any manual camera nudge drops out of follow mode, like a real chase cam.
    this.controls.addEventListener('start', () => { this.followCam = false; this.onFollowChange?.(false); });

    this.buildLights();
    this.buildArena();
    this.buildRobot();
    this.scene.add(this.staticGroup);

    this.resize();
    new ResizeObserver(() => this.resize()).observe(host);
  }

  onFollowChange?: (on: boolean) => void;

  // ---------------------------------------------------------------- build

  private buildLights(): void {
    this.scene.add(new THREE.HemisphereLight(0x9fc4ff, 0x1a2030, 1.05));

    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(2.4, 4, 2);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const d = 2.2;
    key.shadow.camera.left = -d;
    key.shadow.camera.right = d;
    key.shadow.camera.top = d;
    key.shadow.camera.bottom = -d;
    key.shadow.camera.far = 12;
    key.shadow.bias = -0.0012;
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x35d0ff, 0.6);
    rim.position.set(-2.5, 1.6, -2.2);
    this.scene.add(rim);
  }

  private buildArena(): void {
    const half = ARENA.half;

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(half * 2, half * 2),
      new THREE.MeshStandardMaterial({ color: 0x1b2330, roughness: 0.92, metalness: 0.05 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const grid = new THREE.GridHelper(half * 2, 10, 0x35d0ff, 0x2b3646);
    (grid.material as THREE.Material).opacity = 0.22;
    (grid.material as THREE.Material).transparent = true;
    grid.position.y = 0.002;
    this.scene.add(grid);

    // Low perimeter walls with a hazard-stripe cap.
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x263140, roughness: 0.8 });
    const capMat = new THREE.MeshStandardMaterial({ color: JIMU_YELLOW, roughness: 0.55, emissive: 0x1a1200 });
    const t = 0.04;
    const specs: Array<[number, number, number, number]> = [
      [0, half + t / 2, half * 2 + t * 2, t],
      [0, -half - t / 2, half * 2 + t * 2, t],
      [half + t / 2, 0, t, half * 2],
      [-half - t / 2, 0, t, half * 2],
    ];
    for (const [x, z, sx, sz] of specs) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(sx, ARENA.wallHeight, sz), wallMat);
      w.position.set(x, ARENA.wallHeight / 2, z);
      w.castShadow = true;
      w.receiveShadow = true;
      this.scene.add(w);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.012, sz), capMat);
      cap.position.set(x, ARENA.wallHeight + 0.006, z);
      this.scene.add(cap);
    }
  }

  private buildRobot(): void {
    const bodyMat = new THREE.MeshStandardMaterial({ color: JIMU_YELLOW, roughness: 0.42, metalness: 0.22 });
    const darkMat = new THREE.MeshStandardMaterial({ color: JIMU_DARK, roughness: 0.7, metalness: 0.3 });
    const servoMat = new THREE.MeshStandardMaterial({ color: 0xe8edf5, roughness: 0.5 });

    // --- treads ---
    for (const side of [-1, 1]) {
      const treadGroup = new THREE.Group();
      const treadMat = new THREE.MeshStandardMaterial({ color: 0x1a1f28, roughness: 0.95 });
      this.treadMats.push(treadMat);

      const belt = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.062, CHASSIS.bodyLength), treadMat);
      belt.castShadow = true;
      treadGroup.add(belt);

      // Rounded ends: two capsule-ish cylinders acting as drive sprockets.
      for (const zEnd of [-1, 1]) {
        const wheel = new THREE.Mesh(
          new THREE.CylinderGeometry(0.031, 0.031, 0.052, 18),
          new THREE.MeshStandardMaterial({ color: 0x39404d, roughness: 0.6, metalness: 0.35 }),
        );
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(0, 0, (zEnd * CHASSIS.bodyLength) / 2);
        wheel.castShadow = true;
        treadGroup.add(wheel);
      }
      // Grouser bars, so rotation is visible.
      for (let i = 0; i < 8; i++) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(0.056, 0.008, 0.012), darkMat);
        const zz = -CHASSIS.bodyLength / 2 + (i / 8) * CHASSIS.bodyLength;
        bar.position.set(0, 0.033, zz);
        treadGroup.add(bar);
        (treadGroup as any)[`bar${i}`] = bar;
      }
      treadGroup.position.set((side * CHASSIS.bodyWidth) / 2, 0.032, 0);
      treadGroup.name = side < 0 ? 'treadL' : 'treadR';
      this.botGroup.add(treadGroup);
    }

    // --- chassis ---
    const chassis = new THREE.Mesh(
      new THREE.BoxGeometry(CHASSIS.bodyWidth - 0.02, 0.045, CHASSIS.bodyLength - 0.03),
      bodyMat,
    );
    chassis.position.y = 0.072;
    chassis.castShadow = true;
    chassis.receiveShadow = true;
    this.botGroup.add(chassis);

    // The control box rides on the deck, like the real build.
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.052, 0.078), darkMat);
    box.position.set(0, 0.12, -0.045);
    box.castShadow = true;
    this.botGroup.add(box);
    const boxTop = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.004, 0.058), servoMat);
    boxTop.position.set(0, 0.147, -0.045);
    this.botGroup.add(boxTop);

    // --- cab + LED eye ---
    const cab = new THREE.Mesh(new THREE.BoxGeometry(0.086, 0.06, 0.07), bodyMat);
    cab.position.set(0, 0.125, 0.032);
    cab.castShadow = true;
    this.botGroup.add(cab);

    this.ledMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.021, 24, 18),
      new THREE.MeshStandardMaterial({ color: 0x35d0ff, emissive: 0x35d0ff, emissiveIntensity: 2.2, roughness: 0.25 }),
    );
    this.ledMesh.position.set(0, 0.133, 0.07);
    this.botGroup.add(this.ledMesh);
    this.ledLight = new THREE.PointLight(0x35d0ff, 0.85, 1.1);
    this.ledLight.position.copy(this.ledMesh.position);
    this.botGroup.add(this.ledLight);

    // --- IR sensor + beam ---
    const ir = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.024, 0.016), new THREE.MeshStandardMaterial({ color: 0x11151c, roughness: 0.4 }));
    ir.position.set(0, CHASSIS.irOffset.up, CHASSIS.irOffset.forward);
    this.botGroup.add(ir);
    for (const lensX of [-0.013, 0.013]) {
      const lens = new THREE.Mesh(
        new THREE.CylinderGeometry(0.007, 0.007, 0.004, 12),
        new THREE.MeshStandardMaterial({ color: 0x2a3340, emissive: 0x220000, roughness: 0.2 }),
      );
      lens.rotation.x = Math.PI / 2;
      lens.position.set(lensX, CHASSIS.irOffset.up, CHASSIS.irOffset.forward + 0.009);
      this.botGroup.add(lens);
    }

    this.beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.004, 0.03, 1, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xff3b3b, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.beam.rotation.x = Math.PI / 2;
    this.botGroup.add(this.beam);

    this.beamDot = new THREE.Mesh(
      new THREE.SphereGeometry(0.016, 12, 10),
      new THREE.MeshBasicMaterial({ color: 0xff3b3b, transparent: true, opacity: 0.75, depthWrite: false }),
    );
    this.botGroup.add(this.beamDot);

    // --- arm: shoulder servo, boom, stick, claw ---
    const shoulder = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.05, 16), servoMat);
    shoulder.rotation.z = Math.PI / 2;
    shoulder.position.set(0, 0.1, 0.045);
    this.botGroup.add(shoulder);

    this.armPivot.position.set(0, 0.1, 0.045);
    this.botGroup.add(this.armPivot);

    const boom = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.03, ARM.boomLength), bodyMat);
    boom.position.set(0, 0, ARM.boomLength / 2);
    boom.castShadow = true;
    this.armPivot.add(boom);

    const elbow = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.04, 14), servoMat);
    elbow.rotation.z = Math.PI / 2;
    elbow.position.set(0, 0, ARM.boomLength);
    this.armPivot.add(elbow);

    const stick = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.024, ARM.forearmLength), darkMat);
    stick.position.set(0, 0, ARM.boomLength + ARM.forearmLength / 2);
    stick.castShadow = true;
    this.armPivot.add(stick);

    // Claw fingers hinge at the end of the stick.
    const reach = ARM.boomLength + ARM.forearmLength;
    for (const side of [-1, 1]) {
      const g = side < 0 ? this.clawLeft : this.clawRight;
      g.position.set(side * 0.014, 0, reach);
      const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.026, 0.055), bodyMat);
      jaw.position.set(0, 0, 0.026);
      jaw.castShadow = true;
      g.add(jaw);
      const tip = new THREE.Mesh(new THREE.BoxGeometry(0.011, 0.022, 0.03), darkMat);
      tip.position.set(side * -0.008, 0, 0.062);
      tip.rotation.y = side * 0.42;
      g.add(tip);
      this.armPivot.add(g);
    }

    this.scene.add(this.botGroup);
  }

  // ---------------------------------------------------------------- sync

  /** Rebuild the meshes for cargo/obstacles/zones after an arena change. */
  syncArena(): void {
    this.staticGroup.clear();
    this.cargoMeshes.clear();

    for (const z of this.world.zones) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(z.radius - 0.02, z.radius, 40),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(z.color), transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(z.x, 0.004, z.z);
      this.staticGroup.add(ring);

      const fill = new THREE.Mesh(
        new THREE.CircleGeometry(z.radius - 0.02, 40),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(z.color), transparent: true, opacity: 0.11, side: THREE.DoubleSide }),
      );
      fill.rotation.x = -Math.PI / 2;
      fill.position.set(z.x, 0.003, z.z);
      this.staticGroup.add(fill);
    }

    for (const o of this.world.obstacles) {
      let mesh: THREE.Mesh;
      if (o.kind === 'cone') {
        mesh = new THREE.Mesh(
          new THREE.ConeGeometry(o.radius, o.height, 18),
          new THREE.MeshStandardMaterial({ color: new THREE.Color(o.color), roughness: 0.6 }),
        );
        mesh.position.set(o.x, o.height / 2, o.z);
        const base = new THREE.Mesh(
          new THREE.BoxGeometry(o.radius * 2.1, 0.012, o.radius * 2.1),
          new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.85 }),
        );
        base.position.set(o.x, 0.006, o.z);
        base.receiveShadow = true;
        this.staticGroup.add(base);
      } else {
        mesh = new THREE.Mesh(
          new THREE.BoxGeometry(o.radius * 1.7, o.height, o.radius * 1.7),
          new THREE.MeshStandardMaterial({ color: new THREE.Color(o.color), roughness: 0.75 }),
        );
        mesh.position.set(o.x, o.height / 2, o.z);
      }
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.staticGroup.add(mesh);
    }

    for (const c of this.world.cargo) {
      const obj = this.makeCargoMesh(c);
      this.cargoMeshes.set(c.id, obj);
      this.staticGroup.add(obj);
    }
  }

  private makeCargoMesh(c: Cargo): THREE.Object3D {
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(c.color),
      roughness: 0.45,
      metalness: 0.15,
      emissive: new THREE.Color(c.color).multiplyScalar(0.12),
    });
    let geo: THREE.BufferGeometry;
    if (c.kind === 'crate') geo = new THREE.BoxGeometry(c.radius * 1.6, c.height, c.radius * 1.6);
    else if (c.kind === 'barrel') geo = new THREE.CylinderGeometry(c.radius, c.radius, c.height, 18);
    else geo = new THREE.SphereGeometry(c.radius, 20, 14);

    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const group = new THREE.Group();
    group.add(mesh);
    if (c.kind === 'crate') {
      const band = new THREE.Mesh(
        new THREE.BoxGeometry(c.radius * 1.68, 0.008, c.radius * 1.68),
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, transparent: true, opacity: 0.35 }),
      );
      group.add(band);
    }
    return group;
  }

  /** Called every frame with the elapsed sim time. */
  update(dt: number): void {
    const bot = this.world.robot;

    this.botGroup.position.set(bot.x, 0, bot.z);
    this.botGroup.rotation.y = bot.heading;

    // Tread grousers scroll at wheel speed for a sense of motion.
    const { left, right } = bot.wheelSpeedMs;
    for (const name of ['treadL', 'treadR'] as const) {
      const g = this.botGroup.getObjectByName(name) as THREE.Group | undefined;
      if (!g) continue;
      const speed = name === 'treadL' ? left : right;
      for (let i = 0; i < 8; i++) {
        const bar = (g as any)[`bar${i}`] as THREE.Mesh | undefined;
        if (!bar) continue;
        let z = bar.position.z + speed * dt;
        const span = CHASSIS.bodyLength;
        while (z > span / 2) z -= span;
        while (z < -span / 2) z += span;
        bar.position.z = z;
      }
    }

    this.armPivot.rotation.x = -(bot.armAngle * Math.PI) / 180;

    const open = (bot.clawAngle / CLAW.max) * 0.5;
    this.clawLeft.rotation.y = open;
    this.clawRight.rotation.y = -open;

    // LED
    const mat = this.ledMesh.material;
    if (bot.ledColor) {
      const col = new THREE.Color(bot.ledColor);
      mat.color.copy(col);
      mat.emissive.copy(col);
      mat.emissiveIntensity = 2.4;
      this.ledLight.color.copy(col);
      this.ledLight.intensity = 0.9;
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
    beamMat.opacity = hit ? 0.3 : 0.1;
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
      const held = c.held;
      m.children.forEach((ch: THREE.Object3D) => {
        const mm = (ch as THREE.Mesh).material as THREE.MeshStandardMaterial;
        if (mm && mm.emissive) mm.emissiveIntensity = held ? 0.9 : 0.35;
      });
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
