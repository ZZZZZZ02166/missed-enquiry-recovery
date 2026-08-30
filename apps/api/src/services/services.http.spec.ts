import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { MAX_ACTIVE_SERVICES } from 'shared-types';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { SESSION_COOKIE } from '../auth/cookies';
import { PrismaService } from '../prisma/prisma.service';
import { ServicesModule } from './services.module';

/**
 * INTEGRATION — requires `pnpm db:up`. The catalogue over real HTTP.
 *
 * Two things this proves that a unit test cannot: that one business cannot touch
 * another's catalogue, and that the shared validation rules actually reach the wire as a
 * 422 the dashboard can bind to.
 */
describe('services over HTTP', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;

  const stamp = Date.now();
  let businessA = '';
  let businessB = '';
  let cookieA = '';
  let cookieB = '';

  const sessionFor = async (userId: string) => {
    const url = await auth.mintLinkForUser(userId);
    const token = new URL(url).searchParams.get('token')!;
    return (await auth.consumeMagicLink(token))!;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, ServicesModule],
    }).compile();

    app = moduleRef.createNestApplication();
    // Match main.ts, or the DTOs are decoration and unknown fields sail through.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    prisma = app.get(PrismaService);
    auth = app.get(AuthService);

    for (const label of ['A', 'B'] as const) {
      const business = await prisma.unscoped.business.create({ data: { name: `Svc ${label} ${stamp}` } });
      const user = await prisma.unscoped.user.create({
        data: { businessId: business.id, email: `svc-${label}-${stamp}@example.com` },
      });
      const cookie = await sessionFor(user.id);
      if (label === 'A') { businessA = business.id; cookieA = cookie; }
      else { businessB = business.id; cookieB = cookie; }
    }
  });

  // Each test starts with an empty catalogue for both tenants. Without this the shared
  // businesses accumulate services across tests and legitimately trip the six-active
  // ceiling — which is the rule working, and a test failure that says nothing.
  afterEach(async () => {
    for (const id of [businessA, businessB]) {
      if (id) await prisma.db.service.deleteMany({ where: { businessId: id } });
    }
  });

  afterAll(async () => {
    for (const id of [businessA, businessB]) {
      if (id) await prisma.unscoped.business.delete({ where: { id } }).catch(() => undefined);
    }
    await app?.close();
  });

  const as = (cookie: string) => `${SESSION_COOKIE}=${encodeURIComponent(cookie)}`;
  const api = () => request(app.getHttpServer());
  const service = (over: Record<string, unknown> = {}) => ({
    name: `Deep cleaning ${Math.random().toString(36).slice(2, 8)}`,
    pricingType: 'MANUAL_QUOTE',
    ...over,
  });

  it('requires a session', async () => {
    await api().get('/services').expect(401);
    await api().post('/services').send(service()).expect(401);
  });

  it('creates, lists and reads back', async () => {
    const created = await api().post('/services').set('Cookie', as(cookieA))
      .send(service({ name: `Oven cleaning ${stamp}`, pricingType: 'FIXED', priceCents: 7000 }))
      .expect(201);

    expect(created.body.priceCents).toBe(7000);
    expect(created.body.businessId).toBe(businessA);

    const list = await api().get('/services').set('Cookie', as(cookieA)).expect(200);
    expect(list.body.map((s: { id: string }) => s.id)).toContain(created.body.id);
  });

  it('appends new services rather than colliding at position 0', async () => {
    const one = await api().post('/services').set('Cookie', as(cookieA)).send(service()).expect(201);
    const two = await api().post('/services').set('Cookie', as(cookieA)).send(service()).expect(201);
    // Prisma defaults sortOrder to 0; without max+1 the second create would trip
    // SORT_ORDER_DUPLICATE on a rule the owner never broke.
    expect(two.body.sortOrder).toBeGreaterThan(one.body.sortOrder);
  });

  describe('the shared rules reach the wire', () => {
    it('rejects a duplicate name differing only by case, as 422 with issues', async () => {
      const name = `Bond clean ${stamp}`;
      await api().post('/services').set('Cookie', as(cookieA)).send(service({ name })).expect(201);

      const clash = await api().post('/services').set('Cookie', as(cookieA))
        .send(service({ name: name.toUpperCase() })).expect(422);

      expect(clash.body.issues[0].code).toBe('NAME_DUPLICATE');
      expect(clash.body.issues[0].message).toContain(name);
    });

    it('rejects a price typed into a name', async () => {
      const response = await api().post('/services').set('Cookie', as(cookieA))
        .send(service({ name: `Deep clean $99 ${stamp}` })).expect(422);

      expect(response.body.issues.map((i: { code: string }) => i.code)).toContain('NAME_HAS_CURRENCY');
      // The message has to say what to do instead, or the owner just fights it.
      expect(JSON.stringify(response.body)).toMatch(/pricing/i);
    });

    it('rejects a FIXED service with no price', async () => {
      const response = await api().post('/services').set('Cookie', as(cookieA))
        .send({ name: `Unpriced ${stamp}`, pricingType: 'FIXED' }).expect(422);

      expect(response.body.issues.map((i: { code: string }) => i.code)).toContain('PRICE_REQUIRED');
    });

    it('rejects PER_UNIT with no unit label', async () => {
      const response = await api().post('/services').set('Cookie', as(cookieA))
        .send({ name: `Per thing ${stamp}`, pricingType: 'PER_UNIT', priceCents: 4000 }).expect(422);

      expect(response.body.issues.map((i: { code: string }) => i.code)).toContain('UNIT_LABEL_REQUIRED');
    });

    it('returns every issue at once, not the first', async () => {
      const response = await api().post('/services').set('Cookie', as(cookieA))
        .send({ name: '$$', pricingType: 'FIXED' }).expect(422);

      // A form that reveals one problem per save is how a three-field mistake takes
      // three round trips.
      expect(response.body.issues.length).toBeGreaterThan(1);
    });

    it('refuses to activate more than the ceiling, and says how many to turn off', async () => {
      const fresh = await prisma.unscoped.business.create({ data: { name: `Ceiling ${stamp}` } });
      const user = await prisma.unscoped.user.create({
        data: { businessId: fresh.id, email: `ceiling-${stamp}@example.com` },
      });
      const cookie = as(await sessionFor(user.id));

      for (let i = 0; i < MAX_ACTIVE_SERVICES; i++) {
        await api().post('/services').set('Cookie', cookie)
          .send(service({ name: `Package ${i} ${stamp}` })).expect(201);
      }

      const surplus = await api().post('/services').set('Cookie', cookie)
        .send(service({ name: `Package extra ${stamp}` })).expect(422);

      expect(surplus.body.issues.map((i: { code: string }) => i.code)).toContain('TOO_MANY_ACTIVE');
      expect(JSON.stringify(surplus.body)).toContain(String(MAX_ACTIVE_SERVICES));
      // The surplus service is *not* silently created as disabled — nothing was written.
      const list = await api().get('/services').set('Cookie', cookie).expect(200);
      expect(list.body).toHaveLength(MAX_ACTIVE_SERVICES);

      await prisma.unscoped.business.delete({ where: { id: fresh.id } }).catch(() => undefined);
    });
  });

  describe('tenancy', () => {
    it('does not list another business services', async () => {
      const mine = await api().post('/services').set('Cookie', as(cookieA)).send(service()).expect(201);
      const theirs = await api().get('/services').set('Cookie', as(cookieB)).expect(200);
      expect(theirs.body.map((s: { id: string }) => s.id)).not.toContain(mine.body.id);
    });

    it('returns 404 — not 403 — for another business service', async () => {
      const mine = await api().post('/services').set('Cookie', as(cookieA)).send(service()).expect(201);
      // 403 would confirm the id exists, which is an enumeration oracle across tenants.
      await api().get(`/services/${mine.body.id}`).set('Cookie', as(cookieB)).expect(404);
    });

    it('cannot rename or delete another business service', async () => {
      const mine = await api().post('/services').set('Cookie', as(cookieA)).send(service()).expect(201);
      await api().patch(`/services/${mine.body.id}`).set('Cookie', as(cookieB))
        .send({ name: `Hijacked ${stamp}` }).expect(404);
      await api().delete(`/services/${mine.body.id}`).set('Cookie', as(cookieB)).expect(404);

      const still = await api().get(`/services/${mine.body.id}`).set('Cookie', as(cookieA)).expect(200);
      expect(still.body.name).toBe(mine.body.name);
    });

    it('cannot reorder using another business ids', async () => {
      const mine = await api().post('/services').set('Cookie', as(cookieA)).send(service()).expect(201);
      await api().put('/services/order').set('Cookie', as(cookieB))
        .send({ orderedIds: [mine.body.id] }).expect(404);
    });
  });

  it('reorders the whole list and rejects a partial one', async () => {
    const fresh = await prisma.unscoped.business.create({ data: { name: `Order ${stamp}` } });
    const user = await prisma.unscoped.user.create({
      data: { businessId: fresh.id, email: `order-${stamp}@example.com` },
    });
    const cookie = as(await sessionFor(user.id));

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const s = await api().post('/services').set('Cookie', cookie)
        .send(service({ name: `Order ${i} ${stamp}` })).expect(201);
      ids.push(s.body.id);
    }

    const reversed = [...ids].reverse();
    const after = await api().put('/services/order').set('Cookie', cookie)
      .send({ orderedIds: reversed }).expect(200);
    expect(after.body.map((s: { id: string }) => s.id)).toEqual(reversed);

    // A partial list would leave the omitted service at a position that now collides.
    await api().put('/services/order').set('Cookie', cookie)
      .send({ orderedIds: ids.slice(0, 2) }).expect(422);

    await prisma.unscoped.business.delete({ where: { id: fresh.id } }).catch(() => undefined);
  });

  it('disables rather than deletes a service a lead references', async () => {
    const created = await api().post('/services').set('Cookie', as(cookieA)).send(service()).expect(201);

    const customer = await prisma.db.customer.create({
      data: { businessId: businessA, phoneE164: `+61400${String(Date.now()).slice(-6)}` },
    });
    const conversation = await prisma.db.conversation.create({
      data: { businessId: businessA, customerId: customer.id, state: 'COLLECTING' },
    });
    await prisma.db.lead.create({
      data: {
        businessId: businessA, customerId: customer.id,
        conversationId: conversation.id, serviceId: created.body.id,
      },
    });

    const removed = await api().delete(`/services/${created.body.id}`).set('Cookie', as(cookieA)).expect(200);
    expect(removed.body.deleted).toBe(false);
    expect(removed.body.service.availability).toBe('DISABLED');

    // Still readable, because the lead needs to say what it was about.
    await api().get(`/services/${created.body.id}`).set('Cookie', as(cookieA)).expect(200);
  });

  it('hard-deletes a service nothing references', async () => {
    const created = await api().post('/services').set('Cookie', as(cookieA)).send(service()).expect(201);
    const removed = await api().delete(`/services/${created.body.id}`).set('Cookie', as(cookieA)).expect(200);
    expect(removed.body.deleted).toBe(true);
    await api().get(`/services/${created.body.id}`).set('Cookie', as(cookieA)).expect(404);
  });

  it('seeds defaults once, and never over an existing catalogue', async () => {
    const fresh = await prisma.unscoped.business.create({ data: { name: `Seed ${stamp}` } });
    const user = await prisma.unscoped.user.create({
      data: { businessId: fresh.id, email: `seed-${stamp}@example.com` },
    });
    const cookie = as(await sessionFor(user.id));

    const seeded = await api().post('/services/seed-defaults').set('Cookie', cookie).expect(201);
    expect(seeded.body.length).toBeGreaterThanOrEqual(2);
    // A default price would be a number this system invented on a business's behalf.
    expect(seeded.body.every((s: { pricingType: string }) => s.pricingType === 'MANUAL_QUOTE')).toBe(true);

    await api().delete(`/services/${seeded.body[0].id}`).set('Cookie', cookie).expect(200);
    const again = await api().post('/services/seed-defaults').set('Cookie', cookie).expect(201);
    // Re-seeding must not resurrect what the owner deliberately removed.
    expect(again.body).toHaveLength(seeded.body.length - 1);

    await prisma.unscoped.business.delete({ where: { id: fresh.id } }).catch(() => undefined);
  });

  it('strips unknown fields rather than trusting them', async () => {
    // whitelist + forbidNonWhitelisted: a client cannot smuggle businessId in a body.
    await api().post('/services').set('Cookie', as(cookieA))
      .send({ ...service(), businessId: businessB }).expect(400);
  });
});
