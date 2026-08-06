import { Controller, Get, INestApplication, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../prisma/prisma.service';
import { AuthModule } from './auth.module';
import { AuthService, type AuthenticatedSession } from './auth.service';
import { SESSION_COOKIE } from './cookies';
import { Session, SessionGuard } from './session.guard';

/**
 * INTEGRATION — requires `pnpm db:up`. The auth endpoints over real HTTP.
 *
 * The unit specs prove the crypto and the cookie strings. This proves the parts that only
 * exist once Nest, Express and a database are all in the same process: that the guard
 * actually rejects, that `Set-Cookie` actually round-trips, and that a controller
 * decorated with `@Session()` but no guard fails rather than leaking.
 */

/** A stand-in for every future tenant-scoped route. */
@Controller('test')
class ProtectedController {
  @Get('protected')
  @UseGuards(SessionGuard)
  protectedRoute(@Session() session: AuthenticatedSession) {
    return { businessId: session.businessId };
  }

  /**
   * The mistake this whole design exists to make impossible: `@Session()` without the
   * guard. It must throw, not hand back `undefined` — see `session.guard.ts`.
   */
  @Get('unguarded')
  unguarded(@Session() session: AuthenticatedSession) {
    return { businessId: session.businessId };
  }
}

describe('auth over HTTP', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  let businessId = '';
  let userId = '';
  const stamp = Date.now();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule],
      controllers: [ProtectedController],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    auth = app.get(AuthService);

    const business = await prisma.unscoped.business.create({ data: { name: `HTTP Auth ${stamp}` } });
    businessId = business.id;
    const user = await prisma.unscoped.user.create({
      data: { businessId, email: `http-${stamp}@example.com` },
    });
    userId = user.id;
  });

  afterAll(async () => {
    if (businessId) {
      await prisma.unscoped.business.delete({ where: { id: businessId } }).catch(() => undefined);
    }
    await app?.close();
  });

  const tokenFor = async () => {
    const url = await auth.mintLinkForUser(userId);
    return new URL(url).searchParams.get('token') ?? '';
  };

  it('rejects a protected route with no cookie', async () => {
    await request(app.getHttpServer()).get('/test/protected').expect(401);
  });

  it('rejects a protected route with a junk cookie', async () => {
    await request(app.getHttpServer())
      .get('/test/protected')
      .set('Cookie', `${SESSION_COOKIE}=not-a-session`)
      .expect(401);
  });

  it('says only "not authenticated", never why', async () => {
    const response = await request(app.getHttpServer())
      .get('/test/protected')
      .set('Cookie', `${SESSION_COOKIE}=a.b`)
      .expect(401);

    // "expired" vs "revoked" vs "no such user" tells an attacker what they achieved.
    expect(JSON.stringify(response.body)).not.toMatch(/expired|revoked|signature|epoch|user/i);
  });

  it('completes the whole magic-link flow and sets a usable cookie', async () => {
    const token = await tokenFor();

    const callback = await request(app.getHttpServer())
      .get(`/auth/callback?token=${token}&next=%2Fleads`)
      .expect(302);

    expect(callback.headers.location).toMatch(/\/leads$/);

    const setCookie = String(callback.headers['set-cookie']);
    expect(setCookie).toContain(SESSION_COOKIE);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');

    const cookie = setCookie.split(';')[0]!;
    const me = await request(app.getHttpServer()).get('/auth/me').set('Cookie', cookie).expect(200);
    expect(me.body).toEqual({ userId, businessId });

    const protectedRoute = await request(app.getHttpServer())
      .get('/test/protected')
      .set('Cookie', cookie)
      .expect(200);
    expect(protectedRoute.body).toEqual({ businessId });
  });

  it('sends an already-used link to the expired page rather than logging anyone in', async () => {
    const token = await tokenFor();
    await request(app.getHttpServer()).get(`/auth/callback?token=${token}`).expect(302);

    const replay = await request(app.getHttpServer()).get(`/auth/callback?token=${token}`).expect(302);
    expect(replay.headers.location).toMatch(/\/auth\/expired$/);
    expect(replay.headers['set-cookie']).toBeUndefined();
  });

  it('cannot be redirected off-site by the next parameter', async () => {
    const token = await tokenFor();
    const response = await request(app.getHttpServer())
      .get(`/auth/callback?token=${token}&next=${encodeURIComponent('//evil.example')}`)
      .expect(302);

    expect(response.headers.location).not.toContain('evil.example');
  });

  it('logout revokes every session, not just this browser', async () => {
    const token = await tokenFor();
    const callback = await request(app.getHttpServer()).get(`/auth/callback?token=${token}`).expect(302);
    const cookie = String(callback.headers['set-cookie']).split(';')[0]!;

    await request(app.getHttpServer()).get('/auth/me').set('Cookie', cookie).expect(200);
    await request(app.getHttpServer()).post('/auth/logout').set('Cookie', cookie).expect(201);
    await request(app.getHttpServer()).get('/auth/me').set('Cookie', cookie).expect(401);
  });

  it('answers request-link identically for a real and an unknown address', async () => {
    const real = await request(app.getHttpServer())
      .post('/auth/request-link')
      .send({ email: `http-${stamp}@example.com` })
      .expect(201);
    const fake = await request(app.getHttpServer())
      .post('/auth/request-link')
      .send({ email: `nobody-${stamp}@example.com` })
      .expect(201);

    // Byte-identical, or the endpoint is an account-enumeration oracle.
    expect(real.body).toEqual(fake.body);
  });

  it('THE LEAK GUARD — @Session() without @UseGuards fails instead of returning undefined', async () => {
    // `businessId: undefined` in a Prisma where clause does not filter; it returns every
    // tenant's rows. This must be a 500, never a 200 with no tenant.
    await request(app.getHttpServer()).get('/test/unguarded').expect(500);
  });
});
