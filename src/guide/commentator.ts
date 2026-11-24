/**
 * What Nova reacts to during a match against her.
 *
 * Reads the board after every move and picks at most one thing to say, in
 * order of how much it matters: a huge chain, a near knock-out, a comeback, a
 * change of lead, a risky placement, the opening, then idle chatter. Most
 * moments are gated by chance and spacing so she reacts like a person — often
 * enough to feel present, never on every single move.
 */
import type { GameEngine } from '../game/GameEngine.ts';
import type { MoveResult } from '../game/types.ts';
import type { LineCategory } from './lines.ts';
import type { Nova } from './nova.ts';

export interface MatchContext {
  /** 0 Easy … 3 Insane; -1 for Survival's system. */
  level: number;
  aiId: number;
  humanId: number;
  /** How the previous game against her ended, if this is a rematch. */
  rematch: 'won' | 'lost' | null;
  /** Finished matches against her so far — the first few get tips. */
  gamesPlayed: number;
}

type Lead = 'even' | 'human' | 'ai';

export interface BoardRead {
  humanOrbs: number;
  aiOrbs: number;
  humanCells: number;
  aiCells: number;
  /** Human share of all orbs on the board, 0–1. */
  share: number;
}

export function readBoard(engine: GameEngine, humanId: number, aiId: number): BoardRead {
  let humanOrbs = 0;
  let aiOrbs = 0;
  let humanCells = 0;
  let aiCells = 0;
  for (const row of engine.grid) {
    for (const cell of row) {
      if (cell.owner === humanId) {
        humanOrbs += cell.orbs;
        humanCells++;
      } else if (cell.owner === aiId) {
        aiOrbs += cell.orbs;
        aiCells++;
      }
    }
  }
  const total = humanOrbs + aiOrbs;
  return { humanOrbs, aiOrbs, humanCells, aiCells, share: total ? humanOrbs / total : 0.5 };
}

/** Whether a placement sits beside an opposing cell one orb from bursting. */
export function isRisky(engine: GameEngine, row: number, col: number, aiId: number): boolean {
  return engine.neighborsOf(row, col).some(({ row: r, col: c }) => {
    const cell = engine.getCell(r, c);
    return cell.owner === aiId && cell.orbs === engine.criticalMass(r, c) - 1;
  });
}

const GREETS: LineCategory[] = ['greet_easy', 'greet_normal', 'greet_hard', 'greet_insane'];

export class Commentator {
  private ctx: MatchContext | null = null;
  private humanMoves = 0;
  private aiMoves = 0;
  private lead: Lead = 'even';
  private leadLineAt = -99;
  private lastLineAt = -99;
  private humanWasBehind = false;
  private aiWasBehind = false;
  private once = new Set<string>();
  private idleTimer = 0;
  private idleCount = 0;

  private nova: Nova;

  constructor(nova: Nova) {
    this.nova = nova;
  }

  get active(): boolean {
    return this.ctx !== null;
  }

  start(ctx: MatchContext) {
    this.ctx = ctx;
    this.humanMoves = 0;
    this.aiMoves = 0;
    this.lead = 'even';
    this.leadLineAt = -99;
    this.lastLineAt = -99;
    this.humanWasBehind = false;
    this.aiWasBehind = false;
    this.once.clear();
    this.idleCount = 0;
    let cat: LineCategory = 'greet';
    if (ctx.rematch === 'won') cat = 'rematch_won';
    else if (ctx.rematch === 'lost') cat = 'rematch_lost';
    else if (ctx.level >= 0 && Math.random() < 0.5) cat = GREETS[ctx.level] ?? 'greet';
    // A beat after the board lands, so she isn't talking over the tiles-in.
    window.setTimeout(() => {
      if (this.ctx === ctx) void this.nova.say(cat, { priority: 2 });
    }, 700);
  }

  stop() {
    this.ctx = null;
    this.disarmIdle();
  }

  /** The player's turn has started: nudge them if they sit on it. */
  armIdle() {
    this.disarmIdle();
    if (!this.ctx || this.idleCount >= 2) return;
    this.idleTimer = window.setTimeout(() => {
      if (!this.ctx) return;
      this.idleCount++;
      void this.nova.say('idle', { priority: 1 });
    }, 16000);
  }

  disarmIdle() {
    clearTimeout(this.idleTimer);
  }

  /** Just before her own move: an occasional "let me think". */
  beforeAiMove() {
    if (!this.ctx || this.nova.speaking) return;
    if (this.aiMoves > 0 && this.nova.chance(0.1)) void this.nova.say('cpu_think', { priority: 0 });
  }

