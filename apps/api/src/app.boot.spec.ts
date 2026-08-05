import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Queue } from 'bullmq';
import { AppModule } from './app.module';
import { CallsService } from './calls/calls.service';
import { SuppressionsService } from './calls/suppressions.service';
import { ConversationsService } from './conversations/conversations.service';
import { FakeLlmProvider, LLM_PROVIDER, type LlmProvider } from './conversations/llm.provider';
import { HealthController } from './health/health.controller';
import { FollowupProcessor } from './jobs/processors/followup.processor';
import { InboundMessageProcessor } from './jobs/processors/inbound-message.processor';
import { InboundReconcilerProcessor } from './jobs/processors/inbound-reconciler.processor';
import { NotifyOwnerProcessor } from './jobs/processors/notify-owner.processor';
import { RecoveryProcessor } from './jobs/processors/recovery.processor';
import { QUEUE, queueToken } from './jobs/queues';
import { PrismaService } from './prisma/prisma.service';
import { MessagesController } from './telephony/messages.controller';
import { SendCapService } from './telephony/send-cap.service';
import { SMS_PROVIDER, type SmsProvider } from './telephony/sms.provider';
import { VoiceController } from './telephony/voice.controller';
import { WebhookEventsService } from './telephony/webhook-events.service';

/**
 * INTEGRATION TEST — requires docker-compose Postgres and Redis (`pnpm db:up`).
 *
 * Boots the real module graph and resolves everything the two entrypoints depend on.
 *
 * **Why this exists.** Twice now, a provider was missing from a module and every
 * other check passed: typecheck, lint, 138 unit tests and both builds were green
 * while `pnpm dev:worker` died at startup with
 * `UnknownElementException: Nest could not find RecoveryProcessor element`.
 *
 * Nothing in the normal sweep constructs the DI container, so a missing registration
 * — or a circular import that leaves a token `undefined` at decoration time — is
 * invisible to all of it. Those are runtime-only failures with compile-time-looking
 * symptoms, and they are exactly what this catches.
 *
 * It deliberately asserts on *resolution*, not behaviour. Behaviour is covered
 * elsewhere; the question here is only "does the application assemble?"
 */

jest.setTimeout(30_000);

