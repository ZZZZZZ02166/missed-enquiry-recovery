import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { readKnowledge } from 'shared-types';
import { AuthModule } from './auth/auth.module';
import { AuthService } from './auth/auth.service';
import { SESSION_COOKIE } from './auth/cookies';
import { SuppressionsService } from './calls/suppressions.service';
import { ConversationsService } from './conversations/conversations.service';
import { FakeLlmProvider, LLM_PROVIDER } from './conversations/llm.provider';
import type { Queue } from 'bullmq';
import { InboundMessageProcessor } from './jobs/processors/inbound-message.processor';
import type { NotifyOwnerJobData } from './jobs/queues';
import { NotifyOwnerProcessor } from './jobs/processors/notify-owner.processor';
import { ImportModule } from './imports/import.module';
import { LeadsModule } from './leads/leads.module';
import { LeadsService } from './leads/leads.service';
import { PrismaService } from './prisma/prisma.service';
import { ServicesModule } from './services/services.module';
import { SendCapService } from './telephony/send-cap.service';
import { FakeSmsProvider } from './telephony/sms.provider';

/**
 * INTEGRATION — requires `pnpm db:up`. **The whole product, once.**
 *
 * Every other suite tests one seam. This one walks the entire journey a real business
 * and a real customer take, in order, through the real processors and the real HTTP
 * API — because a system can pass every unit test and still not connect end to end, and
 * that failure is invisible until a customer hits it.
 *
 * Owner configures a catalogue over HTTP
 *   -> customer's missed call produces an inbound reply
 *   -> the numbered menu is sent
 *   -> "1" selects a service without calling the model
 *   -> the remaining questions complete
 *   -> a GST-inclusive price reaches the customer
 *   -> a lead records what they were told
 *   -> the owner is texted with a working magic link
 *   -> that link logs them in and opens the lead
 *   -> they mark it won
 */