  afterMove(engine: GameEngine, mover: number, result: MoveResult) {
    const ctx = this.ctx;
    if (!ctx || result.gameOver) return;
    const human = mover === ctx.humanId;
    if (human) this.humanMoves++;
    else this.aiMoves++;
    const moveNo = this.humanMoves + this.aiMoves;
    const board = readBoard(engine, ctx.humanId, ctx.aiId);
    const total = board.humanOrbs + board.aiOrbs;
    const pick = this.choose(engine, ctx, human, result, board, total, moveNo);
    if (!pick) return;
    this.lastLineAt = moveNo;
    void this.nova.say(pick.cat, { priority: pick.priority });
  }

  /** The match is over; the result line is said by whoever shows the card. */
  end() {
    this.disarmIdle();
    this.ctx = null;
  }

  private choose(
    engine: GameEngine,
    ctx: MatchContext,
    human: boolean,
    result: MoveResult,
    board: BoardRead,
    total: number,
    moveNo: number
  ): { cat: LineCategory; priority: number } | null {
    const spaced = moveNo - this.lastLineAt >= 2;
    const n = this.nova;

    // 1. The move itself was a big one.
    if (result.chain >= 6 || result.captured >= 8) {
      if (n.chance(0.95)) return { cat: human ? 'player_huge' : 'cpu_huge', priority: 2 };
    } else if (result.chain >= 3 || result.captured >= 3) {
      if (n.chance(spaced ? 0.6 : 0.3)) return { cat: human ? 'player_chain' : 'cpu_chain', priority: 1.5 };
    }

    // 2. Someone is almost out.
    if (this.humanMoves >= 3 && total >= 6) {
      if (board.aiCells <= 2 && this.first('near_ai') && n.chance(0.9)) return { cat: 'near_out_cpu', priority: 2 };
      if (board.humanCells <= 2 && this.first('near_human') && n.chance(0.9)) return { cat: 'near_out_player', priority: 2 };
    }

    // 3. Lead changes, with comebacks called out once each.
    if (total >= 10) {
      if (board.share <= 0.3) this.humanWasBehind = true;
      if (board.share >= 0.7) this.aiWasBehind = true;
      const lead: Lead = board.share >= 0.66 ? 'human' : board.share <= 0.34 ? 'ai' : this.lead;
      if (lead !== this.lead) {
        const prev = this.lead;
        this.lead = lead;
        if (lead === 'human' && prev === 'ai' && this.humanWasBehind && this.first('comeback')) {
          return { cat: 'comeback', priority: 2 };
        }
        if (lead === 'ai' && prev === 'human' && this.aiWasBehind && this.first('cpu_comeback')) {
          return { cat: 'cpu_comeback', priority: 2 };
        }
        if (lead !== 'even' && n.chance(0.75)) {
          this.leadLineAt = moveNo;
          return { cat: lead === 'human' ? 'player_leading' : 'cpu_leading', priority: 1 };
        }
      } else if (lead !== 'even' && moveNo - this.leadLineAt >= 7 && spaced && n.chance(0.35)) {
        this.leadLineAt = moveNo;
        return { cat: lead === 'human' ? 'player_leading' : 'cpu_leading', priority: 1 };
      }
      if (total >= 16 && board.share >= 0.44 && board.share <= 0.56 && spaced && this.first('close') && n.chance(0.4)) {
        return { cat: 'close', priority: 1 };
      }
    }

    if (!human) return null;
    const placed = result.events.find((e) => e.type === 'place');

    // 4. The opening, and a tip for the first few games.
    if (this.humanMoves === 1 && placed && placed.type === 'place') {
      const corner =
        (placed.row === 0 || placed.row === engine.rows - 1) && (placed.col === 0 || placed.col === engine.cols - 1);
      if (n.chance(0.6)) return { cat: corner ? 'opening_corner' : 'opening', priority: 1 };
    }
    if (this.humanMoves === 2 && ctx.gamesPlayed < 3 && this.first('tip')) {
      return { cat: 'tip', priority: 1 };
    }

    // 5. A placement right beside her loaded cell.
    if (placed && placed.type === 'place' && result.captured === 0 && spaced && isRisky(engine, placed.row, placed.col, ctx.aiId)) {
      if (n.chance(0.45)) return { cat: 'risky', priority: 1 };
    }

    // 6. Nothing happened: the odd bit of chatter.
    if (spaced && result.captured === 0 && this.humanMoves > 2 && n.chance(0.09)) return { cat: 'ambient', priority: 0 };
    return null;
  }

  private first(key: string): boolean {
    if (this.once.has(key)) return false;
    this.once.add(key);
    return true;
  }
}
