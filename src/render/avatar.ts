/**
 * Player avatars, drawn rather than uploaded.
 *
 * A player picks one of a fixed set and the relay stores the key — `"volt"`,
 * a few bytes — instead of an image. That is a deliberate trade, not a
 * shortcut: accepting uploaded pictures would mean object storage, resizing, a
 * moderation path, a reporting flow, and a Play listing that has to declare
 * user-generated content and collected photos. None of that buys a
 * chain-reaction game anything a drawn character does not.
 *
 * The set is the Orb Crew (art/crew.ts). The original 24 emblem keys ("c1"…
 * "m4") stay valid forever: accounts already hold them, the relay still hands
 * them out as defaults, and older app versions can only draw those. This build
 * draws each of them as a crew member, so every player looks like part of the
 * same cast whichever key their account happens to hold.
 */
import { CREW, crewSvg } from '../art/crew.ts';

const LEGACY_HUES = ['c', 'r', 'a', 'v', 'g', 'm'];
const LEGACY_FORMS = ['1', '2', '3', '4'];

/** The original emblem keys, in their original order (the default hash
 *  depends on it). */
export const LEGACY_KEYS: string[] = LEGACY_HUES.flatMap((h) => LEGACY_FORMS.map((f) => h + f));

export const CREW_KEYS: string[] = CREW.map((c) => c.key);

/** What the avatar picker offers. */
export const PICKER_KEYS: string[] = CREW_KEYS;

/** Every key the relay will store. */
export const AVATAR_KEYS: string[] = [...CREW_KEYS, ...LEGACY_KEYS];

export const DEFAULT_AVATAR = 'volt';

/** Whether `key` names an avatar this build accepts. */
export function isAvatarKey(key: unknown): key is string {
  return typeof key === 'string' && AVATAR_KEYS.includes(key);
}

/**
 * A stable avatar for a player who has never chosen one.
 *
 * Still drawn from the legacy keys, with the same hash as before: the relay
 * computes this for every player without a saved choice, and an older app
 * version shown a key it does not know would draw a blank default for
 * everyone. Derived from the id so a returning player keeps the same face and
 * a lobby of players who skipped the picker still looks like several people.
 */
export function defaultAvatarFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return LEGACY_KEYS[hash % LEGACY_KEYS.length];
}

/** The crew member a key is drawn as. Legacy keys spread evenly over the crew. */
export function crewFor(key: string): string {
  if (CREW_KEYS.includes(key)) return key;
  const legacy = LEGACY_KEYS.indexOf(key);
  return legacy >= 0 ? CREW_KEYS[legacy % CREW_KEYS.length] : DEFAULT_AVATAR;
}

/** A readable name, for the picker's accessible labels. */
export function avatarName(key: string): string {
  const crew = crewFor(key);
  return CREW.find((c) => c.key === crew)?.name ?? 'Player';
}

/** The avatar as standalone SVG markup, sized to `size` px. */
export function avatarSvg(key: string, size = 64): string {
  return crewSvg(crewFor(key), size);
}
