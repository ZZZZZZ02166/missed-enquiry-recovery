import { config } from 'dotenv';
import type { NextConfig } from 'next';

// Next only reads .env from its own directory. One .env at the repo root is the
// source of truth (a per-app copy is how two environments quietly diverge), so
// load it explicitly here before Next reads process.env.
config({ path: ['.env', '../../.env'], quiet: true });

const nextConfig: NextConfig = {
  reactStrictMode: true,

  env: {
    /**
     * The browser's API origin, derived from `PUBLIC_API_URL` rather than read from its
     * own variable.
     *
     * There used to be a separate `NEXT_PUBLIC_API_URL`, and it drifted: it still said
     * port 3001 long after the API moved to 3101 to dodge a port collision. Nothing
     * caught it, because the two are only ever compared by a human — the dashboard
     * quietly called a dead port and showed "could not reach the server", which looks
     * exactly like being offline.
     *
     * `PUBLIC_API_URL` is the right source because it cannot silently drift: Twilio
     * signature validation rebuilds its signed string from it, so a wrong value there
     * fails every webhook loudly. One variable, and the one that is already load-bearing.
     */
    NEXT_PUBLIC_API_URL: process.env.PUBLIC_API_URL ?? 'http://localhost:3101',
  },

  // Fail the build on type errors rather than shipping them. This defaults to false
  // already — stated explicitly so nobody "unblocks a deploy" by flipping it.
  //
  // There is no `eslint` key: Next 16 removed `next lint` and its build-time ESLint
  // integration. Linting runs as its own step (`pnpm lint`) against eslint.config.mjs.
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
