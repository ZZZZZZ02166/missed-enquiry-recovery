import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { SESSION_COOKIE } from '../auth/cookies';
import { PrismaService } from '../prisma/prisma.service';
import { LeadsModule } from './leads.module';

/**
 * INTEGRATION — requires `pnpm db:up`. The owner's inbox over real HTTP.
 *
 * This is the surface the magic link in every lead SMS opens onto, so the tenancy tests
 * here matter more than most: a leak means one cleaning business reading another's
 * customers, phone numbers and quotes.
 */
describe('leads over HTTP', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;

  const stamp = Date.now();
  let businessA = '';
  let businessB = '';
  let cookieA = '';
  let cookieB = '';
  let leadA = '';

  const sessionFor = async (userId: string) => {
    const url = await auth.mintLinkForUser(userId);
    return (await auth.consumeMagicLink(new URL(url).searchParams.get('token')!))!;
  };

  /** A lead with the conversation and customer behind it, as the real flow produces. */
  const makeLead = async (businessId: string, over: Record<string, unknown> = {}) => {
    const customer = await prisma.db.customer.create({
      data: {
        businessId,
        phoneE164: `+6141${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
        name: 'Sarah',
      },
    });
    const conversation = await prisma.db.conversation.create({
      data: { businessId, customerId: customer.id, state: 'COMPLETE' },
    });
    return prisma.db.lead.create({
      data: {
        businessId,
        customerId: customer.id,
        conversationId: conversation.id,
        serviceType: 'End of lease clean',
        suburb: 'Southbank',
        ...over,
      },
    });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AuthModule, LeadsModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    prisma = app.get(PrismaService);
    auth = app.get(AuthService);

    for (const label of ['A', 'B'] as const) {
      const business = await prisma.unscoped.business.create({ data: { name: `Leads ${label} ${stamp}` } });
      const user = await prisma.unscoped.user.create({
        data: { businessId: business.id, email: `leads-${label}-${stamp}@example.com` },
      });
      const cookie = await sessionFor(user.id);
      if (label === 'A') { businessA = business.id; cookieA = cookie; }
      else { businessB = business.id; cookieB = cookie; }
    }

    leadA = (await makeLead(businessA)).id;
  });

  afterAll(async () => {
    for (const id of [businessA, businessB]) {
      if (id) await prisma.unscoped.business.delete({ where: { id } }).catch(() => undefined);
    }
    await app?.close();
  });

  const as = (cookie: string) => `${SESSION_COOKIE}=${encodeURIComponent(cookie)}`;
  const api = () => request(app.getHttpServer());

  it('requires a session', async () => {
    await api().get('/leads').expect(401);
    await api().get(`/leads/${leadA}`).expect(401);
  });

  it('lists this business leads with the customer attached', async () => {
    const response = await api().get('/leads').set('Cookie', as(cookieA)).expect(200);
    expect(response.body.leads.length).toBeGreaterThan(0);
    // A lead without a callback number is not a lead.
    expect(response.body.leads[0].customer.phoneE164).toMatch(/^\+61/);
  });

  it('opens one lead with its transcript', async () => {
    // The owner's first question about any lead is "what did they actually say".
    await prisma.db.message.create({
      data: {
        businessId: businessA,
        customerId: (await prisma.db.lead.findFirstOrThrow({ where: { id: leadA, businessId: businessA } })).customerId,
        direction: 'INBOUND', status: 'RECEIVED',
        fromE164: '+61412000111', toE164: '+61480000111',
        body: 'need an end of lease clean in Southbank',
      },
    });

    const response = await api().get(`/leads/${leadA}`).set('Cookie', as(cookieA)).expect(200);
    expect(response.body.id).toBe(leadA);
    expect(response.body.conversation).toBeTruthy();
    expect(response.body.messages.some((m: { body: string }) => m.body.includes('Southbank'))).toBe(true);
  });

  describe('tenancy — the leak that matters most', () => {
    it('never lists another business leads', async () => {
      const theirs = await api().get('/leads').set('Cookie', as(cookieB)).expect(200);
      expect(theirs.body.leads.map((l: { id: string }) => l.id)).not.toContain(leadA);
    });

    it('returns 404 — not 403 — for another business lead', async () => {
      // A 403 confirms the id exists, which lets one business enumerate another's leads.
      await api().get(`/leads/${leadA}`).set('Cookie', as(cookieB)).expect(404);
    });

    it('cannot mark another business lead as won', async () => {
      await api().patch(`/leads/${leadA}`).set('Cookie', as(cookieB))
        .send({ status: 'WON', wonValueCents: 50000 }).expect(404);

      // businessId is required by the tenant guard, not decoration — it rejected this line first.
      const untouched = await prisma.db.lead.findFirstOrThrow({ where: { id: leadA, businessId: businessA } });
      expect(untouched.status).not.toBe('WON');
      expect(untouched.wonValueCents).toBeNull();
    });
  });

  describe('recording an outcome', () => {
    it('marks a lead won with a value and closes it', async () => {
      const lead = await makeLead(businessA);
      const response = await api().patch(`/leads/${lead.id}`).set('Cookie', as(cookieA))
        .send({ status: 'WON', wonValueCents: 48000 }).expect(200);

      expect(response.body.status).toBe('WON');
      // The number the entire renewal conversation rests on.
      expect(response.body.wonValueCents).toBe(48000);
      expect(response.body.closedAt).not.toBeNull();
    });

    it('marks a lead lost with a reason', async () => {
      const lead = await makeLead(businessA);
      const response = await api().patch(`/leads/${lead.id}`).set('Cookie', as(cookieA))
        .send({ status: 'LOST', lostReason: 'went with someone cheaper' }).expect(200);

      expect(response.body.status).toBe('LOST');
      expect(response.body.lostReason).toContain('cheaper');
      expect(response.body.closedAt).not.toBeNull();
    });

    it('ignores a value attached to a lost lead', async () => {
      const lead = await makeLead(businessA);
      const response = await api().patch(`/leads/${lead.id}`).set('Cookie', as(cookieA))
        .send({ status: 'LOST', wonValueCents: 99900 }).expect(200);

      // Storing it would corrupt the one metric that matters.
      expect(response.body.wonValueCents).toBeNull();
    });

    it('refuses a status the conversation engine owns', async () => {
      const lead = await makeLead(businessA);
      // Letting a client set NEW or QUALIFYING would let the dashboard rewind a lead
      // into a state the state machine then disagrees with.
      await api().patch(`/leads/${lead.id}`).set('Cookie', as(cookieA))
        .send({ status: 'NEW' }).expect(400);
      await api().patch(`/leads/${lead.id}`).set('Cookie', as(cookieA))
        .send({ status: 'QUALIFYING' }).expect(400);
    });

    it('answers a PATCH with the same shape as a GET', async () => {
      // The dashboard renders the PATCH response directly. A bare row here — no
      // customer, no transcript — crashed the lead screen on `customer.name`.
      const lead = await makeLead(businessA);
      const response = await api().patch(`/leads/${lead.id}`).set('Cookie', as(cookieA))
        .send({ status: 'WON', wonValueCents: 1000 }).expect(200);

      expect(response.body.customer?.phoneE164).toBeTruthy();
      expect(Array.isArray(response.body.messages)).toBe(true);
      expect(response.body.conversation).toBeTruthy();
    });

    it('lets the owner clear the needs-human flag', async () => {
      const lead = await makeLead(businessA, { needsHuman: true });
      const response = await api().patch(`/leads/${lead.id}`).set('Cookie', as(cookieA))
        .send({ needsHuman: false }).expect(200);
      expect(response.body.needsHuman).toBe(false);
    });

    it('rejects a negative won value', async () => {
      const lead = await makeLead(businessA);
      await api().patch(`/leads/${lead.id}`).set('Cookie', as(cookieA))
        .send({ status: 'WON', wonValueCents: -1 }).expect(400);
    });
  });

  describe('the hub summary', () => {
    it('counts what needs the owner, and is not shadowed by the :id route', async () => {
      // If `@Get(':id')` were declared first, this would resolve as a lead with the id
      // "summary" and 404 — a routing bug that reads like missing data.
      const response = await api().get('/leads/summary').set('Cookie', as(cookieA)).expect(200);

      expect(typeof response.body.needsAttention).toBe('number');
      expect(typeof response.body.openLeads).toBe('number');
      expect(typeof response.body.newToday).toBe('number');
      expect(response.body.wonThisWeek).toHaveProperty('count');
    });

    it('counts only this business', async () => {
      await makeLead(businessA, { needsHuman: true });
      const mine = await api().get('/leads/summary').set('Cookie', as(cookieA)).expect(200);
      const theirs = await api().get('/leads/summary').set('Cookie', as(cookieB)).expect(200);

      expect(mine.body.needsAttention).toBeGreaterThan(0);
      expect(theirs.body.needsAttention).toBe(0);
    });

    it('reports a null value when won leads carry no amount', async () => {
      const lead = await makeLead(businessB);
      await api().patch(`/leads/${lead.id}`).set('Cookie', as(cookieB)).send({ status: 'WON' }).expect(200);

      const summary = await api().get('/leads/summary').set('Cookie', as(cookieB)).expect(200);
      expect(summary.body.wonThisWeek.count).toBe(1);
      // Null, not zero: "a job with no recorded value" is not "a job worth nothing".
      expect(summary.body.wonThisWeek.valueCents).toBeNull();
    });

    it('requires a session', async () => {
      await api().get('/leads/summary').expect(401);
    });
  });

  describe('filtering and pagination', () => {
    it('filters by status', async () => {
      const won = await makeLead(businessA, { status: 'WON' });
      const response = await api().get('/leads?status=WON').set('Cookie', as(cookieA)).expect(200);
      expect(response.body.leads.every((l: { status: string }) => l.status === 'WON')).toBe(true);
      expect(response.body.leads.map((l: { id: string }) => l.id)).toContain(won.id);
    });

    it('treats needsHuman=false as false, not as a truthy string', async () => {
      await makeLead(businessA, { needsHuman: true });
      const response = await api().get('/leads?needsHuman=false').set('Cookie', as(cookieA)).expect(200);
      // Without the transform this is the non-empty string "false", which is truthy —
      // the same trap the env parser avoids.
      expect(response.body.leads.every((l: { needsHuman: boolean }) => l.needsHuman === false)).toBe(true);
    });

    it('pages with a cursor and does not repeat a row', async () => {
      for (let i = 0; i < 4; i++) await makeLead(businessA);

      const first = await api().get('/leads?limit=2').set('Cookie', as(cookieA)).expect(200);
      expect(first.body.leads).toHaveLength(2);
      expect(first.body.nextCursor).toBeTruthy();

      const second = await api().get(`/leads?limit=2&cursor=${first.body.nextCursor}`)
        .set('Cookie', as(cookieA)).expect(200);

      const firstIds = first.body.leads.map((l: { id: string }) => l.id);
      const secondIds = second.body.leads.map((l: { id: string }) => l.id);
      expect(secondIds.some((id: string) => firstIds.includes(id))).toBe(false);
    });

    it('caps the page size a client can ask for', async () => {
      await api().get('/leads?limit=5000').set('Cookie', as(cookieA)).expect(400);
    });

    it('returns newest first', async () => {
      const response = await api().get('/leads').set('Cookie', as(cookieA)).expect(200);
      const dates = response.body.leads.map((l: { createdAt: string }) => new Date(l.createdAt).getTime());
      expect([...dates].sort((a: number, b: number) => b - a)).toEqual(dates);
    });
  });
});
