import { DurableObject } from 'cloudflare:workers';
import type { LeaderboardRow, PlayerProfile } from '../src/net/protocol';

/**
 * Player identity, friends and leaderboards, in one durable object.
 *
 * Identity here is a *guest account*: the server mints an id and a secret on
 * first launch and the client keeps them. No email, no password, no OAuth —
 * which means no login wall in front of a game people came to play, and no
 * personal data to protect. The cost is honest and worth stating in the UI:
 * lose the browser storage and you lose the account. Linking a real identity
 * later is additive.
 *
 * One instance for the whole game, same reasoning as the matchmaker: a global
 * leaderboard is inherently a single ordering, and this is nowhere near the
 * limits of one object. The escape hatch if that changes is D1.
 */

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alikes, same as room codes
const FRIEND_CODE_LEN = 6;
const LEADERBOARD_SIZE = 200;
const STARTING_RATING = 1000;
/** Elo K-factor. Deliberately brisk: this is a party game, and a ladder that
 *  takes fifty matches to place someone reads as broken rather than rigorous. */
const K_FACTOR = 24;
const MAX_FRIENDS = 100;

interface StoredPlayer extends PlayerProfile {
  secret: string;
}

export interface PlayerHubEnv {
  PLAYER_HUB: DurableObjectNamespace<PlayerHub>;
}

