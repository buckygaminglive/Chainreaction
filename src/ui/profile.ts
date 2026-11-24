/**
 * The profile screen: who you are, where you rank, and what you have played.
 *
 * Its own module rather than more of `main.ts`, which is already the largest
 * file in the project. Everything here reads from the account and the local
 * stats and writes back through `account`; it owns no game state.
 *
 * Two records are shown and deliberately kept apart. The ranked record belongs
 * to the account and follows the player between devices; the local record is
 * this browser's own tally of pass-and-play. Summing them would produce a
 * number that answers no question anybody has.
 */
import { account } from '../net/account';
import { stats } from '../game/stats';
import { rankFor, rankProgress, nextRankAt } from '../game/rank';
import { rankBadgeSvg } from '../render/rankBadge';
import { PICKER_KEYS, DEFAULT_AVATAR, avatarSvg, avatarName, defaultAvatarFor } from '../render/avatar';
import type { MatchRecord, PlayerProfile } from '../net/protocol';

const $ = (id: string) => document.getElementById(id) as HTMLElement;

/** Escapes text taken from the relay before it goes anywhere near innerHTML.
 *  Names are cleaned server-side, but a second build writing to this endpoint
 *  is exactly the sort of assumption that stops being true quietly. */
function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
}

/**
 * "just now", "18m", "3h", "6d".
 *
 * Relative rather than absolute because a stored timestamp carries no
 * timezone, and rendering one in the viewer's zone would silently claim a
 * match happened at a time it did not.
 */
