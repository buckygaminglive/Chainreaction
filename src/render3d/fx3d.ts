import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  type Material,
  Object3D,
  OrthographicCamera,
  RingGeometry,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three';
import gsap from 'gsap';
import { emojiTexture } from './emojiTexture';

let dotTex: CanvasTexture | null = null;
/** Soft round dot, shared by every spark, flash and halo. */
export function particleTexture(): CanvasTexture {
  if (dotTex) return dotTex;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.75)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  dotTex = new CanvasTexture(canvas);
  return dotTex;
}

let haloTex: CanvasTexture | null = null;
/** A wider, flatter falloff than the spark dot — this one sits under a whole
 *  cluster of orbs, and a hot centre there reads as a fifth orb. */
export function haloTexture(): CanvasTexture {
  if (haloTex) return haloTex;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.32)');
  g.addColorStop(0.75, 'rgba(255,255,255,0.08)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  haloTex = new CanvasTexture(canvas);
  return haloTex;
}

interface Particle {
  sprite: Sprite;
  mat: SpriteMaterial;
  vel: Vector3;
  age: number;
  life: number;
  size: number;
  /** Multiplier on size over the particle's life: <1 shrinks, >1 grows. */
  grow: number;
  gravity: number;
  /** Fraction of vertical speed kept on hitting the board. 0 = sticks. */
  bounce: number;
  alpha: number;
}

interface Ring {
  mesh: Mesh;
  mat: MeshBasicMaterial;
  age: number;
  life: number;
  radius: number;
  alpha: number;
}

/** Height of the board's top surface, where sparks land and skid. */
const FLOOR_Y = 0.15;

/**
 * Every transient effect on the board — sparks, shockwaves, flashes, trails.
 *
 * Pooled and simulated here, once per frame, rather than one GSAP tween and
 * one freshly allocated material per spark. A long cascade used to create and
 * dispose hundreds of materials a second, which is exactly the garbage a
 * low-end phone's WebView stutters on; now the same few hundred objects are
 * reused for the life of the board.
 *
 * Sparks are real (if tiny) physics: launched with a velocity, pulled down by
 * gravity, and they bounce and skid when they hit the board instead of
 * fading out in mid-air on a fixed curve.
 */
export class Fx {
  private group: Object3D;
  private pool: Particle[] = [];
  private live: Particle[] = [];
  private rings: Ring[] = [];
  private liveRings: Ring[] = [];
  private ringGeo = new RingGeometry(0.82, 1, 48);
  private scratch = new Color();
  /** Spark budget, scaled with the render tier. */
  private density = 1;

