import {
  AdditiveBlending,
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
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
function particleTexture(): CanvasTexture {
  if (dotTex) return dotTex;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.7)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  dotTex = new CanvasTexture(canvas);
  return dotTex;
}

export function burst3d(group: Object3D, pos: Vector3, color: number, count = 16, power = 1) {
  for (let i = 0; i < count; i++) {
    const mat = new SpriteMaterial({ map: particleTexture(), color, transparent: true, depthWrite: false, blending: AdditiveBlending });
    const sprite = new Sprite(mat);
    const s = (0.05 + Math.random() * 0.06) * (0.7 + power * 0.5);
    sprite.scale.set(s, s, s);
    sprite.position.copy(pos);
    group.add(sprite);

    const angle = Math.random() * Math.PI * 2;
    const upBias = 0.35 + Math.random() * 0.5;
    const dist = (0.55 + Math.random() * 0.7) * power;
    const target = new Vector3(pos.x + Math.cos(angle) * dist, pos.y + upBias * dist * 0.6, pos.z + Math.sin(angle) * dist);

    gsap.to(sprite.position, {
      x: target.x,
      y: pos.y - 0.05,
      z: target.z,
      duration: 0.5 + Math.random() * 0.2,
      ease: 'power2.out',
      onComplete: () => {
        group.remove(sprite);
        mat.dispose();
      },
    });
    gsap.to(sprite.position, { y: target.y, duration: 0.22, ease: 'power1.out', yoyo: true, repeat: 1 });
    gsap.to(mat, { opacity: 0, duration: 0.5, ease: 'power2.out' });
  }
}

export function ring3d(group: Object3D, pos: Vector3, color: number, maxRadius = 0.6) {
  const geo = new RingGeometry(0.02, 0.05, 40);
  const mat = new MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: 2, depthWrite: false, blending: AdditiveBlending });
  const mesh = new Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.copy(pos);
  mesh.position.y += 0.02;
  group.add(mesh);

  const state = { r: 0.05 };
  gsap.to(state, {
    r: maxRadius,
    duration: 0.42,
    ease: 'power2.out',
    onUpdate: () => {
      mesh.scale.set(state.r / 0.05, state.r / 0.05, 1);
    },
  });
  gsap.to(mat, {
    opacity: 0,
    duration: 0.42,
    ease: 'power2.out',
    onComplete: () => {
      group.remove(mesh);
      geo.dispose();
      mat.dispose();
    },
  });
}

/** A glossy sphere arcs from `from` to `to`, spinning along its travel axis like a real rolling/flying ball. */
export function travelOrb3d(
  group: Object3D,
  from: Vector3,
  to: Vector3,
  material: MeshPhysicalMaterial,
  geometry: SphereGeometry,
  radius: number
): Promise<void> {
  return new Promise((resolve) => {
    const mesh = new Mesh(geometry, material);
    mesh.position.copy(from);
    mesh.castShadow = true;
    group.add(mesh);

    const dir = new Vector3().subVectors(to, from);
    const dist = Math.max(0.0001, dir.length());
    const spinAxis = new Vector3(-dir.z, 0, dir.x).normalize();
    const spinAmount = (dist / radius) * 0.9;

    const arcHeight = dist * 0.42 + 0.22;
    const baseY = from.y;
    const path = { t: 0 };

    gsap.to(path, {
      t: 1,
      duration: 0.24 + Math.random() * 0.05,
      ease: 'power1.in',
      onUpdate: () => {
        const t = path.t;
        mesh.position.x = from.x + (to.x - from.x) * t;
        mesh.position.z = from.z + (to.z - from.z) * t;
        mesh.position.y = baseY + Math.sin(Math.PI * t) * arcHeight;
        mesh.rotateOnWorldAxis(spinAxis, (spinAmount * (1 / 60)) / 0.28);
        const s = 1 + t * 0.15;
        mesh.scale.set(s, s, s);
      },
      onComplete: () => {
        group.remove(mesh);
        resolve();
      },
    });
  });
}

export function shakeCamera(camera: OrthographicCamera, basePos: Vector3, amount = 0.12) {
  const start = basePos.clone();
  const tl = gsap.timeline({
    onComplete: () => {
      camera.position.copy(start);
    },
  });
  const p1 = start.clone().add(new Vector3(amount, 0, -amount * 0.5));
  const p2 = start.clone().add(new Vector3(-amount * 0.7, 0, amount * 0.4));
  const p3 = start.clone().add(new Vector3(amount * 0.4, 0, -amount * 0.25));
  tl.to(camera.position, { x: p1.x, z: p1.z, duration: 0.045 })
    .to(camera.position, { x: p2.x, z: p2.z, duration: 0.05 })
    .to(camera.position, { x: p3.x, z: p3.z, duration: 0.05 })
    .to(camera.position, { x: start.x, z: start.z, duration: 0.06 });
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