describe('application boot', () => {
  let app: INestApplicationContext;

  beforeAll(async () => {
    try {
      // `abortOnError: false` is essential here. By default Nest calls process.exit()
      // when a dependency cannot be resolved, which kills Jest before any catch runs —
      // the suite still fails, but with a stack trace instead of an explanation.
      app = await NestFactory.createApplicationContext(AppModule, {
        logger: false,
        abortOnError: false,
      });
    } catch (cause) {
      throw new Error(
        'AppModule failed to construct. This is the failure mode unit tests cannot see — ' +
          'usually a provider missing from a module, or a circular import leaving an ' +
          'injection token undefined.\n' +
          'If Postgres or Redis are not running, start them with `pnpm db:up`.',
        { cause },
      );
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it('constructs the whole module graph', () => {
    expect(app).toBeDefined();
  });

  describe('providers the HTTP entrypoint needs', () => {
    it.each([
      ['PrismaService', PrismaService],
      ['WebhookEventsService', WebhookEventsService],
      ['CallsService', CallsService],
      ['SuppressionsService', SuppressionsService],
      ['VoiceController', VoiceController],
      ['MessagesController', MessagesController],
    ])('resolves %s', (_name, token) => {
      expect(app.get(token, { strict: false })).toBeDefined();
    });
  });

  describe('providers the worker entrypoint needs', () => {
    // The exact resolution worker.ts performs. Missing this registration is what
    // broke the worker at steps 50 and 51.
    it('resolves RecoveryProcessor', () => {
      const processor = app.get(RecoveryProcessor, { strict: false });
      expect(processor).toBeInstanceOf(RecoveryProcessor);
    });

    it('resolves InboundMessageProcessor', () => {
      const processor = app.get(InboundMessageProcessor, { strict: false });
      expect(processor).toBeInstanceOf(InboundMessageProcessor);
    });

    it('gives InboundMessageProcessor its own dependencies', () => {
      // Same check as below, and for the same reason: a provider resolves happily
      // with undefined constructor arguments when decorator metadata is missing.
      // `conversations` is the one that matters — without it the processor loads,
      // logs nothing unusual, and throws on the first customer reply.
      const processor = app.get(InboundMessageProcessor, { strict: false }) as unknown as {
        prisma: unknown;
        conversations: unknown;
        suppressions: unknown;
        sendCap: unknown;
        sms: unknown;
      };
      expect(processor.prisma).toBeInstanceOf(PrismaService);
      expect(processor.conversations).toBeInstanceOf(ConversationsService);
      expect(processor.suppressions).toBeInstanceOf(SuppressionsService);
      expect(processor.sendCap).toBeInstanceOf(SendCapService);
      expect(processor.sms).toBeDefined();
    });

    it('resolves FollowupProcessor', () => {
      expect(app.get(FollowupProcessor, { strict: false })).toBeInstanceOf(FollowupProcessor);
    });

    it('resolves NotifyOwnerProcessor', () => {
      const processor = app.get(NotifyOwnerProcessor, { strict: false });
      expect(processor).toBeInstanceOf(NotifyOwnerProcessor);
    });

    it('resolves InboundReconcilerProcessor', () => {
      const processor = app.get(InboundReconcilerProcessor, { strict: false });
      expect(processor).toBeInstanceOf(InboundReconcilerProcessor);
    });

    it('gives InboundReconcilerProcessor its own dependencies', () => {
      const processor = app.get(InboundReconcilerProcessor, { strict: false }) as unknown as {
        prisma: unknown;
        suppressions: unknown;
        inboundQueue: unknown;
      };
      expect(processor.prisma).toBeInstanceOf(PrismaService);
      expect(processor.suppressions).toBeInstanceOf(SuppressionsService);
      // Without the queue it would find stuck rows and be unable to re-drive them —
      // the silent half of a silent failure.
      expect(processor.inboundQueue).toBeDefined();
    });

    it('gives RecoveryProcessor its own dependencies', () => {
      // A provider can resolve while its constructor arguments are undefined — which
      // is precisely what happens when decorator metadata is missing. Checking the
      // instance is not enough; the wiring has to be checked too.
      const processor = app.get(RecoveryProcessor, { strict: false }) as unknown as {
        prisma: unknown;
        suppressions: unknown;
        sms: unknown;
      };
      expect(processor.prisma).toBeInstanceOf(PrismaService);
      expect(processor.suppressions).toBeInstanceOf(SuppressionsService);
      expect(processor.sms).toBeDefined();
    });
  });

  describe('queues', () => {
    it.each(Object.values(QUEUE))('resolves the %s queue', (name) => {
      const queue = app.get<Queue>(queueToken(name), { strict: false });
      expect(queue).toBeInstanceOf(Queue);
      expect(queue.name).toBe(name);
    });

    it('shares one connection across producer queues', () => {
      const connections = Object.values(QUEUE).map(
        (n) => app.get<Queue>(queueToken(n), { strict: false }).opts.connection,
      );
      expect(new Set(connections).size).toBe(1);
    });
  });

  describe('health', () => {
    it('reports both dependencies when they are up', async () => {
      const health = app.get(HealthController, { strict: false });
      const ready = await health.ready();
      expect(ready.status).toBe('ok');
      expect(ready.database).toBe('ok');
      expect(ready.redis).toBe('ok');
      // The scrapable alerting signal, present even in the healthy case so a monitor
      // can distinguish "zero backlog" from "field missing".
      expect(ready.inboundBacklog).toEqual(
        expect.objectContaining({ pending: expect.any(Number), alerting: expect.any(Boolean) }),
      );
    });
  });

  describe('LLM provider', () => {
    // The factory runs at module construction, so this also proves its production
    // guard and its logging happen at boot rather than on first use.
    it('resolves and satisfies the interface', () => {
      const provider = app.get<LlmProvider>(LLM_PROVIDER, { strict: false });
      expect(typeof provider.extractFields).toBe('function');
    });

    it('is the fake in test, never a billed provider', () => {
      // No key is set in CI. If this ever resolves to a real adapter, the test suite
      // has started making paid API calls — which is the failure the seam exists to
      // prevent, and it would show up as a bill rather than a red test.
      const provider = app.get<LlmProvider>(LLM_PROVIDER, { strict: false });
      expect(provider).toBeInstanceOf(FakeLlmProvider);
    });
  });

  describe('SMS provider', () => {
    it('resolves and satisfies the interface', () => {
      const provider = app.get<SmsProvider>(SMS_PROVIDER, { strict: false });
      expect(typeof provider.sendSms).toBe('function');
      expect(typeof provider.lookup).toBe('function');
    });

    it('is injected into the recovery processor', () => {
      // Same instance, not a second one: two providers would mean a test asserting on
      // the fake's `sent` array silently misses what the processor actually sent.
      const processor = app.get(RecoveryProcessor, { strict: false }) as unknown as {
        sms: SmsProvider;
      };
      expect(processor.sms).toBe(app.get<SmsProvider>(SMS_PROVIDER, { strict: false }));
    });
  });

  describe('injection tokens are defined', () => {
    // A circular import does not fail to compile — it leaves the imported binding
    // undefined at module-evaluation time, so `@Inject(queueToken(...))` receives
    // `undefined` and the failure appears as a TypeError at boot.
    it('queueToken is callable and produces distinct tokens', () => {
      expect(typeof queueToken).toBe('function');
      const tokens = Object.values(QUEUE).map((n) => queueToken(n));
      expect(new Set(tokens).size).toBe(tokens.length);
      expect(tokens.every((t) => typeof t === 'string' && t.length > 0)).toBe(true);
    });
  });
});