function randomCode(): string {
  let code = '';
  for (let i = 0; i < FRIEND_CODE_LEN; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

function cleanName(raw: unknown, fallback: string): string {
  let out = '';
  for (const ch of String(raw ?? '')) {
    const code = ch.codePointAt(0) ?? 0;
    // Strip C0/C1 controls plus the zero-width and bidi-override ranges:
    // they let a name break or visually reorder the row it is rendered in,
    // which escaping on output does not prevent.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    if (code >= 0x200b && code <= 0x200f) continue;
    if (code >= 0x2028 && code <= 0x202e) continue;
    out += ch;
  }
  return out.trim().slice(0, 16) || fallback;
}

function expectedScore(a: number, b: number): number {
  return 1 / (1 + 10 ** ((b - a) / 400));
}

export class PlayerHub extends DurableObject<PlayerHubEnv> {
  private async getPlayer(id: string): Promise<StoredPlayer | undefined> {
    return this.ctx.storage.get<StoredPlayer>(`player:${id}`);
  }

  /** Verifies a caller actually owns the account it claims. Every mutating
   *  route goes through this — an id alone is public information. */
  private async authed(id: unknown, secret: unknown): Promise<StoredPlayer | null> {
    if (typeof id !== 'string' || typeof secret !== 'string') return null;
    const player = await this.getPlayer(id);
    if (!player || player.secret !== secret) return null;
    return player;
  }

  private async savePlayer(player: StoredPlayer) {
    await this.ctx.storage.put(`player:${player.id}`, player);
    await this.updateLeaderboard(player);
  }

  /** Keeps a bounded top-N rather than sorting every player on read. */
  private async updateLeaderboard(player: StoredPlayer) {
    const board = (await this.ctx.storage.get<LeaderboardRow[]>('leaderboard')) ?? [];
    const row: LeaderboardRow = {
      id: player.id,
      name: player.name,
      rating: player.rating,
      wins: player.wins,
      matches: player.matches,
      bestChain: player.bestChain,
    };
    const idx = board.findIndex((r) => r.id === player.id);
    if (idx !== -1) board[idx] = row;
    else board.push(row);
    board.sort((a, b) => b.rating - a.rating || b.wins - a.wins);
    await this.ctx.storage.put('leaderboard', board.slice(0, LEADERBOARD_SIZE));
  }

  private publicOf(player: StoredPlayer): PlayerProfile {
    const { secret: _secret, ...rest } = player;
    return rest;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    const path = url.pathname.replace(/^.*\/(?=[^/]+$)/, '');

    switch (path) {
      case 'register':
        return Response.json(await this.register(body as { name?: string }));
      case 'rename':
        return Response.json(await this.rename(body as Record<string, unknown>));
      case 'me':
        return Response.json(await this.me(body as Record<string, unknown>));
      case 'addFriend':
        return Response.json(await this.addFriend(body as Record<string, unknown>));
      case 'removeFriend':
        return Response.json(await this.removeFriend(body as Record<string, unknown>));
      case 'friends':
        return Response.json(await this.friendsBoard(body as Record<string, unknown>));
      case 'leaderboard':
        return Response.json({
          rows: ((await this.ctx.storage.get<LeaderboardRow[]>('leaderboard')) ?? []).slice(0, 100),
        });
      case 'result':
        return Response.json(await this.recordResult(body as Record<string, unknown>));
      default:
        return new Response('Not found', { status: 404 });
    }
  }

  private async register({ name }: { name?: string }) {
    const id = crypto.randomUUID();
    // Retry on collision rather than trusting six random characters to be
    // unique forever.
    let code = randomCode();
    for (let i = 0; i < 8; i++) {
      if (!(await this.ctx.storage.get(`code:${code}`))) break;
      code = randomCode();
    }
    const player: StoredPlayer = {
      id,
      secret: crypto.randomUUID(),
      name: cleanName(name, `Player${Math.floor(100 + Math.random() * 900)}`),
      friendCode: code,
      rating: STARTING_RATING,
      wins: 0,
      losses: 0,
      matches: 0,
      bestChain: 0,
    };
    await this.ctx.storage.put(`code:${code}`, id);
    await this.savePlayer(player);
    return { player: this.publicOf(player), secret: player.secret };
  }

  private async rename(body: Record<string, unknown>) {
    const player = await this.authed(body.id, body.secret);
    if (!player) return { error: 'Unknown player.' };
    player.name = cleanName(body.name, player.name);
    await this.savePlayer(player);
    return { player: this.publicOf(player) };
  }

  private async me(body: Record<string, unknown>) {
    const player = await this.authed(body.id, body.secret);
    if (!player) return { error: 'Unknown player.' };
    return { player: this.publicOf(player) };
  }

  private async addFriend(body: Record<string, unknown>) {
    const player = await this.authed(body.id, body.secret);
    if (!player) return { error: 'Unknown player.' };
    const code = String(body.friendCode ?? '').trim().toUpperCase();
    const targetId = await this.ctx.storage.get<string>(`code:${code}`);
    if (!targetId) return { error: 'No player with that friend code.' };
    if (targetId === player.id) return { error: "That's your own friend code." };

    const friends = (await this.ctx.storage.get<string[]>(`friends:${player.id}`)) ?? [];
    if (friends.includes(targetId)) return { error: 'Already on your friends list.' };
    if (friends.length >= MAX_FRIENDS) return { error: 'Your friends list is full.' };
    friends.push(targetId);
    await this.ctx.storage.put(`friends:${player.id}`, friends);

    // Mutual by design. A one-way friendship would mean your friends board and
    // theirs disagree about who is on it, which reads as a bug.
    const theirs = (await this.ctx.storage.get<string[]>(`friends:${targetId}`)) ?? [];
    if (!theirs.includes(player.id) && theirs.length < MAX_FRIENDS) {
      theirs.push(player.id);
      await this.ctx.storage.put(`friends:${targetId}`, theirs);
    }

    const target = await this.getPlayer(targetId);
    return { added: target ? this.publicOf(target) : null };
  }

  private async removeFriend(body: Record<string, unknown>) {
    const player = await this.authed(body.id, body.secret);
    if (!player) return { error: 'Unknown player.' };
    const targetId = String(body.friendId ?? '');
    for (const [owner, other] of [
      [player.id, targetId],
      [targetId, player.id],
    ]) {
      const list = (await this.ctx.storage.get<string[]>(`friends:${owner}`)) ?? [];
      await this.ctx.storage.put(
        `friends:${owner}`,
        list.filter((f) => f !== other)
      );
    }
    return { ok: true };
  }

  private async friendsBoard(body: Record<string, unknown>) {
    const player = await this.authed(body.id, body.secret);
    if (!player) return { error: 'Unknown player.' };
    const friends = (await this.ctx.storage.get<string[]>(`friends:${player.id}`)) ?? [];
    const rows: LeaderboardRow[] = [];
    // You are always on your own friends board — a board you are not on gives
    // you nothing to measure against.
    for (const id of [player.id, ...friends]) {
      const p = await this.getPlayer(id);
      if (!p) continue;
      rows.push({
        id: p.id,
        name: p.name,
        rating: p.rating,
        wins: p.wins,
        matches: p.matches,
        bestChain: p.bestChain,
      });
    }
    rows.sort((a, b) => b.rating - a.rating || b.wins - a.wins);
    return { rows };
  }

  /**
   * Applies a finished ranked match. Called by the relay, never by a client —
   * the relay is the only party that actually knows who won.
   *
   * Rating is only adjusted for head-to-head results. A free-for-all has no
   * single opponent to rate against, so those still count towards wins and
   * matches but leave the ladder alone rather than inventing a number.
   */
  private async recordResult(body: Record<string, unknown>) {
    const entries = (body.players ?? []) as { id: string; secret: string; won: boolean; bestChain?: number }[];
    if (!Array.isArray(entries) || entries.length < 2) return { ok: false };

    // Two seats on one account is someone playing themselves on two devices,
    // which would let them hand their own rating a win. Nothing to rate here.
    const ids = new Set(entries.map((e) => e?.id));
    if (ids.size !== entries.length) return { ok: false, error: 'duplicate account in result' };

    const loaded: StoredPlayer[] = [];
    const won: boolean[] = [];
    for (const e of entries) {
      const p = await this.authed(e.id, e.secret);
      // An unverified entry disqualifies the whole result rather than being
      // dropped: a partial result would rate the honest half of the match.
      if (!p) return { ok: false, error: 'unverified player in result' };
      loaded.push(p);
      won.push(!!e.won);
    }

    for (let i = 0; i < loaded.length; i++) {
      const p = loaded[i];
      p.matches += 1;
      if (won[i]) p.wins += 1;
      else p.losses += 1;
      const chain = Number(entries[i].bestChain) || 0;
      if (chain > p.bestChain) p.bestChain = chain;
    }

    // Captured before any rating moves, so the delta reported back is the one
    // this match actually caused.
    const before = loaded.map((p) => p.rating);

    if (loaded.length === 2) {
      const [a, b] = loaded;
      const scoreA = won[0] ? 1 : 0;
      const ratingA = a.rating;
      const ratingB = b.rating;
      a.rating = Math.round(ratingA + K_FACTOR * (scoreA - expectedScore(ratingA, ratingB)));
      b.rating = Math.round(ratingB + K_FACTOR * (1 - scoreA - expectedScore(ratingB, ratingA)));
    }

    for (const p of loaded) await this.savePlayer(p);
    // The delta, not just the new number: "1043" tells a player nothing about
    // the match they just played, and recomputing it client-side would mean
    // trusting a client to remember what its rating was before.
    return {
      ok: true,
      ratings: loaded.map((p, i) => ({ id: p.id, rating: p.rating, delta: p.rating - before[i] })),
    };
  }
}
