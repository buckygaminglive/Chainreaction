import {
  ACESFilmicToneMapping,
  Clock,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  PCFSoftShadowMap,
  PlaneGeometry,
  Raycaster,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import gsap from 'gsap';
import type { GameEngine } from '../game/GameEngine';
import type { MoveEvent } from '../game/types';
import { layoutFor } from '../render/orbLayout';
import { CELL_IDLE, type ColorTheme } from '../render/theme';
import { EMOJI_STAGES, stageForRemaining } from '../render/emoji';
import { emojiTexture } from './emojiTexture';
import { burst3d, ring3d, shakeCamera, travelOrb3d } from './fx3d';

export type OrbStyle = 'dots' | 'emoji';

interface RenderCell {
  owner: number | null;
  orbs: number;
}

interface CellView {
  tile: Mesh;
  orbGroup: Group;
}

const CELL_SIZE = 1;
const TILE_HEIGHT = 0.14;
const ORB_RADIUS = 0.17;

export class ThreeRenderer {
  private engine: GameEngine;
  private colorOf: (playerId: number) => ColorTheme;
  private orbStyle: OrbStyle;

  private scene = new Scene();
  private camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  private renderer!: WebGLRenderer;
  private host!: HTMLElement;
  private boardGroup = new Group();
  private fxGroup = new Group();
  private raycaster = new Raycaster();
  private ro?: ResizeObserver;
  private raf = 0;
  private clock = new Clock();
  private t = 0;
  private baseCameraPos = new Vector3();
  private dirLight!: DirectionalLight;

  private cells: CellView[][] = [];
  private tileMeshes: Mesh[] = [];
  private renderState: RenderCell[][] = [];
  private tileGeo!: RoundedBoxGeometry;
  private orbGeo = new SphereGeometry(ORB_RADIUS, 24, 18);
  private neutralTileMat = new MeshStandardMaterial({ color: CELL_IDLE, roughness: 0.82, metalness: 0.04 });
  private tileMatCache = new Map<number, MeshStandardMaterial>();
  private orbMatCache = new Map<number, MeshPhysicalMaterial>();

  private onCellTap: (row: number, col: number) => void = () => {};
  private onPointerDownBound = (e: PointerEvent) => this.handlePointerDown(e);

  constructor(engine: GameEngine, colorOf: (playerId: number) => ColorTheme, orbStyle: OrbStyle = 'emoji') {
    this.engine = engine;
    this.colorOf = colorOf;
    this.orbStyle = orbStyle;
    this.camera.up.set(0, 0, -1);
  }

  setCellTapHandler(fn: (row: number, col: number) => void) {
    this.onCellTap = fn;
  }

  setOrbStyle(style: OrbStyle) {
    if (this.orbStyle === style) return;
    this.orbStyle = style;
    for (let r = 0; r < this.engine.rows; r++) {
      for (let c = 0; c < this.engine.cols; c++) this.drawCell(r, c);
    }
  }

  async init(host: HTMLElement) {
    this.host = host;
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.touchAction = 'none';
    host.appendChild(this.renderer.domElement);

    this.scene.add(this.boardGroup, this.fxGroup);
    this.setupLights();
    this.buildGrid();
    this.layout();

    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDownBound);
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(host);

    this.clock.start();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.tick();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  private setupLights() {
    const hemi = new HemisphereLight(0xcfe0ff, 0x140c28, 0.8);
    this.scene.add(hemi);

    this.dirLight = new DirectionalLight(0xfff2e0, 1.3);
    this.dirLight.position.set(2.4, 6, 3.2);
    this.dirLight.castShadow = true;
    this.dirLight.shadow.mapSize.set(1024, 1024);
    this.dirLight.shadow.bias = -0.002;
    this.scene.add(this.dirLight, this.dirLight.target);

    const fill = new DirectionalLight(0x8fb8ff, 0.32);
    fill.position.set(-3, 3, -2);
    this.scene.add(fill);
  }

  private buildGrid() {
    const rows = this.engine.rows;
    const cols = this.engine.cols;
    this.tileGeo = new RoundedBoxGeometry(CELL_SIZE * 0.9, TILE_HEIGHT, CELL_SIZE * 0.9, 3, 0.1);

    const boardW = cols * CELL_SIZE;
    const boardD = rows * CELL_SIZE;

    const floorGeo = new PlaneGeometry(boardW * 1.6, boardD * 1.6);
    const floorMat = new MeshStandardMaterial({ color: 0x0c0818, roughness: 1 });
    const floor = new Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.03;
    floor.receiveShadow = true;
    this.boardGroup.add(floor);

    for (let r = 0; r < rows; r++) {
      const rowCells: CellView[] = [];
      const rowState: RenderCell[] = [];
      for (let c = 0; c < cols; c++) {
        const x = (c - (cols - 1) / 2) * CELL_SIZE;
        const z = (r - (rows - 1) / 2) * CELL_SIZE;

        const tile = new Mesh(this.tileGeo, this.neutralTileMat);
        tile.position.set(x, TILE_HEIGHT / 2, z);
        tile.receiveShadow = true;
        tile.userData = { row: r, col: c };
        this.boardGroup.add(tile);
        this.tileMeshes.push(tile);

        const orbGroup = new Group();
        orbGroup.position.set(x, TILE_HEIGHT, z);
        this.boardGroup.add(orbGroup);

        rowCells.push({ tile, orbGroup });
        rowState.push({ owner: null, orbs: 0 });
      }
      this.cells.push(rowCells);
      this.renderState.push(rowState);
    }

    const half = Math.max(boardW, boardD) / 2 + 1;
    this.dirLight.shadow.camera.left = -half;
    this.dirLight.shadow.camera.right = half;
    this.dirLight.shadow.camera.top = half;
    this.dirLight.shadow.camera.bottom = -half;
    this.dirLight.shadow.camera.near = 1;
    this.dirLight.shadow.camera.far = 20;
    this.dirLight.target.position.set(0, 0, 0);
    this.dirLight.shadow.camera.updateProjectionMatrix();
  }

  /** Straight-down orthographic camera, exact-fit to the board so the grid fills the screen. */
  private layout() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (w < 10 || h < 10) return;
    this.renderer.setSize(w, h, false);

    const rows = this.engine.rows;
    const cols = this.engine.cols;
    const boardW = cols * CELL_SIZE;
    const boardD = rows * CELL_SIZE;
    const aspect = w / h;
    const margin = 1.03;

    const targetHalfW = (boardW / 2) * margin;
    const targetHalfH = (boardD / 2) * margin;
    let halfW: number;
    let halfH: number;
    if (targetHalfW / aspect > targetHalfH) {
      halfW = targetHalfW;
      halfH = halfW / aspect;
    } else {
      halfH = targetHalfH;
      halfW = halfH * aspect;
    }

    this.camera.left = -halfW;
    this.camera.right = halfW;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    this.camera.near = 0.1;
    this.camera.far = 40;
    this.camera.position.set(0, 12, 0.0001);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
    this.baseCameraPos.copy(this.camera.position);
  }

  private cellPos(r: number, c: number): Vector3 {
    return this.cells[r][c].orbGroup.position;
  }

  private getTileMaterial(playerId: number): MeshStandardMaterial {
    let mat = this.tileMatCache.get(playerId);
    if (!mat) {
      const theme = this.colorOf(playerId);
      const blended = new Color(CELL_IDLE).lerp(new Color(theme.base), 0.15);
      mat = new MeshStandardMaterial({
        color: blended,
        emissive: theme.base,
        emissiveIntensity: 0.06,
        roughness: 0.8,
        metalness: 0.03,
      });
      this.tileMatCache.set(playerId, mat);
    }
    return mat;
  }

  private getOrbMaterial(playerId: number): MeshPhysicalMaterial {
    let mat = this.orbMatCache.get(playerId);
    if (!mat) {
      const theme = this.colorOf(playerId);
      mat = new MeshPhysicalMaterial({
        color: theme.base,
        emissive: theme.base,
        emissiveIntensity: 0.5,
        roughness: 0.22,
        metalness: 0.12,
        clearcoat: 1,
        clearcoatRoughness: 0.16,
      });
      this.orbMatCache.set(playerId, mat);
    }
    return mat;
  }

  private drawCell(r: number, c: number) {
    const view = this.cells[r][c];
    const state = this.renderState[r][c];

    while (view.orbGroup.children.length) {
      const child = view.orbGroup.children[view.orbGroup.children.length - 1];
      view.orbGroup.remove(child);
      if (child instanceof Sprite) (child.material as SpriteMaterial).dispose();
    }

    view.tile.material = state.owner !== null ? this.getTileMaterial(state.owner) : this.neutralTileMat;

    if (state.owner === null || state.orbs <= 0) return;

    const positions = layoutFor(state.orbs);
    const orbMat = this.getOrbMaterial(state.owner);
    let emojiChar: string | null = null;
    if (this.orbStyle === 'emoji') {
      const mass = this.engine.criticalMass(r, c);
      const remaining = mass - state.orbs;
      emojiChar = EMOJI_STAGES[stageForRemaining(remaining)];
    }

    for (const [ox, oy] of positions) {
      const px = ox * CELL_SIZE * 0.42;
      const pz = oy * CELL_SIZE * 0.42;
      const sphere = new Mesh(this.orbGeo, orbMat);
      sphere.position.set(px, ORB_RADIUS, pz);
      sphere.castShadow = true;
      view.orbGroup.add(sphere);

      if (emojiChar) {
        const mat = new SpriteMaterial({ map: emojiTexture(emojiChar), transparent: true, depthWrite: false });
        const sprite = new Sprite(mat);
        sprite.position.set(px, ORB_RADIUS * 2 + 0.15, pz);
        const size = positions.length >= 3 ? 0.3 : 0.36;
        sprite.scale.set(size, size, 1);
        view.orbGroup.add(sprite);
      }
    }
  }

  resetVisual() {
    for (let r = 0; r < this.engine.rows; r++) {
      for (let c = 0; c < this.engine.cols; c++) {
        this.renderState[r][c] = { owner: null, orbs: 0 };
        const view = this.cells[r][c];
        this.drawCell(r, c);
        view.tile.scale.set(0.001, 0.001, 0.001);
      }
    }
    const tl = gsap.timeline();
    let i = 0;
    for (let r = 0; r < this.engine.rows; r++) {
      for (let c = 0; c < this.engine.cols; c++) {
        const view = this.cells[r][c];
        tl.to(view.tile.scale, { x: 1, y: 1, z: 1, duration: 0.32, ease: 'back.out(2.2)' }, i * 0.006);
        i++;
      }
    }
  }

  private handlePointerDown(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -(((e.clientY - rect.top) / rect.height) * 2 - 1));
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.tileMeshes, false);
    if (!hits.length) return;
    const { row, col } = hits[0].object.userData as { row: number; col: number };
    const view = this.cells[row][col];
    gsap.to(view.tile.position, {
      y: TILE_HEIGHT / 2 - 0.03,
      duration: 0.06,
      onComplete: () => {
        gsap.to(view.tile.position, { y: TILE_HEIGHT / 2, duration: 0.14, ease: 'back.out(3)' });
      },
    });
    this.onCellTap(row, col);
  }

  private tick() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.t += dt * 60;
    for (let r = 0; r < this.engine.rows; r++) {
      for (let c = 0; c < this.engine.cols; c++) {
        const state = this.renderState[r][c];
        if (state.owner === null || state.orbs <= 0) continue;
        const view = this.cells[r][c];
        const mass = this.engine.criticalMass(r, c);
        const seed = r * 7.3 + c * 13.1;
        const bob = Math.sin(this.t * 0.05 + seed) * 0.018;
        view.orbGroup.position.y = TILE_HEIGHT + bob;
        view.orbGroup.rotation.y = this.t * 0.012 + seed;

        if (state.orbs >= mass - 1) {
          const speed = this.orbStyle === 'emoji' ? 0.4 : 0.25;
          const amount = this.orbStyle === 'emoji' ? 0.09 : 0.06;
          const pulse = 1 + Math.sin(this.t * speed + seed) * amount;
          view.orbGroup.scale.set(pulse, pulse, pulse);
        } else {
          view.orbGroup.scale.set(1, 1, 1);
        }
      }
    }
  }

  async playEvents(events: MoveEvent[], onEventStart?: (ev: MoveEvent) => void): Promise<void> {
    let i = 0;
    while (i < events.length) {
      const ev = events[i];
      if (ev.type === 'place') {
        onEventStart?.(ev);
        await this.animatePlace(ev.row, ev.col, ev.player, ev.orbs);
        i++;
      } else if (ev.type === 'explode') {
        const wave = ev.wave;
        const batch: Extract<MoveEvent, { type: 'explode' }>[] = [];
        while (i < events.length && events[i].type === 'explode' && (events[i] as any).wave === wave) {
          batch.push(events[i] as any);
          i++;
        }
        onEventStart?.(batch[0]);
        await this.animateExplodeWave(batch);
      } else {
        onEventStart?.(ev);
        i++;
      }
    }
  }

  private async animatePlace(row: number, col: number, player: number, orbs: number) {
    this.renderState[row][col] = { owner: player, orbs };
    this.drawCell(row, col);

    const pos = this.cellPos(row, col);
    const theme = this.colorOf(player);
    ring3d(this.fxGroup, pos, theme.base, CELL_SIZE * 0.5);
    burst3d(this.fxGroup, pos, theme.base, 8, 0.4);

    const view = this.cells[row][col];
    view.orbGroup.scale.set(0.35, 0.35, 0.35);
    view.orbGroup.position.y = TILE_HEIGHT + 0.4;
    await new Promise<void>((resolve) => {
      const tl = gsap.timeline({ onComplete: () => resolve() });
      tl.to(view.orbGroup.position, { y: TILE_HEIGHT - 0.02, duration: 0.18, ease: 'power2.in' });
      tl.to(view.orbGroup.scale, { x: 1, y: 1, z: 1, duration: 0.22, ease: 'back.out(3.2)' }, '<0.02');
      tl.to(view.orbGroup.position, { y: TILE_HEIGHT, duration: 0.14, ease: 'back.out(3)' });
    });
  }

  private async animateExplodeWave(batch: Extract<MoveEvent, { type: 'explode' }>[]) {
    shakeCamera(this.camera, this.baseCameraPos, Math.min(0.2, 0.09 + batch.length * 0.018));

    const travelPromises: Promise<void>[] = [];
    for (const ev of batch) {
      const pos = this.cellPos(ev.row, ev.col);
      const theme = this.colorOf(ev.player);
      const orbMat = this.getOrbMaterial(ev.player);
      ring3d(this.fxGroup, pos, theme.base, CELL_SIZE * 0.72);
      burst3d(this.fxGroup, pos, theme.base, 16, 1);
      for (const target of ev.targets) {
        const to = this.cellPos(target.row, target.col);
        travelPromises.push(travelOrb3d(this.fxGroup, pos, to, orbMat, this.orbGeo, ORB_RADIUS));
      }
    }

    await Promise.all(travelPromises);

    for (const ev of batch) {
      const mass = this.engine.criticalMass(ev.row, ev.col);
      const cell = this.renderState[ev.row][ev.col];
      cell.orbs -= mass;
      if (cell.orbs <= 0) {
        cell.orbs = 0;
        cell.owner = null;
      }
      this.drawCell(ev.row, ev.col);
    }
    for (const ev of batch) {
      for (const target of ev.targets) {
        const cell = this.renderState[target.row][target.col];
        cell.owner = ev.player;
        cell.orbs += 1;
        this.drawCell(target.row, target.col);
        const view = this.cells[target.row][target.col];
        view.orbGroup.scale.set(1.3, 1.3, 1.3);
        gsap.to(view.orbGroup.scale, { x: 1, y: 1, z: 1, duration: 0.2, ease: 'back.out(4)' });
        const theme = this.colorOf(ev.player);
        ring3d(this.fxGroup, this.cellPos(target.row, target.col), theme.base, CELL_SIZE * 0.4);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  destroy() {
    this.ro?.disconnect();
    cancelAnimationFrame(this.raf);
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDownBound);
    this.renderer.dispose();
    this.host.removeChild(this.renderer.domElement);
  }
}
