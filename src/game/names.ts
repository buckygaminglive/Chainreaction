/**
 * Starting names for new players: two words run together, like "NeonOtter"
 * or "TurboQuark". Readable on a leaderboard, never longer than the 16-character
 * callsign limit, and different enough that two strangers in a room are
 * unlikely to share one (about 4,000 combinations before the number suffix).
 */
const FIRST = [
  'Atomic', 'Neon', 'Turbo', 'Cosmic', 'Pixel', 'Hyper', 'Solar', 'Lunar', 'Nova', 'Quantum',
  'Rapid', 'Sneaky', 'Lucky', 'Fuzzy', 'Mighty', 'Silent', 'Crimson', 'Golden', 'Frosty', 'Blazing',
  'Electric', 'Wild', 'Clever', 'Spicy', 'Mega', 'Ultra', 'Shadow', 'Stormy', 'Jolly', 'Brave',
  'Swift', 'Glitch', 'Retro', 'Radiant', 'Chill', 'Bouncy', 'Zippy', 'Rogue', 'Velvet', 'Cyber',
  'Plasma', 'Static', 'Wobbly', 'Sunny', 'Mystic', 'Copper', 'Sparky', 'Dizzy', 'Polar', 'Royal',
  'Rusty', 'Comet', 'Loud', 'Tiny', 'Grumpy', 'Witty', 'Noble', 'Feral', 'Primal', 'Proton',
  'Volt', 'Ionic', 'Crispy', 'Salty',
];

const SECOND = [
  'Otter', 'Fox', 'Panda', 'Tiger', 'Falcon', 'Wolf', 'Raven', 'Koala', 'Gecko', 'Lynx',
  'Badger', 'Moose', 'Owl', 'Shark', 'Yeti', 'Dragon', 'Phoenix', 'Kraken', 'Golem', 'Wizard',
  'Ninja', 'Pirate', 'Knight', 'Ranger', 'Comet', 'Quasar', 'Pulsar', 'Quark', 'Photon', 'Neutron',
  'Atom', 'Spark', 'Blaze', 'Storm', 'Rocket', 'Meteor', 'Nebula', 'Orbit', 'Vortex', 'Reactor',
  'Fusion', 'Ember', 'Bolt', 'Echo', 'Cactus', 'Waffle', 'Noodle', 'Pickle', 'Muffin', 'Taco',
  'Mango', 'Penguin', 'Llama', 'Hamster', 'Beetle', 'Cobra', 'Hawk', 'Bison', 'Jaguar', 'Sloth',
  'Walrus', 'Squid', 'Robot', 'Comrade',
];

function pick<T>(list: readonly T[], rand: () => number): T {
  return list[Math.floor(rand() * list.length) % list.length];
}

export const NAME_MAX = 16;

/** A fresh random player name. `rand` is injectable for tests. */
export function randomPlayerName(rand: () => number = Math.random): string {
  for (let i = 0; i < 12; i++) {
    const a = pick(FIRST, rand);
    const b = pick(SECOND, rand);
    if (a === b) continue;
    let name = a + b;
    if (name.length > NAME_MAX) continue;
    // A short pair gets a small number so it still feels like a gamertag.
    if (name.length <= 10 && rand() < 0.35) name += String(Math.floor(rand() * 90) + 10);
    return name;
  }
  return 'NeonOtter';
}

export const NAME_WORDS = { FIRST, SECOND };
