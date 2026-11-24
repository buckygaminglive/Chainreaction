/**
 * Typed chat: the cleaning every free-text message goes through.
 *
 * Shared by the relay and the app. The relay's copy is the one that counts —
 * it runs before a message is broadcast, so a modified client cannot put
 * unfiltered text on anyone's screen. The app runs the same pass on what it
 * receives too, so an old relay (or a newer word list) never shows less
 * filtering than this build knows about.
 *
 * Typed chat is opt-in on both ends (see main.ts): nobody sees typed messages
 * unless they turned it on themselves, and every typed bubble can be muted or
 * reported. This filter is one layer of that, not the whole of it.
 */

export const TYPED_MAX = 80;
/** Same budget as quick chat; typed and quick share one clock on the relay. */
export const TYPED_COOLDOWN_MS = 2500;

/** Masked wherever they appear inside a word ("fuuuck", "bitches"). */
const ROOTS = [
  'fuck', 'fuk', 'fck', 'shit', 'bitch', 'cunt', 'asshole', 'bastard', 'slut', 'whore', 'motherf',
  'nigg', 'fagg', 'retard', 'dildo', 'jizz', 'porn', 'rapist',
  // Hindi / Hinglish
  'madarch', 'maderch', 'behench', 'bhench', 'benchod', 'chutiy', 'chutia', 'bhosd', 'gandmar',
  'lauda', 'lavda', 'lawda', 'harami', 'jhaat', 'bsdk',
];

/** Masked only as whole words, because they occur innocently inside others
 *  ("dick" in "Dickens", "cum" in "cucumber", "bc" in "abc"). */
const WORDS = new Set([
  'dick', 'dicks', 'cock', 'cocks', 'pussy', 'pussies', 'fag', 'fags', 'twat', 'prick', 'cum', 'tits', 'titties',
  'boobs', 'nude', 'nudes', 'sex', 'sexy', 'rape', 'raped', 'kys', 'nigga', 'niga', 'stfu', 'wtf', 'milf',
  'wank', 'wanker', 'wankers', 'randi', 'randiya', 'chinal', 'gaand', 'gand', 'gaandu',
  'bc', 'mc', 'bkl', 'mkc', 'lund', 'lode', 'chod', 'chodu', 'gandu', 'tatti', 'kutti', 'kamine', 'kamina',
]);

const PHRASES = [/kill\s*(your|ur)\s*self/gi, /go\s*die/gi];

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i' };

function normalise(word: string): string {
  let out = '';
  for (const ch of word.toLowerCase()) out += LEET[ch] ?? ch;
  // "fuuuuck" → "fuck", "shiiit" → "shit".
  return out.replace(/(.)\1+/g, '$1');
}

function isBad(word: string): boolean {
  const n = normalise(word);
  if (!n) return false;
  if (WORDS.has(n) || WORDS.has(word.toLowerCase())) return true;
  const squashed = n.replace(/[^a-z]/g, '');
  return ROOTS.some((r) => {
    const root = r.replace(/\s/g, '');
    return squashed.includes(root) || squashed.includes(root.replace(/(.)\1+/g, '$1'));
  });
}

function mask(word: string): string {
  return word[0] + '*'.repeat(Math.max(2, word.length - 1));
}

/** Links, emails, handles and phone numbers — the ways a stranger moves a
 *  child off the game and somewhere unmoderated. Replaced, not masked. */
const CONTACT = [
  /\b(?:https?:\/\/|www\.)\S+/gi,
  /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g,
  /\b[\w-]+\.(?:com|net|org|io|gg|in|me|co|app|xyz|link|ly|tk|ru|info|biz|site|online|shop)\b\S*/gi,
  /\+?\d(?:[\s-]?\d){6,}/g,
  /\b(?:insta(?:gram)?|snap(?:chat)?|whats\s*app|telegram|discord|tiktok|wa\.me)\b/gi,
];

/**
 * Cleans one typed message. Returns null when nothing sendable is left.
 * Idempotent: running it on its own output changes nothing, which is what
 * lets the relay and the app both apply it.
 */
export function cleanTyped(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let text = '';
  for (const ch of raw) {
    const c = ch.codePointAt(0) ?? 0;
    // Controls, zero-width and bidi overrides: they let a message break or
    // visually reorder the bubble it is rendered in.
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) {
      text += ' ';
      continue;
    }
    if ((c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2060 && c <= 0x206f) || c === 0xfeff) continue;
    text += ch;
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  text = [...text].slice(0, TYPED_MAX).join('');

  for (const re of CONTACT) text = text.replace(re, '•••');
  for (const re of PHRASES) text = text.replace(re, (m) => mask(m.replace(/\s/g, '')));
  // Words are runs of letters, digits and the leet symbols; everything else
  // (spaces, punctuation, emoji) passes through untouched.
  text = text.replace(/[\p{L}\p{N}@$!]+/gu, (w) => (isBad(w) ? mask(w) : w));
  // Spaced-out evasion: "f u c k" → checked as one word.
  text = text.replace(/\b(?:\p{L}[ .\-_]){2,}\p{L}\b/gu, (run) => {
    const joined = run.replace(/[ .\-_]/g, '');
    return isBad(joined) ? mask(joined) : run;
  });

  text = text.trim();
  // A message reduced to masks and dots says nothing; drop it.
  if (!/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(text.replace(/\b\p{L}\*+/gu, ''))) return null;
  return text;
}