function ago(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

/** Renders the rank badge, tier name, rating and progress to the next tier. */
function renderRank(profile: PlayerProfile) {
  const rank = rankFor(profile.rating);
  $('profile-badge').innerHTML = rankBadgeSvg(rank, 68);
  $('profile-rank-name').textContent = rank.name;
  $('profile-rank-name').style.color = rank.css;
  $('profile-rating').textContent = String(profile.rating);

  const progress = Math.round(rankProgress(profile.rating) * 100);
  const fill = $('profile-rank-fill');
  // scaleX rather than width, so the fill animates on the compositor.
  fill.style.transform = `scaleX(${progress / 100})`;
  fill.style.background = rank.css;
  fill.parentElement?.setAttribute('aria-valuenow', String(progress));

  const next = nextRankAt(profile.rating);
  $('profile-rank-note').textContent =
    next === null
      ? 'Top tier. Nothing above this one.'
      : `${next - profile.rating} pts to ${rankFor(next).name}.`;
}

function renderRecord(profile: PlayerProfile) {
  $('profile-wins').textContent = String(profile.wins);
  $('profile-losses').textContent = String(profile.losses);
  // Ranked matches only, and only once there are some: "0%" on a fresh account
  // reads as a verdict rather than as an absence of data.
  $('profile-winrate').textContent = profile.matches
    ? `${Math.round((profile.wins / profile.matches) * 100)}%`
    : '—';
  $('profile-chain').textContent = `×${profile.bestChain}`;
}

function renderHistory(matches: MatchRecord[]) {
  const host = $('profile-history');
  // The empty state drops the list chrome. A lone paragraph inside a bordered,
  // filled row container reads as a disabled text input rather than as "there
  // is nothing here yet".
  host.classList.toggle('is-empty', matches.length === 0);
  if (!matches.length) {
    host.innerHTML =
      '<span class="empty-mark" aria-hidden="true"></span>' +
      '<p>No ranked matches yet.<br><span class="empty-hint">Win or lose a quick match and it appears here.</span></p>';
    return;
  }
  host.innerHTML = matches
    .map((m) => {
      const sign = m.delta > 0 ? '+' : '';
      return `
      <div class="history-row ${m.won ? 'won' : 'lost'}">
        <span class="history-avatar">${avatarSvg(m.opponentAvatar || defaultAvatarFor(m.opponent), 28)}</span>
        <span class="history-outcome">${m.won ? 'Win' : 'Loss'}</span>
        <span class="history-opponent">${esc(m.opponent)}</span>
        <span class="history-chain">×${m.bestChain}</span>
        <span class="history-delta ${m.delta >= 0 ? 'up' : 'down'}">${sign}${m.delta}</span>
        <span class="history-when">${ago(m.at)}</span>
      </div>`;
    })
    .join('');
}

function renderLocal() {
  const s = stats.get();
  const losses = Math.max(0, s.matches - s.wins);
  $('profile-local').innerHTML = `
    <div class="win-metrics">
      <div class="win-metric"><span class="mv">${s.wins}</span><span class="mk">wins</span></div>
      <div class="win-metric"><span class="mv">${losses}</span><span class="mk">losses</span></div>
      <div class="win-metric"><span class="mv">×${s.bestChain}</span><span class="mk">best chain</span></div>
      <div class="win-metric"><span class="mv">${s.bestCapture}</span><span class="mk">best capture</span></div>
    </div>`;
}

/** Builds the avatar grid once. Selection state is applied separately so
 *  choosing does not rebuild twenty-four SVGs. */
function buildPicker(onPick: (key: string) => void) {
  const host = $('profile-avatar-picker');
  if (host.childElementCount) return;
  host.innerHTML = PICKER_KEYS.map(
    (key) =>
      `<button class="avatar-option" data-avatar="${key}" title="${avatarName(key)}" aria-label="${avatarName(key)}">${avatarSvg(key, 44)}</button>`
  ).join('');
  host.addEventListener('click', (e) => {
    const button = (e.target as HTMLElement).closest<HTMLElement>('[data-avatar]');
    if (button?.dataset.avatar) onPick(button.dataset.avatar);
  });
}

function markSelected(key: string) {
  $('profile-avatar-picker')
    .querySelectorAll<HTMLElement>('[data-avatar]')
    .forEach((el) => el.classList.toggle('active', el.dataset.avatar === key));
}

export interface ProfileHooks {
  /** Plays the shared button tick, so this module needs no audio import. */
  tap: () => void;
  /** Opens the existing rename flow rather than duplicating it here. */
  onRename: () => void;
  /** Called after a successful avatar change, so callers can refresh any
   *  other place the avatar is shown. */
  onChanged?: (profile: PlayerProfile) => void;
}

let hooks: ProfileHooks;

/**
 * Fills the profile from the account, then fetches history in the background.
 *
 * The two are separate on purpose: everything except history is already known
 * locally, so the screen paints immediately and the network only delays the
 * one section that genuinely needs it.
 */
export async function renderProfile() {
  // The account is minted lazily when a player first goes online, so opening
  // this screen from the title is often the first time it has been needed.
  // `load` fetches a stored one and, deliberately, never creates one — looking
  // at your own profile should not sign a local-only player up for anything.
  if (!account.profile && account.credentials) {
    // The markup's placeholder values (Bronze, 1000, zeroes) would otherwise
    // sit there looking like a real, empty record for the length of a round
    // trip. Blanking them says "fetching" rather than "you have nothing".
    $('profile-name').textContent = 'Loading…';
    $('profile-rank-note').textContent = '';
    const host = $('profile-history');
    host.classList.add('is-empty');
    host.innerHTML = '<span class="empty-mark spin-mark" aria-hidden="true"></span><p>Loading…</p>';
    await account.load();
  }

  const profile = account.profile;
  if (!profile) {
    // A local-only player has no account yet, and that is a normal state
    // rather than an error — the screen still has their device record to show.
    // It gets a real avatar and badge anyway: leaving those two boxes empty
    // reads as something failing to load rather than as nothing to show.
    $('profile-name').textContent = 'No account yet';
    $('profile-code').textContent = '------';
    $('profile-avatar-btn').innerHTML = avatarSvg(DEFAULT_AVATAR, 76);
    $('profile-badge').innerHTML = rankBadgeSvg(rankFor(0), 68);
    $('profile-rank-note').textContent = 'Play online once to be placed on the ladder.';
    const host = $('profile-history');
    host.classList.add('is-empty');
    host.innerHTML =
      '<span class="empty-mark" aria-hidden="true"></span>' +
      '<p>No account yet.<br><span class="empty-hint">Play online once and one is created for you — no sign-up.</span></p>';
    renderLocal();
    return;
  }

  const avatar = profile.avatar || defaultAvatarFor(profile.id);
  $('profile-name').textContent = profile.name;
  $('profile-code').textContent = profile.friendCode;
  $('profile-avatar-btn').innerHTML = avatarSvg(avatar, 76);
  markSelected(avatar);

  renderRank(profile);
  renderRecord(profile);
  renderLocal();

  const host = $('profile-history');
  host.classList.add('is-empty');
  host.innerHTML = '<span class="empty-mark spin-mark" aria-hidden="true"></span><p>Loading…</p>';
  renderHistory(await account.history());
}

/** Wires the screen once. Safe to call at startup; does no network work. */
export function initProfile(h: ProfileHooks) {
  hooks = h;

  buildPicker(async (key) => {
    hooks.tap();
    // Painted before the round trip so the choice feels instant, then
    // reconciled: if the relay rejects the key, the next render puts the real
    // one back rather than leaving a lie on screen.
    markSelected(key);
    $('profile-avatar-btn').innerHTML = avatarSvg(key, 76);
    const updated = await account.setAvatar(key);
    if (updated) {
      markSelected(updated.avatar);
      $('profile-avatar-btn').innerHTML = avatarSvg(updated.avatar, 76);
      hooks.onChanged?.(updated);
    }
  });

  $('profile-avatar-btn').addEventListener('click', () => {
    hooks.tap();
    const picker = $('profile-avatar-picker');
    const opening = picker.classList.contains('hidden');
    picker.classList.toggle('hidden', !opening);
    $('profile-avatar-btn').setAttribute('aria-expanded', String(opening));
  });

  $('profile-rename-btn').addEventListener('click', () => {
    hooks.tap();
    hooks.onRename();
  });

  $('profile-copy-btn').addEventListener('click', async () => {
    hooks.tap();
    const code = $('profile-code').textContent ?? '';
    const button = $('profile-copy-btn');
    try {
      await navigator.clipboard.writeText(code);
      button.textContent = 'copied';
    } catch {
      // Clipboard access is refused in plenty of ordinary situations — an
      // insecure origin, a browser that wants a fresher gesture. The code is
      // on screen either way, so this says so instead of failing.
      button.textContent = 'select it';
    }
    setTimeout(() => (button.textContent = 'copy'), 1600);
  });
}
