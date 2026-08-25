import {
  ACESFilmicToneMapping,
  BufferGeometry,
  Clock,
  Color,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  OrthographicCamera,
  PCFSoftShadowMap,
  PlaneGeometry,
  Raycaster,
  RingGeometry,
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
import type { CellKind, MoveEvent } from '../game/types';
import { layoutFor } from '../render/orbLayout';
import { BOARD_BG_BOTTOM, CELL_IDLE, GRID_LINE, type ColorTheme } from '../render/theme';
import { EMOJI_STAGES, stageForRemaining } from '../render/emoji';
import { emojiTexture } from './emojiTexture';
import { orbSurfaceTexture } from './orbSurfaceTexture';
import { burst3d, ring3d, shakeCamera, travelOrb3d } from './fx3d';
import { EXPLOSION_SPIN_UP_MS } from './timing';

export type OrbStyle = 'dots' | 'emoji';

interface RenderCell {
  owner: number | null;
  orbs: number;
}

interface CellView {
  tile: Mesh;
  orbGroup: Group;
  /** Thin ring etched into the tile, lit only while the cell is one particle
   *  short of critical mass — the board's own "about to go" warning. */
  criticalRing: Mesh;
  /** The tile's settled scale. Not always 1: a dead site is permanently
   *  shrunk and sunk, so the board-in animation has to return it to *its*
   *  resting shape rather than to unit scale. */
  restScale: Vector3;
}

/** Per-orb idle motion: a revolution around the cluster center on a randomly
 *  tilted plane, plus an independent tumble of the orb's own surface. Angles
 *  accumulate frame to frame (rather than being derived from absolute time)
 *  so the rate can change — e.g. winding up near critical mass — without the
 *  orb jumping to a new position. */
interface OrbitState {
  axis: Vector3;
  speed: number;
  angle: number;
  spinAxis: Vector3;
  spinSpeed: number;
  spinAngle: number;
}

const CELL_SIZE = 1;
const TILE_HEIGHT = 0.14;
const ORB_RADIUS = 0.22;
const ORB_SPREAD = 0.52;
/** World-space breathing room kept around the lattice so the substrate's
 *  corner brackets and edge tick marks are never cropped by the camera fit. */
const BOARD_MARGIN = 0.3;
/** How hard the substrate plate glows in the active player's colour.
 *
 *  Very low, and lower than it looks like it should be: the plate shows through
 *  every gap in the lattice, so it covers far more screen than its area
 *  suggests, and tone mapping lifts a saturated emissive hard against a
 *  near-black board. At 0.05 it washed the whole board and competed with the
 *  particles; this is a tint you notice without looking at it. */
const PLATE_TURN_GLOW = 0.014;

export { EXPLOSION_SPIN_UP_MS } from './timing';

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
  private criticalRingGeo = new RingGeometry(CELL_SIZE * 0.38, CELL_SIZE * 0.405, 48);
  private orbGeo = new SphereGeometry(ORB_RADIUS, 24, 18);
  private neutralTileMat = new MeshStandardMaterial({ color: CELL_IDLE, roughness: 0.88, metalness: 0.08 });
  // Unowned special sites get their own base tone; once a player takes one the
  // owner tint takes over and the etched perimeter outline (below) is what
  // keeps the site's nature readable.
  private catalystTileMat = new MeshStandardMaterial({ color: 0x241f18, roughness: 0.8, metalness: 0.14 });
  private damperTileMat = new MeshStandardMaterial({ color: 0x11161d, roughness: 0.95, metalness: 0.04 });
  private voidTileMat = new MeshStandardMaterial({ color: 0x080a0e, roughness: 1, metalness: 0 });
  private tileMatCache = new Map<number, MeshStandardMaterial>();
  private orbMatCache = new Map<number, MeshPhysicalMaterial>();
  private ringMatCache = new Map<number, MeshBasicMaterial>();
  /** Substrate plate + etched frame/tick marks, disposed together on teardown. */
  private substrateParts: { geo: BufferGeometry; mat: MeshBasicMaterial | LineBasicMaterial | MeshStandardMaterial }[] = [];
  /** The two surfaces that carry the active player's colour. Held separately
   *  from substrateParts, which exists only for disposal. */
  private frameMat: LineBasicMaterial | null = null;
  private plateMat: MeshStandardMaterial | null = null;
  // Reused every frame by updateOrbits so per-orb motion allocates nothing.
  private scratchCenter = new Vector3();
  private scratchRel = new Vector3();

  private onCellTap: (row: number, col: number) => void = () => {};
  /** The cell under the cursor, or null. Mouse only — a finger has no hover
   *  state, and faking one would leave a highlight stranded on the last cell
   *  tapped. */
  private hovered: { row: number; col: number } | null = null;
  /** Asked before lighting a cell: hovering somewhere you cannot play is a
   *  worse signal than no hover at all. */
  private canHover: (row: number, col: number) => boolean = () => false;
  private onPointerDownBound = (e: PointerEvent) => this.handlePointerDown(e);
  private onPointerMoveBound = (e: PointerEvent) => this.handlePointerMove(e);
  private onPointerLeaveBound = () => this.setHover(null);
  private onContextLostBound = (e: Event) => this.handleContextLost(e);
  private onContextRestoredBound = () => this.handleContextRestored();

  constructor(engine: GameEngine, colorOf: (playerId: number) => ColorTheme, orbStyle: OrbStyle = 'emoji') {
    this.engine = engine;
    this.colorOf = colorOf;
    this.orbStyle = orbStyle;
    this.camera.up.set(0, 0, -1);
  }

  setCellTapHandler(fn: (row: number, col: number) => void) {
    this.onCellTap = fn;
  }

  /** Lets the caller decide which cells are worth lighting under the cursor —
   *  the renderer knows the board, not whose turn it is. */
  setHoverTest(fn: (row: number, col: number) => boolean) {
    this.canHover = fn;
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
    this.renderer = this.createRenderer();
    host.appendChild(this.renderer.domElement);

    this.scene.add(this.boardGroup, this.fxGroup);
    this.setupLights();
    this.buildGrid();
    this.layout();

    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(host);

    this.clock.start();
    this.startLoop();
  }

  private createRenderer(): WebGLRenderer {
    const renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.touchAction = 'none';
    renderer.domElement.addEventListener('pointerdown', this.onPointerDownBound);
    renderer.domElement.addEventListener('pointermove', this.onPointerMoveBound);
    renderer.domElement.addEventListener('pointerleave', this.onPointerLeaveBound);
    renderer.domElement.addEventListener('webglcontextlost', this.onContextLostBound, false);
    renderer.domElement.addEventListener('webglcontextrestored', this.onContextRestoredBound, false);
    return renderer;
  }

  private startLoop() {
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.tick();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  /** Mobile GPUs reclaim the WebGL context when backgrounded/low on memory —
   *  without this the board just goes black forever until the page reloads. */
  private handleContextLost(e: Event) {
    e.preventDefault();
    cancelAnimationFrame(this.raf);
    console.warn('WebGL context lost — waiting for the browser to restore it.');
  }

  private handleContextRestored() {
    console.warn('WebGL context restored — rebuilding the renderer.');
    // The dead context can't reliably resume rendering even after this event in
    // some browsers, so swap in a fresh canvas/renderer bound to the new
    // context. The scene graph itself (game state, meshes, materials) was
    // never lost — only the GPU-side resources — so nothing needs rebuilding.
    const old = this.renderer;
    old.domElement.removeEventListener('pointerdown', this.onPointerDownBound);
    old.domElement.removeEventListener('pointermove', this.onPointerMoveBound);
    old.domElement.removeEventListener('pointerleave', this.onPointerLeaveBound);
    old.domElement.removeEventListener('webglcontextlost', this.onContextLostBound);
    old.domElement.removeEventListener('webglcontextrestored', this.onContextRestoredBound);
    this.host.removeChild(old.domElement);
    old.dispose();

    this.renderer = this.createRenderer();
    this.host.appendChild(this.renderer.domElement);
    this.layout();
    this.startLoop();
  }

  /** Clinical, not warm: a cool overhead key with a cyan bounce, so the board
   *  reads as an instrument surface rather than a lit playfield. */
  private setupLights() {
    const hemi = new HemisphereLight(0xbcd4e8, 0x05070a, 0.72);
    this.scene.add(hemi);

    this.dirLight = new DirectionalLight(0xf2f8ff, 1.25);
    this.dirLight.position.set(2.4, 6, 3.2);
    this.dirLight.castShadow = true;
    this.dirLight.shadow.mapSize.set(1024, 1024);
    this.dirLight.shadow.bias = -0.002;
    this.scene.add(this.dirLight, this.dirLight.target);

    const fill = new DirectionalLight(0x3ad9ff, 0.26);
    fill.position.set(-3, 3, -2);
    this.scene.add(fill);
  }

  private buildGrid() {
    const rows = this.engine.rows;
    const cols = this.engine.cols;
    // Squarer tiles with a tighter fillet: precise machined cells rather than
    // soft rounded game pieces. The gap between them reads as the grid itself.
    this.tileGeo = new RoundedBoxGeometry(CELL_SIZE * 0.88, TILE_HEIGHT, CELL_SIZE * 0.88, 2, 0.055);

    const boardW = cols * CELL_SIZE;
    const boardD = rows * CELL_SIZE;

    this.buildSubstrate(boardW, boardD);

    for (let r = 0; r < rows; r++) {
      const rowCells: CellView[] = [];
      const rowState: RenderCell[] = [];
      for (let c = 0; c < cols; c++) {
        const x = (c - (cols - 1) / 2) * CELL_SIZE;
        const z = (r - (rows - 1) / 2) * CELL_SIZE;
        const kind = this.engine.kindAt(r, c);
        const isVoid = kind === 'void';

        const tile = new Mesh(this.tileGeo, this.materialForKind(kind));
        // A dead site is sunk into the substrate and shrunk, so the lattice
        // visibly has a hole in it rather than just a differently-shaded cell.
        tile.position.set(x, isVoid ? TILE_HEIGHT * 0.18 : TILE_HEIGHT / 2, z);
        if (isVoid) tile.scale.set(0.72, 0.35, 0.72);
        tile.receiveShadow = true;
        tile.userData = { row: r, col: c };
        this.boardGroup.add(tile);
        // Left out of the raycast list entirely, so a tap on a dead site
        // doesn't even produce the press animation.
        if (!isVoid) this.tileMeshes.push(tile);

        const criticalRing = new Mesh(this.criticalRingGeo, this.getRingMaterial(0));
        criticalRing.rotation.x = -Math.PI / 2;
        criticalRing.position.set(x, TILE_HEIGHT + 0.004, z);
        criticalRing.visible = false;
        this.boardGroup.add(criticalRing);

        const orbGroup = new Group();
        orbGroup.position.set(x, TILE_HEIGHT, z);
        this.boardGroup.add(orbGroup);

        rowCells.push({ tile, orbGroup, criticalRing, restScale: tile.scale.clone() });
        rowState.push({ owner: null, orbs: 0 });
      }
      this.cells.push(rowCells);
      this.renderState.push(rowState);
    }

    this.buildSpecialMarkings();

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

  private materialForKind(kind: CellKind): MeshStandardMaterial {
    switch (kind) {
      case 'void':
        return this.voidTileMat;
      case 'catalyst':
        return this.catalystTileMat;
      case 'damper':
        return this.damperTileMat;
      default:
        return this.neutralTileMat;
    }
  }

  /** Etches a square outline around every catalyst and damper site.
   *
   *  It sits on the tile's perimeter (±0.44 of a cell) on purpose: an orb
   *  cluster only ever reaches ±0.40, so the marking stays visible no matter
   *  how full the cell is — which a centred glyph would not. Colour carries
   *  the meaning (warm = goes critical early, cold = goes critical late) and
   *  is kept deliberately neutral so it never reads as a player's emission. */
  private buildSpecialMarkings() {
    const pts: number[] = [];
    const cols: number[] = [];
    const warm = new Color(0xffca7a);
    const cold = new Color(0x5f708a);
    const y = TILE_HEIGHT + 0.005;
    const e = CELL_SIZE * 0.44;

    for (let r = 0; r < this.engine.rows; r++) {
      for (let c = 0; c < this.engine.cols; c++) {
        const kind = this.engine.kindAt(r, c);
        if (kind !== 'catalyst' && kind !== 'damper') continue;
        const x = (c - (this.engine.cols - 1) / 2) * CELL_SIZE;
        const z = (r - (this.engine.rows - 1) / 2) * CELL_SIZE;
        const col = kind === 'catalyst' ? warm : cold;
        const corners: [number, number][] = [
          [-e, -e],
          [e, -e],
          [e, e],
          [-e, e],
        ];
        for (let i = 0; i < 4; i++) {
          const [ax, az] = corners[i];
          const [bx, bz] = corners[(i + 1) % 4];
          pts.push(x + ax, y, z + az, x + bx, y, z + bz);
          cols.push(col.r, col.g, col.b, col.r, col.g, col.b);
        }
      }
    }
    if (pts.length === 0) return;

    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pts, 3));
    geo.setAttribute('color', new Float32BufferAttribute(cols, 3));
    const mat = new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 });
    this.boardGroup.add(new LineSegments(geo, mat));
    this.substrateParts.push({ geo, mat });
  }

  /** The plate the lattice is mounted on, plus the etched frame and per-row/
   *  column tick marks around it. Purely visual, and the part that does most
   *  of the work of making the board read as laboratory apparatus rather than
   *  a game grid floating in space. */
  private buildSubstrate(boardW: number, boardD: number) {
    const pad = CELL_SIZE * 0.34;
    const plateGeo = new PlaneGeometry(boardW + pad * 2, boardD + pad * 2);
    const plateMat = new MeshStandardMaterial({
      color: BOARD_BG_BOTTOM,
      roughness: 0.95,
      metalness: 0.12,
      side: DoubleSide,
    });
    const plate = new Mesh(plateGeo, plateMat);
    plate.rotation.x = -Math.PI / 2;
    plate.position.y = 0.002;
    plate.receiveShadow = true;
    this.boardGroup.add(plate);
    this.substrateParts.push({ geo: plateGeo, mat: plateMat });

    const hw = boardW / 2 + pad * 0.62;
    const hd = boardD / 2 + pad * 0.62;
    const y = 0.006;
    const pts: number[] = [];

    // Frame, drawn as four corner brackets rather than a closed rectangle —
    // registration marks, the way a measurement plate is cornered.
    const bracket = Math.min(boardW, boardD) * 0.11;
    for (const [sx, sz] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      pts.push(sx * hw, y, sz * hd, sx * (hw - bracket), y, sz * hd);
      pts.push(sx * hw, y, sz * hd, sx * hw, y, sz * (hd - bracket));
    }

    // Tick marks on all four edges, one per lattice row/column.
    const tick = pad * 0.4;
    const cols = this.engine.cols;
    const rows = this.engine.rows;
    for (let c = 0; c < cols; c++) {
      const x = (c - (cols - 1) / 2) * CELL_SIZE;
      pts.push(x, y, hd, x, y, hd - tick);
      pts.push(x, y, -hd, x, y, -hd + tick);
    }
    for (let r = 0; r < rows; r++) {
      const z = (r - (rows - 1) / 2) * CELL_SIZE;
      pts.push(hw, y, z, hw - tick, y, z);
      pts.push(-hw, y, z, -hw + tick, y, z);
    }

    const lineGeo = new BufferGeometry();
    lineGeo.setAttribute('position', new Float32BufferAttribute(pts, 3));
    const lineMat = new LineBasicMaterial({ color: GRID_LINE, transparent: true, opacity: 0.85 });
    this.boardGroup.add(new LineSegments(lineGeo, lineMat));
    this.substrateParts.push({ geo: lineGeo, mat: lineMat });
    // Held so the frame can carry the active player's emission — see
    // setTurnColor.
    this.frameMat = lineMat;
    this.plateMat = plateMat;
  }

  /**
   * Tints the substrate — the corner brackets, edge ticks and the plate itself —
   * towards whoever is to move.
   *
   * The frame is the right surface for this precisely because nothing is played
   * on it: whose turn it is stays legible in peripheral vision while you are
   * looking at the middle of the board, without competing with the particles
   * for the space that actually carries the game state.
   *
   * Blended rather than replaced. Full saturation would read as a neon border
   * and undo the etched, instrument-panel look the whole art direction rests
   * on; this keeps it graphite that has been *charged* by someone.
   */
  setTurnColor(colorHex: number, immediate = false) {
    if (!this.frameMat || !this.plateMat) return;
    // The frame carries most of the signal, so it takes most of the colour.
    const frameTarget = new Color(GRID_LINE).lerp(new Color(colorHex), 0.9);
    const plateTarget = new Color(colorHex);

    gsap.killTweensOf([this.frameMat.color, this.plateMat.emissive]);
    if (immediate) {
      this.frameMat.color.copy(frameTarget);
      this.plateMat.emissive.copy(plateTarget);
      this.plateMat.emissiveIntensity = PLATE_TURN_GLOW;
      return;
    }
    // Eased rather than snapped: a turn change is a hand-off, and the board
    // reading as though the charge flows across it sells that better than a
    // hard cut would.
    gsap.to(this.frameMat.color, {
      r: frameTarget.r,
      g: frameTarget.g,
      b: frameTarget.b,
      duration: 0.45,
      ease: 'power2.out',
    });
    this.plateMat.emissiveIntensity = PLATE_TURN_GLOW;
    gsap.to(this.plateMat.emissive, {
      r: plateTarget.r,
      g: plateTarget.g,
      b: plateTarget.b,
      duration: 0.45,
      ease: 'power2.out',
    });
  }

  /** Straight-down orthographic camera, exact-fit to the board so the grid fills the screen. */
  private layout() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (w < 10 || h < 10) return;
    // Re-applied on every layout, not just at construction. The device pixel
    // ratio is not a constant: it changes when the window moves between a
    // HiDPI and a standard monitor, and when the browser zooms. A renderer
    // holding the ratio it saw at startup draws at the wrong scale for the
    // buffer it is drawing into.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);

    const rows = this.engine.rows;
    const cols = this.engine.cols;
    const boardW = cols * CELL_SIZE;
    const boardD = rows * CELL_SIZE;
    const aspect = w / h;

    // Absolute rather than proportional padding, so the substrate's corner
    // brackets and edge ticks stay inside frame at every board size.
    const targetHalfW = boardW / 2 + BOARD_MARGIN;
    const targetHalfH = boardD / 2 + BOARD_MARGIN;
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
      // A held cell is tinted, not coloured in: the substrate stays graphite
      // and the emission colour lives in the particles, which is what keeps a
      // six-player board from turning into the rainbow the brief rules out.
      const blended = new Color(CELL_IDLE).lerp(new Color(theme.base), 0.13);
      mat = new MeshStandardMaterial({
        color: blended,
        emissive: theme.base,
        emissiveIntensity: 0.05,
        roughness: 0.86,
        metalness: 0.09,
      });
      this.tileMatCache.set(playerId, mat);
    }
    return mat;
  }

  private getRingMaterial(playerId: number): MeshBasicMaterial {
    let mat = this.ringMatCache.get(playerId);
    if (!mat) {
      mat = new MeshBasicMaterial({
        color: this.colorOf(playerId).base,
        transparent: true,
        opacity: 0.7,
        side: DoubleSide,
        depthWrite: false,
      });
      this.ringMatCache.set(playerId, mat);
    }
    return mat;
  }

  private getOrbMaterial(playerId: number): MeshPhysicalMaterial {
    let mat = this.orbMatCache.get(playerId);
    if (!mat) {
      const theme = this.colorOf(playerId);
      mat = new MeshPhysicalMaterial({
        color: theme.base,
        map: orbSurfaceTexture(),
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

    view.tile.material =
      state.owner !== null ? this.getTileMaterial(state.owner) : this.materialForKind(this.engine.kindAt(r, c));
    // Fresh children means any in-flight explosion animation for this cell is
    // over — hand control of these orbs back to the idle orbit in tick().
    view.orbGroup.userData.exploding = false;

    const nearCritical =
      state.owner !== null && state.orbs > 0 && state.orbs >= this.engine.criticalMass(r, c) - 1;
    view.criticalRing.visible = nearCritical;
    if (nearCritical) view.criticalRing.material = this.getRingMaterial(state.owner!);

    if (state.owner === null || state.orbs <= 0) {
      // A cell that just emptied out (e.g. after exploding) may still have
      // leftover spin-up rotation/scale — clear it so a future orb here
      // doesn't inherit a stray twist.
      view.orbGroup.rotation.set(0, 0, 0);
      view.orbGroup.scale.set(1, 1, 1);
      return;
    }

    const positions = layoutFor(state.orbs);
    const orbMat = this.getOrbMaterial(state.owner);
    let emojiChar: string | null = null;
    if (this.orbStyle === 'emoji') {
      const mass = this.engine.criticalMass(r, c);
      const remaining = mass - state.orbs;
      emojiChar = EMOJI_STAGES[stageForRemaining(remaining)];
    }

    for (const [ox, oy] of positions) {
      const px = ox * CELL_SIZE * ORB_SPREAD;
      const pz = oy * CELL_SIZE * ORB_SPREAD;
      const sphere = new Mesh(this.orbGeo, orbMat);
      sphere.position.set(px, ORB_RADIUS, pz);
      sphere.castShadow = true;
      // Each orb revolves around the cluster's center on its OWN randomly
      // tilted plane, at its own speed and direction. Because the planes are
      // tilted (not flat in XZ), orbs rise and dip and cross over/under each
      // other — that vertical parallax is what actually reads as 3D depth
      // from a fixed top-down camera, where a flat spin looks like a 2D
      // turntable no matter how fast it goes.
      this.attachOrbitState(sphere, px, ORB_RADIUS, pz);
      view.orbGroup.add(sphere);

      if (emojiChar) {
        const mat = new SpriteMaterial({ map: emojiTexture(emojiChar), transparent: true, depthWrite: false });
        const sprite = new Sprite(mat);
        const spriteY = ORB_RADIUS * 2 + 0.15;
        sprite.position.set(px, spriteY, pz);
        const size = positions.length >= 3 ? 0.3 : 0.36;
        sprite.scale.set(size, size, 1);
        // Ride along with the sphere it labels, using that sphere's orbit.
        this.attachOrbitState(sprite, px, spriteY, pz, sphere.userData.orbit);
        view.orbGroup.add(sprite);
      }
    }
  }

  /** Gives one orb (or its emoji sprite) a random 3D orbit around the cluster
   *  center, plus its own tumble axis so its surface visibly turns too. Pass
   *  `share` to make a sprite follow the same orbit as its sphere. */
  private attachOrbitState(obj: Object3D, px: number, py: number, pz: number, share?: OrbitState) {
    const orbit: OrbitState =
      share ??
      {
        axis: new Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize(),
        speed: (0.006 + Math.random() * 0.011) * (Math.random() < 0.5 ? -1 : 1),
        angle: Math.random() * Math.PI * 2,
        spinAxis: new Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize(),
        spinSpeed: (0.005 + Math.random() * 0.012) * (Math.random() < 0.5 ? -1 : 1),
        spinAngle: Math.random() * Math.PI * 2,
      };
    obj.userData.orbit = orbit;
    obj.userData.orbitBase = new Vector3(px, py, pz);
  }

  /** Adopts the engine's current board wholesale.
   *
   *  Every other path into the renderer replays events from an empty board, so
   *  the animation and the engine stay in step. A client rejoining a match in
   *  progress has no events to replay — it is handed a finished position — and
   *  has to show it as it already stands. */
  syncToEngine() {
    for (let r = 0; r < this.engine.rows; r++) {
      for (let c = 0; c < this.engine.cols; c++) {
        const cell = this.engine.getCell(r, c);
        this.renderState[r][c] = { owner: cell.owner, orbs: cell.orbs };
        this.drawCell(r, c);
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
        const s = view.restScale;
        tl.to(view.tile.scale, { x: s.x, y: s.y, z: s.z, duration: 0.32, ease: 'back.out(2.2)' }, i * 0.006);
        i++;
      }
    }
  }

  /** Which cell is under this pointer event, or null. */
  private cellAt(e: PointerEvent): { row: number; col: number } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -(((e.clientY - rect.top) / rect.height) * 2 - 1));
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.tileMeshes, false);
    if (!hits.length) return null;
    return hits[0].object.userData as { row: number; col: number };
  }

  /**
   * Lifts the cell under the cursor.
   *
   * Mouse only: `pointerType` is checked because a touch device fires
   * pointermove on the way to a tap, which would leave a highlight sitting on
   * whatever was last touched with nothing hovering it.
   */
  private handlePointerMove(e: PointerEvent) {
    if (e.pointerType === 'touch') return;
    const cell = this.cellAt(e);
    this.setHover(cell && this.canHover(cell.row, cell.col) ? cell : null);
  }

  private setHover(next: { row: number; col: number } | null) {
    const same =
      (!next && !this.hovered) ||
      (next && this.hovered && next.row === this.hovered.row && next.col === this.hovered.col);
    if (same) return;

    if (this.hovered) {
      const prev = this.cells[this.hovered.row]?.[this.hovered.col];
      if (prev) gsap.to(prev.tile.position, { y: TILE_HEIGHT / 2, duration: 0.16, ease: 'power2.out' });
    }
    this.hovered = next;
    this.renderer.domElement.style.cursor = next ? 'pointer' : 'default';
    if (next) {
      const view = this.cells[next.row]?.[next.col];
      if (view) gsap.to(view.tile.position, { y: TILE_HEIGHT / 2 + 0.09, duration: 0.16, ease: 'power2.out' });
    }
  }

  private handlePointerDown(e: PointerEvent) {
    const cell = this.cellAt(e);
    if (!cell) return;
    const { row, col } = cell;
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
        // A cell one orb short of blowing is visibly agitated: its orbs whip
        // around much faster, so you can read "this one is about to go" at a
        // glance without having to count orbs.
        const nearCritical = state.orbs >= mass - 1;

        // Note: no group-level rotation here on purpose. Rotating the whole
        // orbGroup would swing every orb in a cell together at one shared
        // rate — the rigid "spinning as one piece" look. Instead each orb
        // below drives its own orbit around the cluster center.
        const bob = Math.sin(this.t * 0.05 + seed) * 0.007;
        view.orbGroup.position.y = TILE_HEIGHT + bob;

        // While a cell is mid-explosion its orbs are driven by GSAP tweens;
        // don't fight them for control of position/rotation.
        if (!view.orbGroup.userData.exploding) {
          this.updateOrbits(view.orbGroup, dt * 60, nearCritical ? 3.6 : 1);
        }

        if (nearCritical) {
          const speed = this.orbStyle === 'emoji' ? 0.4 : 0.25;
          const amount = this.orbStyle === 'emoji' ? 0.06 : 0.04;
          const pulse = 1 + Math.sin(this.t * speed + seed) * amount;
          view.orbGroup.scale.set(pulse, pulse, pulse);
          // The ring expands on the same phase as the cluster but with a much
          // bigger swing, so "about to go" is readable from the tile alone —
          // you don't have to count particles or judge orbit speed.
          const ring = 0.9 + (Math.sin(this.t * speed + seed) * 0.5 + 0.5) * 0.16;
          view.criticalRing.scale.set(ring, ring, 1);
        } else {
          view.orbGroup.scale.set(1, 1, 1);
        }
      }
    }
  }

  /** Advances every orb in a cell along its own tilted 3D orbit around the
   *  cluster center, and tumbles each orb's surface on its own axis. Multiple
   *  orbs in one cell therefore never move as a rigid unit — they sweep past
   *  each other on crossing planes, which is what gives the group real
   *  volume when viewed straight down. */
  private updateOrbits(group: Group, step: number, speedMul: number) {
    const center = this.scratchCenter.set(0, ORB_RADIUS, 0);
    for (const child of group.children) {
      const orbit = child.userData.orbit as OrbitState | undefined;
      const base = child.userData.orbitBase as Vector3 | undefined;
      if (!orbit || !base) continue;

      // Only the sphere advances the shared clock; an emoji sprite reuses its
      // sphere's orbit object and is always added right after it, so it reads
      // the already-updated angle instead of double-stepping it.
      if (child instanceof Mesh) {
        orbit.angle += orbit.speed * speedMul * step;
        orbit.spinAngle += orbit.spinSpeed * speedMul * step;
      }

      const rel = this.scratchRel.copy(base).sub(center);
      if (rel.lengthSq() > 1e-6) {
        rel.applyAxisAngle(orbit.axis, orbit.angle);
        // Damp the vertical swing so an orb never dips through the tile it
        // sits on, while still keeping obvious rise/fall parallax.
        rel.y *= 0.7;
        child.position.copy(center).add(rel);
      }

      if (child instanceof Mesh) {
        child.setRotationFromAxisAngle(orbit.spinAxis, orbit.spinAngle);
      }
    }
  }

  /** Sums orbs currently shown on the board for one player — reflects the
   *  live animation state, not the (already-final) engine state, so callers
   *  can tell exactly when a player's last orb visually disappears mid-cascade. */
  getPlayerOrbCount(playerId: number): number {
    let total = 0;
    for (let r = 0; r < this.engine.rows; r++) {
      for (let c = 0; c < this.engine.cols; c++) {
        const cell = this.renderState[r][c];
        if (cell.owner === playerId) total += cell.orbs;
      }
    }
    return total;
  }

  async playEvents(
    events: MoveEvent[],
    onEventStart?: (ev: MoveEvent) => void,
    onWaveSettled?: (wave: number, cellsExploded: number) => void
  ): Promise<void> {
    // Always plays at full natural speed, no matter how many waves a cascade
    // has. `onWaveSettled` fires right after each wave's cell ownership/orb
    // counts are actually applied — with the 1-based depth reached so far, so
    // a caller can drive a live chain counter — and it lets the caller detect
    // the exact moment an opponent's last orb disappears and react then,
    // without waiting for the rest of the cascade (which may keep going as
    // pure self-cascading among the winner's own cells).
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
        onWaveSettled?.(wave + 1, batch.length);
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

  /** Exploding cells wind up before they blast: the cluster strains outward
   *  (scale) while each individual orb tumbles chaotically — independent
   *  random rotation speed on all three axes at once (not just one spin
   *  axis), so it reads as genuine 3D tumbling instead of a coin spinning
   *  flat. Every orb also gets its own random duration/scale jitter so no
   *  two explosions — or two orbs in the same cluster — ever wind up
   *  looking identical. */
  private spinUp(batch: Extract<MoveEvent, { type: 'explode' }>[]): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const ev of batch) {
      const view = this.cells[ev.row][ev.col];
      // Hand control of these orbs from the idle orbit over to the tweens
      // below; drawCell clears this once the cell is rebuilt post-blast.
      view.orbGroup.userData.exploding = true;
      const scaleTarget = 1.25 + Math.random() * 0.35;
      const scaleDuration = (EXPLOSION_SPIN_UP_MS / 1000) * (0.85 + Math.random() * 0.3);

      promises.push(
        new Promise<void>((resolve) => {
          gsap.to(view.orbGroup.scale, {
            x: scaleTarget,
            y: scaleTarget,
            z: scaleTarget,
            duration: scaleDuration,
            ease: 'power2.in',
            onComplete: () => resolve(),
          });
        })
      );

      for (const child of view.orbGroup.children) {
        if (!(child instanceof Mesh)) continue;
        const spinDuration = (EXPLOSION_SPIN_UP_MS / 1000) * (0.8 + Math.random() * 0.5);
        const rot = { x: child.rotation.x, y: child.rotation.y, z: child.rotation.z };
        // Independent random turn count + direction per axis — this is what
        // actually sells 3D tumbling instead of a flat spin: X, Y and Z all
        // rotate at their own random rate, so the combined motion never
        // settles into one clean plane.
        const targetX = rot.x + (Math.random() * 2 - 1) * (1.5 + Math.random() * 3.5) * Math.PI;
        const targetY = rot.y + (Math.random() * 2 - 1) * (1.5 + Math.random() * 3.5) * Math.PI;
        const targetZ = rot.z + (Math.random() * 2 - 1) * (1.5 + Math.random() * 3.5) * Math.PI;
        promises.push(
          new Promise<void>((resolve) => {
            gsap.to(rot, {
              x: targetX,
              y: targetY,
              z: targetZ,
              duration: spinDuration,
              ease: 'power2.in',
              onUpdate: () => child.rotation.set(rot.x, rot.y, rot.z),
              onComplete: () => resolve(),
            });
          })
        );
      }
    }
    return Promise.all(promises).then(() => undefined);
  }

  private async animateExplodeWave(batch: Extract<MoveEvent, { type: 'explode' }>[]) {
    await this.spinUp(batch);
    // Shake grows with both the width of this wave and how deep into the chain
    // it is, so a long cascade escalates instead of flatlining at wave two.
    const depth = batch[0].wave;
    const amount = Math.min(0.26, 0.08 + batch.length * 0.016 + depth * 0.012);
    shakeCamera(this.camera, this.baseCameraPos, amount);

    const travelPromises: Promise<void>[] = [];
    for (const ev of batch) {
      const view = this.cells[ev.row][ev.col];
      const cellCenter = this.cellPos(ev.row, ev.col);
      const theme = this.colorOf(ev.player);
      const orbMat = this.getOrbMaterial(ev.player);
      const mass = this.engine.criticalMass(ev.row, ev.col);
      const positions = layoutFor(mass);

      ring3d(this.fxGroup, cellCenter, theme.base, CELL_SIZE * 0.72);
      burst3d(this.fxGroup, cellCenter, theme.base, 16, 1);

      // The clustered orbs physically "detach" here — hide the sitting cluster
      // and let individually-positioned projectiles take over from exactly
      // where each one sat, rather than all converging on one center point.
      view.orbGroup.scale.set(1, 1, 1);
      view.orbGroup.rotation.set(0, 0, 0);
      for (const child of view.orbGroup.children) child.visible = false;

      ev.targets.forEach((target, i) => {
        const [ox, oy] = positions[i % positions.length];
        const from = cellCenter
          .clone()
          .add(new Vector3(ox * CELL_SIZE * ORB_SPREAD, ORB_RADIUS, oy * CELL_SIZE * ORB_SPREAD));
        const to = this.cellPos(target.row, target.col);
        travelPromises.push(travelOrb3d(this.fxGroup, from, to, orbMat, this.orbGeo, ORB_RADIUS));
      });
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
  }

  destroy() {
    this.ro?.disconnect();
    cancelAnimationFrame(this.raf);
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDownBound);
    this.renderer.domElement.removeEventListener('pointermove', this.onPointerMoveBound);
    this.renderer.domElement.removeEventListener('pointerleave', this.onPointerLeaveBound);
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLostBound);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.onContextRestoredBound);
    for (const part of this.substrateParts) {
      part.geo.dispose();
      part.mat.dispose();
    }
    this.substrateParts.length = 0;
    this.criticalRingGeo.dispose();
    for (const mat of this.ringMatCache.values()) mat.dispose();
    this.ringMatCache.clear();
    this.catalystTileMat.dispose();
    this.damperTileMat.dispose();
    this.voidTileMat.dispose();
    this.renderer.dispose();
    this.host.removeChild(this.renderer.domElement);
  }
}
