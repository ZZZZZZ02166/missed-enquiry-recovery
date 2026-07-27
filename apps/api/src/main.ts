import { ValidationPipe, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { env } from './config/env';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Needed for Twilio payloads delivered as JSON with a bodySHA256 query param,
    // and for Stripe later. Standard voice and messaging webhooks are form-encoded
    // and sign URL + sorted params instead (CLAUDE.md rule 7) — but enabling this
    // once here is cheap insurance against the JSON case failing mysteriously.
    rawBody: true,
  });

  // Twilio signature validation rebuilds the signed string from the request URL.
  // Behind a proxy, req.protocol reports 'http' while Twilio called 'https', so
  // every signature fails with no useful error. This is the single most common
  // Twilio-on-Nest bug (.claude/skills/twilio/SKILL.md §2).
  app.set('trust proxy', 1);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // Not just whitelist: stripping an injected `businessId` silently is worse
      // than rejecting it, because we never learn someone tried
      // (.claude/skills/backend/SKILL.md §1).
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  app.enableCors({
    // Explicit origin, never '*' — credentialed requests require it, and the
    // dashboard sends the session cookie.
    origin: env.PUBLIC_WEB_URL,
    credentials: true,
  });

  app.enableShutdownHooks();

  await app.listen(env.API_PORT);
  Logger.log(`API listening on ${env.PUBLIC_API_URL} (port ${env.API_PORT})`, 'Bootstrap');
}

void bootstrap();
