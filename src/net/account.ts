import type { LeaderboardRow, PlayerProfile } from './protocol';

/**
 * The device's guest account.
 *
 * There is no sign-up: the relay mints an id and a secret the first time the
 * player opens the online screen, and this module keeps them. That is a
 * deliberate trade — no login wall, no password to forget, no personal data to
 * hold — against one real cost the UI has to be honest about: clear the
 * browser's storage and the account is gone. A friend code is what makes it
 * shareable in the meantime, and account linking is additive later.
 */

const RELAY_BASE =
  import.meta.env.VITE_RELAY_URL ?? 'https://chain-reaction-relay.buckygaminglive.workers.dev';
const KEY = 'reacton.account.v1';

interface StoredAccount {
  id: string;
  secret: string;
}

function readStored(): StoredAccount | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredAccount>;
    if (!parsed.id || !parsed.secret) return null;
    return { id: parsed.id, secret: parsed.secret };
  } catch {
    return null; // storage disabled — the player just stays anonymous
  }
}

function writeStored(account: StoredAccount) {
  try {
    localStorage.setItem(KEY, JSON.stringify(account));
  } catch {
    /* storage disabled; the account lives for this session only */
  }
}

async function post<T>(route: string, body: unknown): Promise<T> {
  const res = await fetch(`${RELAY_BASE}/api/player/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  // A throttled call is not a broken one, and the difference matters: the
  // caller can tell the player to wait rather than that something failed.
  if (res.status === 429) {
    const seconds = Number(res.headers.get('Retry-After')) || 0;
    throw new Error(
      seconds >= 60
        ? `Too many attempts. Try again in about ${Math.ceil(seconds / 60)} minutes.`
        : `Too many attempts. Try again in ${seconds || 30} seconds.`
    );
  }
  if (!res.ok) throw new Error('Could not reach the player service.');
  return (await res.json()) as T;
}

class Account {
  profile: PlayerProfile | null = null;
  private stored: StoredAccount | null = readStored();

  get isSignedIn(): boolean {
    return !!this.profile;
  }

  /** Credentials for the room socket, so a ranked result can be attributed. */
  get credentials(): { id: string; secret: string } | null {
    return this.stored;
  }

  /**
   * Loads the existing account or mints one. Safe to call repeatedly.
   *
   * A stored account whose id the server no longer recognises is replaced
   * rather than surfaced as an error — from the player's side that is a fresh
   * device, and there is nothing they could do about it anyway.
   */
  async ensure(preferredName?: string): Promise<PlayerProfile | null> {
    try {
      if (this.stored) {
        const res = await post<{ player?: PlayerProfile; error?: string }>('me', this.stored);
        if (res.player) {
          this.profile = res.player;
          return this.profile;
        }
      }
      const created = await post<{ player: PlayerProfile; secret: string }>('register', {
        name: preferredName,
      });
      this.stored = { id: created.player.id, secret: created.secret };
      writeStored(this.stored);
      this.profile = created.player;
      return this.profile;
    } catch {
      // Offline or the service is down — online play can still work, it just
      // won't be ranked.
      return null;
    }
  }

  async rename(name: string): Promise<PlayerProfile | null> {
    if (!this.stored) return null;
    const res = await post<{ player?: PlayerProfile }>('rename', { ...this.stored, name });
    if (res.player) this.profile = res.player;
    return this.profile;
  }

  async addFriend(friendCode: string): Promise<{ added?: PlayerProfile | null; error?: string }> {
    if (!this.stored) return { error: 'No account yet.' };
    return post('addFriend', { ...this.stored, friendCode });
  }

  async removeFriend(friendId: string): Promise<void> {
    if (!this.stored) return;
    await post('removeFriend', { ...this.stored, friendId });
  }

  async friendsBoard(): Promise<LeaderboardRow[]> {
    if (!this.stored) return [];
    const res = await post<{ rows?: LeaderboardRow[] }>('friends', this.stored);
    return res.rows ?? [];
  }

  async worldBoard(): Promise<LeaderboardRow[]> {
    const res = await post<{ rows?: LeaderboardRow[] }>('leaderboard', {});
    return res.rows ?? [];
  }
}

export const account = new Account();
