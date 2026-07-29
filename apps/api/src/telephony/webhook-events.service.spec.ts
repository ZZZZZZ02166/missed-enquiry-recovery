import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookEventsService, dedupeKeys } from './webhook-events.service';

/**
 * INTEGRATION TEST — requires the docker-compose Postgres (`pnpm db:up`).
 *
 * Deliberately not mocked. The behaviour under test *is* the unique index and
 * `skipDuplicates`: a mocked Prisma client would assert the shape of a call rather
 * than that the constraint holds, and would pass against a schema with no unique
 * index at all. The concurrency case below cannot be expressed against a mock in any
 * meaningful way.
 */

jest.setTimeout(30_000);

/**
 * Every row this suite writes carries this prefix, and cleanup deletes only rows
 * matching it. Truncating the whole table would work locally but would quietly
 * destroy a developer's inspection data, and would make two concurrent runs
 * interfere.
 */
const RUN = `TEST${process.pid}_${Date.now()}`;
const sid = (suffix: string) => `${RUN}_${suffix}`;

const payloadFor = (callSid: string) => ({
  CallSid: callSid,
  From: '+61412345678',
  To: '+61391110000',
  CallStatus: 'no-answer',
});

describe('dedupeKeys', () => {
  // Pure — no database needed. These strings are the correctness boundary for the
  // whole idempotency design, so their shape is pinned.
  it('distinguishes an incoming call from its status callbacks', () => {
    expect(dedupeKeys.voiceIncoming('CA1')).toBe('twilio:voice:incoming:CA1');
    expect(dedupeKeys.voiceStatus('CA1', 'completed')).toBe('twilio:voice:status:CA1:completed');
    expect(dedupeKeys.voiceIncoming('CA1')).not.toBe(dedupeKeys.voiceStatus('CA1', 'completed'));
  });

  it('distinguishes two status values on the same call', () => {
    // The collision the original (provider, externalEventId) key would have caused.
    expect(dedupeKeys.voiceStatus('CA1', 'ringing')).not.toBe(
      dedupeKeys.voiceStatus('CA1', 'completed'),
    );
  });

  it('keeps voice and message namespaces apart', () => {
    expect(dedupeKeys.voiceIncoming('X')).not.toBe(dedupeKeys.messageIncoming('X'));
    expect(dedupeKeys.messageStatus('SM1', 'delivered')).toBe(
      'twilio:message:status:SM1:delivered',
    );
  });
});