  constructor(group: Object3D, maxParticles = 260, maxRings = 28) {
    this.group = group;
    const tex = particleTexture();
    for (let i = 0; i < maxParticles; i++) {
      const mat = new SpriteMaterial({
        map: tex,
        color: 0xffffff,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      });
      const sprite = new Sprite(mat);
      sprite.visible = false;
      sprite.renderOrder = 5;
      group.add(sprite);
      this.pool.push({ sprite, mat, vel: new Vector3(), age: 0, life: 1, size: 0.1, grow: 1, gravity: 0, bounce: 0, alpha: 1 });
    }
    for (let i = 0; i < maxRings; i++) {
      const mat = new MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        side: DoubleSide,
        depthWrite: false,
        blending: AdditiveBlending,
      });
      const mesh = new Mesh(this.ringGeo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      mesh.renderOrder = 4;
      group.add(mesh);
      this.rings.push({ mesh, mat, age: 0, life: 1, radius: 1, alpha: 1 });
    }
  }

  /** 1 = full effects, lower on weaker hardware. */
  setDensity(d: number) {
    this.density = Math.max(0.3, Math.min(1, d));
  }

  private take(): Particle | null {
    const p = this.pool.pop();
    if (p) return p;
    // Out of sparks: recycle the oldest live one. A long cascade should lose
    // its faintest trails, not stop spawning new bursts.
    const oldest = this.live.shift();
    return oldest ?? null;
  }

  private spawn(pos: Vector3, color: number, opts: Partial<Omit<Particle, 'sprite' | 'mat' | 'vel'>> & { vel?: Vector3 }) {
    const p = this.take();
    if (!p) return;
    p.age = 0;
    p.life = opts.life ?? 0.6;
    p.size = opts.size ?? 0.08;
    p.grow = opts.grow ?? 0.4;
    p.gravity = opts.gravity ?? 0;
    p.bounce = opts.bounce ?? 0;
    p.alpha = opts.alpha ?? 1;
    p.vel.copy(opts.vel ?? new Vector3());
    p.sprite.position.copy(pos);
    p.sprite.scale.set(p.size, p.size, 1);
    p.mat.color.copy(this.scratch.set(color));
    p.mat.opacity = p.alpha;
    p.sprite.visible = true;
    this.live.push(p);
  }

  /** Sparks thrown out of a blast, in the owner's colour with a few hot white
   *  ones mixed in so a burst has a core rather than being one flat tone. */
  burst(pos: Vector3, color: number, count = 16, power = 1) {
    const n = Math.max(3, Math.round(count * this.density));
    for (let i = 0; i < n; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = (1.4 + Math.random() * 2.2) * power;
      const up = (1.2 + Math.random() * 2.4) * power;
      const hot = Math.random() < 0.22;
      this.spawn(pos, hot ? 0xffffff : color, {
        vel: new Vector3(Math.cos(angle) * speed, up, Math.sin(angle) * speed),
        life: 0.45 + Math.random() * 0.45,
        size: (0.05 + Math.random() * 0.07) * (0.8 + power * 0.35),
        grow: 0.25,
        gravity: 9.5,
        bounce: 0.42,
        alpha: hot ? 1 : 0.9,
      });
    }
  }

  /** A short-lived bright bloom at the heart of a blast. */
  flash(pos: Vector3, color: number, size = 1.2) {
    this.spawn(pos, 0xffffff, { life: 0.16, size: size * 0.35, grow: 2.8, alpha: 0.95 });
    this.spawn(pos, color, { life: 0.3, size: size * 0.5, grow: 2.2, alpha: 0.75 });
  }

  /** One mote left behind by a flying particle. */
  trail(pos: Vector3, color: number, size = 0.16) {
    if (Math.random() > this.density) return;
    this.spawn(pos, color, {
      life: 0.22 + Math.random() * 0.1,
      size,
      grow: 0.2,
      alpha: 0.55,
      vel: new Vector3((Math.random() - 0.5) * 0.3, 0.2, (Math.random() - 0.5) * 0.3),
    });
  }

  /** Expanding shockwave on the board surface. */
  ring(pos: Vector3, color: number, maxRadius = 0.6, life = 0.42) {
    const r = this.rings.pop() ?? this.liveRings.shift();
    if (!r) return;
    r.age = 0;
    r.life = life;
    r.radius = maxRadius;
    r.alpha = 0.9;
    r.mat.color.set(color);
    r.mat.opacity = r.alpha;
    r.mesh.position.set(pos.x, FLOOR_Y + 0.012, pos.z);
    r.mesh.scale.set(0.01, 0.01, 1);
    r.mesh.visible = true;
    this.liveRings.push(r);
  }

  update(dt: number) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.age += dt;
      const t = p.age / p.life;
      if (t >= 1) {
        p.sprite.visible = false;
        this.live.splice(i, 1);
        this.pool.push(p);
        continue;
      }
      const pos = p.sprite.position;
      if (p.gravity) p.vel.y -= p.gravity * dt;
      pos.addScaledVector(p.vel, dt);
      if (p.bounce > 0 && pos.y < FLOOR_Y) {
        pos.y = FLOOR_Y;
        p.vel.y = -p.vel.y * p.bounce;
        // Friction on contact, so a spark skids to a stop instead of bouncing
        // across the whole board.
        p.vel.x *= 0.62;
        p.vel.z *= 0.62;
      }
      const s = p.size * (1 + (p.grow - 1) * t);
      p.sprite.scale.set(s, s, 1);
      p.mat.opacity = p.alpha * (1 - t) * (1 - t * 0.35);
    }

    for (let i = this.liveRings.length - 1; i >= 0; i--) {
      const r = this.liveRings[i];
      r.age += dt;
      const t = r.age / r.life;
      if (t >= 1) {
        r.mesh.visible = false;
        this.liveRings.splice(i, 1);
        this.rings.push(r);
        continue;
      }
      // Fast out, slow settle: a shockwave is mostly over in its first third.
      const e = 1 - Math.pow(1 - t, 3);
      const s = Math.max(0.01, r.radius * e);
      r.mesh.scale.set(s, s, 1);
      r.mat.opacity = r.alpha * (1 - t);
    }
  }

  dispose() {
    for (const p of [...this.pool, ...this.live]) {
      this.group.remove(p.sprite);
      p.mat.dispose();
    }
    for (const r of [...this.rings, ...this.liveRings]) {
      this.group.remove(r.mesh);
      r.mat.dispose();
    }
    this.ringGeo.dispose();
    this.pool = [];
    this.live = [];
    this.rings = [];
    this.liveRings = [];
  }
}

/** A glossy sphere arcs from `from` to `to`, tumbling in flight and leaving
 *  a short trail, then lands with a squash. `speed` > 1 flies faster — deep
 *  into a cascade every wave is quicker than the last. */
