import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/**
 * The worker entrypoint. Same modules and same image as `main.ts`, different start
 * command (docs/decisions.md D7).
 *
 * `createApplicationContext` gives dependency injection without an HTTP listener.
 * A worker that opens a port is a worker a platform will health-check and restart
 * as if it were a web service.
 *
 * BullMQ processors register themselves through the (not yet built) jobs module.
 * Until then this boots, connects, and idles — which is enough to prove the second
 * entrypoint shares the module graph.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);

  // Without this, a deploy kills workers mid-job. Those jobs stall and re-run —
  // survivable only because processors are idempotent, but no reason to rely on it
  // (.claude/skills/queues-redis/SKILL.md §8).
  app.enableShutdownHooks();

  Logger.log('Worker started', 'Worker');
}

void bootstrap();