describe('WebhookEventsService (integration)', () => {
  let prisma: PrismaService;
  let service: WebhookEventsService;

  beforeAll(async () => {
    // Keep the suite output readable; the service logs a debug line per duplicate.
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    prisma = new PrismaService();
    try {
      await prisma.onModuleInit();
    } catch (cause) {
      // Without this the failure is a raw ECONNREFUSED and looks like a code bug.
      // `cause` is attached rather than stringified so the original stack survives.
      throw new Error(
        'Cannot reach Postgres. This is an integration suite — run `pnpm db:up` first.',
        { cause },
      );
    }
    service = new WebhookEventsService(prisma);
  });

  afterAll(async () => {
    await prisma.db.webhookEvent.deleteMany({ where: { externalEventId: { startsWith: RUN } } });
    await prisma.onModuleDestroy();
    jest.restoreAllMocks();
  });

  const record = (callSid: string, key: string, eventType = 'voice.incoming') =>
    service.record({
      dedupeKey: key,
      externalEventId: callSid,
      eventType,
      payload: payloadFor(callSid),
    });

  describe('idempotency', () => {
    it('records a first delivery', async () => {
      const callSid = sid('first');
      const result = await record(callSid, dedupeKeys.voiceIncoming(callSid));
      expect(result.status).toBe('recorded');
    });

    it('reports a retry of the same delivery as a duplicate', async () => {
      const callSid = sid('retry');
      const key = dedupeKeys.voiceIncoming(callSid);
      expect((await record(callSid, key)).status).toBe('recorded');
      expect((await record(callSid, key)).status).toBe('duplicate');
    });

    it('replaying three times produces exactly one row', async () => {
      // The contract from .claude/skills/twilio/SKILL.md §3.
      const callSid = sid('replay3');
      const key = dedupeKeys.voiceIncoming(callSid);
      await record(callSid, key);
      await record(callSid, key);
      await record(callSid, key);

      const rows = await prisma.db.webhookEvent.findMany({
        where: { externalEventId: callSid },
      });
      expect(rows).toHaveLength(1);
    });

    it('keeps two distinct status callbacks on the same CallSid', async () => {
      // The case a (provider, externalEventId) unique key would have swallowed —
      // the call would never appear to complete, and nothing would error.
      const callSid = sid('statuses');
      const a = await record(callSid, dedupeKeys.voiceStatus(callSid, 'ringing'), 'voice.status');
      const b = await record(callSid, dedupeKeys.voiceStatus(callSid, 'completed'), 'voice.status');

      expect(a.status).toBe('recorded');
      expect(b.status).toBe('recorded');
    });

    it('five deliveries for one call produce three rows', async () => {
      const callSid = sid('mixed');
      const incoming = dedupeKeys.voiceIncoming(callSid);
      await record(callSid, incoming);
      await record(callSid, incoming); // retry
      await record(callSid, incoming); // retry
      await record(callSid, dedupeKeys.voiceStatus(callSid, 'ringing'), 'voice.status');
      await record(callSid, dedupeKeys.voiceStatus(callSid, 'completed'), 'voice.status');

      const rows = await prisma.db.webhookEvent.findMany({
        where: { externalEventId: callSid },
      });
      expect(rows).toHaveLength(3);
    });

    it('records exactly one row when the same delivery arrives concurrently', async () => {
      // The reason record() uses createManyAndReturn(skipDuplicates) rather than a
      // findFirst-then-create: Twilio can retry before the first request has
      // committed, and a check-then-insert would let both through. This is the case
      // a mocked client cannot test at all.
      const callSid = sid('race');
      const key = dedupeKeys.voiceIncoming(callSid);

      const outcomes = await Promise.all([
        record(callSid, key),
        record(callSid, key),
        record(callSid, key),
        record(callSid, key),
        record(callSid, key),
      ]);

      expect(outcomes.filter((o) => o.status === 'recorded')).toHaveLength(1);
      expect(outcomes.filter((o) => o.status === 'duplicate')).toHaveLength(4);

      const rows = await prisma.db.webhookEvent.findMany({
        where: { externalEventId: callSid },
      });
      expect(rows).toHaveLength(1);
    });

    it('stores the payload verbatim', async () => {
      const callSid = sid('payload');
      await record(callSid, dedupeKeys.voiceIncoming(callSid));
      const row = await prisma.db.webhookEvent.findFirst({
        where: { externalEventId: callSid },
      });
      expect(row?.payload).toEqual(payloadFor(callSid));
      expect(row?.signatureValid).toBe(true);
      // The tenant is not known at record time — resolved from `To` afterwards.
      expect(row?.businessId).toBeNull();
      expect(row?.status).toBe('RECEIVED');
    });
  });

  describe('lifecycle transitions', () => {
    const freshEventId = async (label: string): Promise<string> => {
      const callSid = sid(label);
      const result = await record(callSid, dedupeKeys.voiceIncoming(callSid));
      if (result.status !== 'recorded') throw new Error('fixture failed to record');
      return result.event.id;
    };

    it('markProcessed sets status and timestamp', async () => {
      const id = await freshEventId('processed');
      await service.markProcessed(id);
      const row = await prisma.db.webhookEvent.findFirst({ where: { id } });
      expect(row?.status).toBe('PROCESSED');
      expect(row?.processedAt).not.toBeNull();
    });

    it('markProcessed attaches the tenant once resolved', async () => {
      const business = await prisma.db.business.create({
        data: { name: `${RUN} business` },
      });
      try {
        const id = await freshEventId('tenant');
        await service.markProcessed(id, business.id);
        const row = await prisma.db.webhookEvent.findFirst({ where: { id } });
        expect(row?.businessId).toBe(business.id);
      } finally {
        await prisma.db.business.delete({ where: { id: business.id } });
      }
    });

    it('markIgnored is distinct from failure', async () => {
      // A spam caller is a deliberate non-action; collapsing it into FAILED would
      // make failure rate useless as an alert signal.
      const id = await freshEventId('ignored');
      await service.markIgnored(id, 'known spam caller');
      const row = await prisma.db.webhookEvent.findFirst({ where: { id } });
      expect(row?.status).toBe('IGNORED');
      expect(row?.error).toBe('known spam caller');
      expect(row?.attempts).toBe(0);
    });

    it('markFailed increments attempts each time', async () => {
      const id = await freshEventId('failed');
      await service.markFailed(id, 'first failure');
      await service.markFailed(id, 'second failure');
      const row = await prisma.db.webhookEvent.findFirst({ where: { id } });
      expect(row?.status).toBe('FAILED');
      expect(row?.attempts).toBe(2);
      expect(row?.error).toBe('second failure');
    });

    it('truncates a long error rather than letting the column become a log sink', async () => {
      const id = await freshEventId('truncate');
      await service.markFailed(id, 'x'.repeat(5000));
      const row = await prisma.db.webhookEvent.findFirst({ where: { id } });
      expect(row?.error).toHaveLength(500);
      expect(row?.error?.endsWith('…')).toBe(true);
    });
  });

  describe('retention', () => {
    it('leaves rows inside the window untouched', async () => {
      const callSid = sid('fresh');
      await record(callSid, dedupeKeys.voiceIncoming(callSid));
      await service.deleteOlderThan(90);
      const row = await prisma.db.webhookEvent.findFirst({
        where: { externalEventId: callSid },
      });
      expect(row).not.toBeNull();
    });

    it('deletes rows past the window', async () => {
      // docs/compliance.md §7 — this table holds caller numbers and message text,
      // and has no value beyond idempotency once retries have stopped.
      const callSid = sid('stale');
      await prisma.db.webhookEvent.create({
        data: {
          provider: 'TWILIO',
          dedupeKey: dedupeKeys.voiceIncoming(callSid),
          externalEventId: callSid,
          eventType: 'voice.incoming',
          payload: payloadFor(callSid),
          signatureValid: true,
          receivedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
        },
      });

      const removed = await service.deleteOlderThan(90);
      expect(removed).toBeGreaterThanOrEqual(1);

      const row = await prisma.db.webhookEvent.findFirst({
        where: { externalEventId: callSid },
      });
      expect(row).toBeNull();
    });
  });
});
