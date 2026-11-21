/**
 * Where the online relay lives — the one place the address is written.
 *
 * The website's Content-Security-Policy in vercel.json has to list the same
 * host (https and wss), or the browser refuses the connection; change both
 * together.
 *
 * Set VITE_RELAY_URL (e.g. in a gitignored .env.local) to point the client at
 * a local `wrangler dev` instead — necessary any time the protocol changes,
 * since client and relay have to move together.
 */
export const RELAY_BASE: string =
  import.meta.env.VITE_RELAY_URL ?? 'https://chain-reaction-relay.buckycosmo.workers.dev';
