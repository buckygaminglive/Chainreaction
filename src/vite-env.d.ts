/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Overrides the relay the client connects to. Point it at a local
   *  `wrangler dev` when working on the protocol. */
  readonly VITE_RELAY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