export function travelOrb3d(
  group: Object3D,
  from: Vector3,
  to: Vector3,
  material: Material,
  geometry: SphereGeometry,
  radius: number,
  opts: { speed?: number; fx?: Fx; color?: number } = {}
): Promise<void> {
  const speed = opts.speed ?? 1;
  return new Promise((resolve) => {
    const mesh = new Mesh(geometry, material);
    mesh.position.copy(from);
    mesh.castShadow = true;
    group.add(mesh);

    const dir = new Vector3().subVectors(to, from);
    const dist = Math.max(0.0001, dir.length());
    const tumbleSpeed = (dist / radius) * 0.9;
    const wx = (Math.random() * 2 - 1) * tumbleSpeed;
    const wy = (Math.random() * 2 - 1) * tumbleSpeed;
    const wz = (Math.random() * 2 - 1) * tumbleSpeed;

    const arcHeight = dist * 0.55 + 0.25;
    const baseY = from.y;
    const path = { t: 0 };
    let frame = 0;

    gsap.to(path, {
      t: 1,
      duration: (0.26 + Math.random() * 0.05) / speed,
      ease: 'power1.inOut',
      onUpdate: () => {
        const t = path.t;
        mesh.position.x = from.x + (to.x - from.x) * t;
        mesh.position.z = from.z + (to.z - from.z) * t;
        mesh.position.y = baseY + Math.sin(Math.PI * t) * arcHeight;
        const dt = 1 / 60 / 0.28;
        mesh.rotateX(wx * dt);
        mesh.rotateY(wy * dt);
        mesh.rotateZ(wz * dt);
        // Stretched along the direction of travel at the fastest point of the
        // arc, round again at either end.
        const stretch = 1 + Math.sin(Math.PI * t) * 0.18;
        mesh.scale.set(stretch, 1 / Math.sqrt(stretch), stretch);
        if (opts.fx && opts.color !== undefined && (frame++ & 1) === 0) {
          opts.fx.trail(mesh.position, opts.color, radius * 1.1);
        }
      },
      onComplete: () => {
        group.remove(mesh);
        resolve();
      },
    });
  });
}

/** The shake currently driving the camera, if any. Held so it can be killed
 *  outright rather than merely having its tweens removed. */
let activeShake: gsap.core.Timeline | null = null;

export function shakeCamera(camera: OrthographicCamera, basePos: Vector3, amount = 0.12) {
  // A fast cascade fires this once per wave in quick succession, so the
  // previous shake has to be stopped before the next begins.
  //
  // Killing the timeline itself (not just its tweens) is what stops an old
  // shake's onComplete snapping the camera back mid-way through the new one —
  // which read exactly as the board glitching during a long chain.
  activeShake?.kill();
  camera.position.copy(basePos);

  const start = basePos.clone();
  const tl = gsap.timeline({
    onComplete: () => {
      camera.position.copy(start);
      activeShake = null;
    },
  });
  activeShake = tl;
  const baseAngle = Math.random() * Math.PI * 2;
  const p1 = start.clone().add(new Vector3(Math.cos(baseAngle) * amount, 0, Math.sin(baseAngle) * amount));
  const p2 = start
    .clone()
    .add(new Vector3(Math.cos(baseAngle + 2.4) * amount * 0.55, 0, Math.sin(baseAngle + 2.4) * amount * 0.55));
  const p3 = start
    .clone()
    .add(new Vector3(Math.cos(baseAngle + 4.4) * amount * 0.25, 0, Math.sin(baseAngle + 4.4) * amount * 0.25));
  tl.to(camera.position, { x: p1.x, z: p1.z, duration: 0.03 })
    .to(camera.position, { x: p2.x, z: p2.z, duration: 0.04 })
    .to(camera.position, { x: p3.x, z: p3.z, duration: 0.04 })
    .to(camera.position, { x: start.x, z: start.z, duration: 0.05, ease: 'power2.out' });
}

let activePunch: gsap.core.Tween | null = null;
/** A brief zoom-in on a big blast. Kept tiny; anything larger reads as the
 *  board lurching rather than as impact. */
export function punchCamera(camera: OrthographicCamera, amount = 0.03) {
  activePunch?.kill();
  camera.zoom = 1;
  const state = { z: 1 + amount };
  camera.zoom = state.z;
  camera.updateProjectionMatrix();
  activePunch = gsap.to(state, {
    z: 1,
    duration: 0.32,
    ease: 'power3.out',
    onUpdate: () => {
      camera.zoom = state.z;
      camera.updateProjectionMatrix();
    },
    onComplete: () => {
      activePunch = null;
    },
  });
}

export function emojiPop3d(group: Object3D, pos: Vector3, char: string, size: number) {
  const mat = new SpriteMaterial({ map: emojiTexture(char), transparent: true, depthWrite: false });
  const sprite = new Sprite(mat);
  sprite.position.copy(pos);
  sprite.scale.set(size * 0.3, size * 0.3, 1);
  group.add(sprite);

  const tl = gsap.timeline({
    onComplete: () => {
      group.remove(sprite);
      mat.dispose();
    },
  });
  tl.to(sprite.scale, { x: size * 1.3, y: size * 1.3, duration: 0.18, ease: 'back.out(3)' })
    .to(sprite.scale, { x: size, y: size, duration: 0.14 })
    .to(sprite.position, { y: pos.y + 0.35, duration: 0.28 }, '<')
    .to(mat, { opacity: 0, duration: 0.22 }, '+=0.02');
}
