import { config } from 'dotenv';
import { defineConfig, env } from 'prisma/config';

// One .env at the repo root, shared by api and web — a per-app copy is how two
// environments quietly diverge. The CLI runs with cwd=apps/api, so the root file is
// two levels up. Local first, so an app-level .env can override during debugging.
config({ path: ['.env', '../../.env'], quiet: true });

// Prisma 7 no longer accepts `url` inside the datasource block in schema.prisma, and
// no longer auto-loads .env — hence the explicit dotenv call above.
//
// This file configures the *CLI* (migrate, studio, db pull). The runtime client gets
// its connection separately, through the PrismaPg driver adapter in PrismaService.
// Two places, one URL: both read DATABASE_URL, so they cannot drift.

type Env = {
  DATABASE_URL: string;
};

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env<Env>('DATABASE_URL'),
  },
});
