/** Local player record. Deliberately device-local for now — the roadmap only
 *  puts profiles and match history on the server *after* the multiplayer loop
 *  is reliable, so this is the same data shape kept in localStorage until
 *  there's an account system to hang it off. */
export interface PlayerStats {
  matches: number;
  wins: number;
  bestChain: number;
  bestCapture: number;
}

const STORAGE_KEY = 'reacton.stats.v1';

const EMPTY: PlayerStats = { matches: 0, wins: 0, bestChain: 0, bestCapture: 0 };

function read(): PlayerStats {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<PlayerStats>;
    return {
      matches: Number(parsed.matches) || 0,
      wins: Number(parsed.wins) || 0,
      bestChain: Number(parsed.bestChain) || 0,
      bestCapture: Number(parsed.bestCapture) || 0,
    };
  } catch {
    // Private-browsing modes and disabled storage both throw here. Stats are a
    // nice-to-have, never a reason to stop the player getting into a match.
    return { ...EMPTY };
  }
}

function write(stats: PlayerStats) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
  } catch {
    /* storage unavailable — carry on without persisting */
  }
}

export const stats = {
  get(): PlayerStats {
    return read();
  },

  /** Rank tier from matches played and won. A visible progression hook that
   *  costs nothing now and maps onto real ranks once matchmaking exists. */
  level(s: PlayerStats = read()): number {
    return 1 + Math.floor(Math.sqrt(s.matches + s.wins * 2));
  },

  recordChain(chain: number, captured: number) {
    const s = read();
    let dirty = false;
    if (chain > s.bestChain) {
      s.bestChain = chain;
      dirty = true;
    }
    if (captured > s.bestCapture) {
      s.bestCapture = captured;
      dirty = true;
    }
    if (dirty) write(s);
  },

  recordMatch(won: boolean) {
    const s = read();
    s.matches += 1;
    if (won) s.wins += 1;
    write(s);
  },
};