describe('the whole journey', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  let inbound: InboundMessageProcessor;
  let notify: NotifyOwnerProcessor;
  const llm = new FakeLlmProvider();
  const sms = new FakeSmsProvider();
  const notifyJobs: NotifyOwnerJobData[] = [];

  const stamp = Date.now();
  const CUSTOMER = `+61413${String(stamp).slice(-6)}`;
  const BUSINESS_SMS = `+61480${String(stamp).slice(-6)}`;
  const OWNER = `+61411${String(stamp).slice(-6)}`;

  let businessId = '';
  let customerId = '';
  let cookie = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, ServicesModule, LeadsModule, ImportModule],
    })
      // The same fake the conversation uses, so one counter covers both paths.
      .overrideProvider(LLM_PROVIDER)
      .useValue(llm)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    prisma = app.get(PrismaService);
    auth = app.get(AuthService);

    // The notify queue is captured rather than mocked away: this test asserts the owner
    // *is* told, so it has to see the enqueue happen. The processor wraps the enqueue in
    // a try/catch — correct in production, and it means passing `undefined` here would
    // have quietly swallowed the one call step 6 depends on.
    inbound = new InboundMessageProcessor(
      prisma,
      new ConversationsService(llm),
      new SuppressionsService(prisma),
      app.get(LeadsService),
      new SendCapService(prisma),
      sms,
      { add: (name: string, data: NotifyOwnerJobData) => { notifyJobs.push(data); return Promise.resolve({ id: name }); } } as unknown as Queue<NotifyOwnerJobData>,
    );
    notify = new NotifyOwnerProcessor(
      prisma,
      new SuppressionsService(prisma),
      new SendCapService(prisma),
      auth,
      sms,
    );

    const business = await prisma.unscoped.business.create({
      data: {
        name: 'Melbourne Sparkle',
        timezone: 'Australia/Melbourne',
        notifyPhoneE164: OWNER,
        // Owner enters prices ex-GST, so the caller must be quoted the inclusive figure.
        pricesIncludeGst: false,
      },
    });
    businessId = business.id;

    await prisma.db.phoneNumber.create({
      data: { businessId, e164: BUSINESS_SMS, purpose: 'SMS_TWO_WAY', status: 'ACTIVE' },
    });
    const user = await prisma.unscoped.user.create({
      data: { businessId, email: `journey-${stamp}@example.com`, name: 'Dave' },
    });
    const customer = await prisma.db.customer.create({
      data: { businessId, phoneE164: CUSTOMER, lineType: 'MOBILE' },
    });
    customerId = customer.id;

    const url = await auth.mintLinkForUser(user.id);
    cookie = `${SESSION_COOKIE}=${encodeURIComponent(
      (await auth.consumeMagicLink(new URL(url).searchParams.get('token')!))!,
    )}`;
  });

  afterAll(async () => {
    if (businessId) await prisma.unscoped.business.delete({ where: { id: businessId } }).catch(() => undefined);
    await app?.close();
  });

  const api = () => request(app.getHttpServer());
  const lastSms = () => sms.sent[sms.sent.length - 1]?.body ?? '';
  const reply = async (body: string, offsetMs: number) => {
    const message = await prisma.db.message.create({
      data: {
        businessId, customerId, direction: 'INBOUND', status: 'RECEIVED',
        fromE164: CUSTOMER, toE164: BUSINESS_SMS, body,
        createdAt: new Date(Date.now() + offsetMs),
      },
    });
    await inbound.process({ messageId: message.id, businessId });
  };

  it('1 — the owner builds a catalogue over HTTP', async () => {
    await api().post('/services').set('Cookie', cookie)
      .send({ name: 'End-of-lease cleaning', pricingType: 'STARTING_FROM', priceCents: 28000 })
      .expect(201);
    await api().post('/services').set('Cookie', cookie)
      .send({ name: 'Oven cleaning', pricingType: 'FIXED', priceCents: 7000, priceConfidence: 'FIRM', requiresConfirmation: false })
      .expect(201);
    await api().post('/services').set('Cookie', cookie)
      .send({ name: 'Carpet steam cleaning', pricingType: 'PER_UNIT', priceCents: 4000, unitLabel: 'room' })
      .expect(201);

    const list = await api().get('/services').set('Cookie', cookie).expect(200);
    expect(list.body).toHaveLength(3);
  });

  it('2 — the owner imports their handbook and approves the answers', async () => {
    // The model reads the document once. This lands in `catalogueRequests`, not
    // `requests` — the two counters are separate precisely so the assertion in step 7
    // keeps meaning what it means.
    llm.respondToImportWith({
      services: [],
      knowledge: [
        {
          question: 'Do you bring your own supplies?',
          aliases: ['do you bring products', 'do I need to provide anything'],
          answer: 'Yes, we bring everything including vacuum, mop and all products.',
          sourceExcerpt: 'Our team arrives fully equipped.',
        },
      ],
    });

    const proposal = await api().post('/import/text').set('Cookie', cookie)
      .send({ text: 'Our team arrives fully equipped. You do not need to provide anything at all.' })
      .expect(201);

    expect(proposal.body.knowledge).toHaveLength(1);
    // Nothing is stored by reading it.
    const before = await prisma.unscoped.business.findUniqueOrThrow({ where: { id: businessId } });
    expect(readKnowledge(before.knowledge)).toHaveLength(0);

    // Mapped field by field rather than echoed back, and that is not incidental: a
    // proposal carries `problems`, which `apply` does not accept, and the global
    // `forbidNonWhitelisted` rejects the whole request rather than stripping it. That is
    // the deliberate posture from `main.ts` — an unknown field is a mistake worth hearing
    // about, not something to swallow — so a client sends what it means to save. The
    // review screen does exactly this.
    await api().post('/import/apply').set('Cookie', cookie)
      .send({
        services: [],
        knowledge: proposal.body.knowledge.map(
          (k: { question: string; aliases: string[]; answer: string }) => ({
            question: k.question, aliases: k.aliases, answer: k.answer,
          }),
        ),
      })
      .expect(201);

    const after = await prisma.unscoped.business.findUniqueOrThrow({ where: { id: businessId } });
    expect(readKnowledge(after.knowledge)).toHaveLength(1);
  });

  it('3 — the first reply gets the numbered menu, built from that catalogue', async () => {
    llm.respondWith({});
    await reply('hi, I missed a call from you', 0);

    const body = lastSms();
    expect(body).toContain('Reply with one number only');
    expect(body).toContain('1. End-of-lease cleaning');
    expect(body).toContain('4. Other');
  });

  it('4 — a question instead of a menu number is answered in the owner\'s words, with no model call', async () => {
    const before = llm.requests.length;
    sms.reset();

    await reply('do you bring your own supplies?', 1500);

    // Word for word what the owner approved. Nothing rewrote it, summarised it, or
    // generated around it — the same guarantee `quoteMessage` gives for figures.
    expect(lastSms()).toBe('Yes, we bring everything including vacuum, mop and all products.');
    // The whole point: the model was not consulted.
    expect(llm.requests.length).toBe(before);

    // And the menu is still outstanding, so their next reply can still be the number.
    // Re-prompting here instead would have been strictly worse: they did not fail to
    // pick, they asked something the owner had already answered.
    const conversation = await prisma.db.conversation.findFirstOrThrow({ where: { businessId } });
    expect(conversation.pendingChoice).not.toBeNull();
  });

  it('4b — a bare word that happens to name an answer is treated as a menu reply, not a question', async () => {
    // The matcher's known weakness, and the gate that contains it. "supplies" scores as
    // the supplies entry on its own — but a menu is outstanding, and a one-word reply
    // with no question form is someone trying to answer it. Answering the FAQ here would
    // strand them: they would never learn their reply was not a valid selection.
    sms.reset();
    await reply('supplies', 1750);

    expect(lastSms()).toContain('one number only');
    expect(lastSms()).not.toContain('vacuum');
  });

  it('5 — "1" selects the service, with no model call', async () => {
    const before = llm.requests.length;
    await reply('1', 2000);

    // The whole point of the strict numeric menu: choosing costs nothing and cannot be
    // misread.
    expect(llm.requests.length).toBe(before);

    const conversation = await prisma.db.conversation.findFirstOrThrow({ where: { businessId } });
    expect(conversation.selectedServiceId).toBeTruthy();
    expect((conversation.collected as Record<string, unknown>).serviceType).toBe('End-of-lease cleaning');
  });

  it('6 — the remaining questions complete and the customer is quoted, GST-inclusive', async () => {
    llm.respondWith({ suburb: 'Southbank', bedrooms: 2, bathrooms: 2 });
    await reply('2 bed 2 bath in Southbank', 3000);

    llm.respondWith({ preferredDate: 'Wednesday' });
    await reply('Wednesday works', 4000);

    const body = lastSms();
    // $280 entered ex-GST must reach the caller as $308 (ACL single-price rule), and a
    // starting-from price must never read as a firm quote.
    expect(body).toContain('starts from $308 incl. GST');
    expect(body).not.toContain('$280');
  });

  it('7 — the lead records exactly what the customer was told', async () => {
    const lead = await prisma.db.lead.findFirstOrThrow({ where: { businessId } });
    expect(lead.quotedAmountCents).toBe(30800);
    expect(lead.quoteType).toBe('FROM');
    expect(lead.quoteShownToCustomer).toBe(true);
    expect(lead.serviceId).toBeTruthy();
    expect(lead.suburb).toBe('Southbank');
    // The config as the owner entered it, frozen — so the conversion stays auditable.
    expect((lead.quoteSnapshot as { priceCents: number }).priceCents).toBe(28000);
  });


  it('8 — the owner is texted a lead with a working login link', async () => {
    const lead = await prisma.db.lead.findFirstOrThrow({ where: { businessId } });

    // The conversation actually asked for the owner to be notified — not just that the
    // processor works when called by hand.
    expect(notifyJobs.some((job) => job.leadId === lead.id)).toBe(true);
    sms.reset();
    await notify.process({ leadId: lead.id, businessId });

    const body = lastSms();
    expect(body).toContain('New lead');
    expect(body).toContain('Southbank');

    const link = /https?:\/\/\S+/.exec(body)?.[0];
    expect(link).toBeTruthy();
    expect(link).toContain(encodeURIComponent(`/leads/${lead.id}`));

    // The link is a real credential, not a decoration.
    const token = new URL(link!).searchParams.get('token')!;
    const session = await auth.consumeMagicLink(token);
    expect(session).toBeTruthy();
    expect((await auth.resolveSession(session!))?.businessId).toBe(businessId);
    // And single use.
    expect(await auth.consumeMagicLink(token)).toBeNull();
  });

  it('9 — the owner opens the lead and marks it won', async () => {
    const lead = await prisma.db.lead.findFirstOrThrow({ where: { businessId } });

    const detail = await api().get(`/leads/${lead.id}`).set('Cookie', cookie).expect(200);
    expect(detail.body.customer.phoneE164).toBe(CUSTOMER);
    expect(detail.body.quotedAmountCents).toBe(30800);
    // The transcript the owner reads before ringing back.
    expect(detail.body.messages.length).toBeGreaterThanOrEqual(4);
    expect(detail.body.messages.some((m: { body: string }) => m.body === '1')).toBe(true);

    const won = await api().patch(`/leads/${lead.id}`).set('Cookie', cookie)
      .send({ status: 'WON', wonValueCents: 48000 }).expect(200);

    expect(won.body.status).toBe('WON');
    expect(won.body.wonValueCents).toBe(48000);
    expect(won.body.closedAt).not.toBeNull();
    // A PATCH answers with the same shape as a GET — the dashboard renders it directly.
    expect(won.body.customer.phoneE164).toBe(CUSTOMER);
  });

  it('10 — every message sent to the customer was billable-safe', async () => {
    const outbound = await prisma.db.message.findMany({
      where: { businessId, direction: 'OUTBOUND' },
      select: { body: true, segments: true, providerMessageSid: true },
    });

    expect(outbound.length).toBeGreaterThan(0);
    for (const message of outbound) {
      // Nothing left reserved-but-unsent, and nothing outside the GSM-7 budget: one
      // curly apostrophe would have tripled the bill on every send.
      expect(message.providerMessageSid).toBeTruthy();
      expect(message.segments ?? 1).toBeLessThanOrEqual(2);
    }
  });
});
