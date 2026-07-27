import { config } from 'dotenv';
import type { NextConfig } from 'next';

// Next only reads .env from its own directory. One .env at the repo root is the
// source of truth (a per-app copy is how two environments quietly diverge), so
// load it explicitly here before Next reads process.env.
config({ path: ['.env', '../../.env'], quiet: true });

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Fail the build on type errors rather than shipping them. This defaults to false
  // already — stated explicitly so nobody "unblocks a deploy" by flipping it.
  //
  // There is no `eslint` key: Next 16 removed `next lint` and its build-time ESLint
  // integration. Linting runs as its own step (`pnpm lint`) against eslint.config.mjs.
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
