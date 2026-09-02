import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { MAX_ACTIVE_SERVICES, readKnowledge } from 'shared-types';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { SESSION_COOKIE } from '../auth/cookies';
import { FakeLlmProvider, LLM_PROVIDER, MAX_IMPORT_CHARS } from '../conversations/llm.provider';
import type { CatalogueExtractionRequest, LlmCatalogueResult } from '../conversations/llm.provider';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ImportModule } from './import.module';
import { ImportService } from './import.service';

/**
 * INTEGRATION — requires `pnpm db:up`. Document import over real HTTP.
 *
 * The cases here are the ones the design was built against, not a tour of the happy path.
 * Three of them would each have been a genuine incident:
 *
 *  - an imported price reaching a caller without the owner ever ticking the box;
 *  - a batch that half-applies, leaving the owner with an unknown subset of their
 *    catalogue created and an error explaining nothing;
 *  - a currency figure entering through a knowledge answer, bypassing `PriceCalculator`,
 *    the GST rule and the CI guard in one move.
 */

/** A model response in the raw shape the real provider returns. */
const modelResponse = {
  services: [
    {
      name: 'End of lease clean',
      description: 'Full vacate clean including oven and windows',
      pricingType: 'STARTING_FROM',
      priceCents: 28000,
      sourceExcerpt: 'End of lease cleaning starts at 280 dollars',
    },
    {
      name: 'Carpet steam clean',
      pricingType: 'PER_UNIT',
      priceCents: 4000,
      unitLabel: 'room',
      sourceExcerpt: 'Carpet steam cleaning 40 dollars per room',
    },
  ],
  knowledge: [
    {
      question: 'Do you bring your own supplies?',
      aliases: ['do you bring products', 'do i need to provide anything'],
      answer: 'Yes, we bring everything including vacuum, mop and all products.',
      sourceExcerpt: 'Our team arrives fully equipped.',
    },
  ],
};

/**
 * A minimal but genuinely valid PDF, offsets and all.
 *
 * Built rather than committed as a fixture so the empty-page case is the *same* document
 * minus its text — which is what makes the scanned-PDF assertion mean something. A binary
 * fixture would leave "is this failing because it is a scan, or because it is a different
 * file" unanswerable.
 */
function buildPdf(lines: string[]): Buffer {
  const escape = (line: string): string => line.replace(/([()\\])/g, '\\$1');
  const content =
    lines.length === 0
      ? ''
      : ['BT', '/F1 12 Tf', '72 720 Td', '14 TL', ...lines.map((l) => `(${escape(l)}) Tj T*`), 'ET'].join('\n');

  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${Buffer.byteLength(content, 'latin1')}>>\nstream\n${content}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefAt = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const PRICE_LIST_LINES = [
  'Melbourne Sparkle Cleaning - price list',
  'End of lease cleaning starts at 280 dollars',
  'Carpet steam cleaning 40 dollars per room',
  'Oven cleaning 70 dollars flat rate',
  'Our team arrives fully equipped with all products.',
  'We service the inner north and inner west suburbs.',
];

/** Lets one import be held open so a second can be observed hitting the lock. */
class GatedFake extends FakeLlmProvider {
  private release: (() => void) | null = null;

  private entered: (() => void) | null = null;

  /** Block the next import. Resolves once that import has actually started. */
  hold(): { started: Promise<void>; release: () => void } {
    const started = new Promise<void>((resolve) => { this.entered = resolve; });
    const gate = new Promise<void>((resolve) => { this.release = resolve; });
    this.gateOn = gate;
    return {
      started,
      release: () => { this.gateOn = null; this.release?.(); },
    };
  }

  private gateOn: Promise<void> | null = null;

  override async extractCatalogue(req: CatalogueExtractionRequest): Promise<LlmCatalogueResult> {
    if (this.gateOn) {
      this.entered?.();
      await this.gateOn;
    }
    return super.extractCatalogue(req);
  }
}

describe('document import over HTTP', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  let llm: GatedFake;
  let imports: ImportService;

  const stamp = Date.now();
  let businessA = '';
  let businessB = '';
  let cookieA = '';
  let cookieB = '';

  beforeAll(async () => {
    llm = new GatedFake();
    const moduleRef = await Test.createTestingModule({ imports: [AuthModule, ImportModule] })
      .overrideProvider(LLM_PROVIDER)
      .useValue(llm)
      .compile();

    app = moduleRef.createNestApplication();
    // Match main.ts, or the DTOs are decoration and unknown fields sail through.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    imports = app.get(ImportService);

    for (const label of ['A', 'B'] as const) {
      const business = await prisma.unscoped.business.create({ data: { name: `Imp ${label} ${stamp}` } });
      const user = await prisma.unscoped.user.create({
        data: { businessId: business.id, email: `imp-${label}-${stamp}@example.com` },
      });
      const url = await auth.mintLinkForUser(user.id);
      const cookie = (await auth.consumeMagicLink(new URL(url).searchParams.get('token')!))!;
      if (label === 'A') { businessA = business.id; cookieA = cookie; }
      else { businessB = business.id; cookieB = cookie; }
    }
  });

  afterEach(async () => {
    llm.reset();
    for (const id of [businessA, businessB]) {
      if (!id) continue;
      await prisma.db.service.deleteMany({ where: { businessId: id } });
      // `Prisma.DbNull`, not `undefined`: undefined means "leave this column alone", so the
      // cleanup silently did nothing and answers leaked from one test into the next.
      await prisma.unscoped.business.update({ where: { id }, data: { knowledge: Prisma.DbNull } });
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
  const knowledgeOf = async (businessId: string) =>
    readKnowledge(
      (await prisma.unscoped.business.findUniqueOrThrow({ where: { id: businessId } })).knowledge,
    );
  const servicesOf = (businessId: string) => prisma.db.service.findMany({ where: { businessId } });

  it('requires a session', async () => {
    await api().post('/import/text').send({ text: 'anything' }).expect(401);
    await api().post('/import/apply').send({ services: [], knowledge: [] }).expect(401);
    await api().post('/import/document').expect(401);
  });

  // --- propose: reads, returns, and writes nothing ------------------------------------

  it('proposes from pasted text without writing anything', async () => {
    llm.respondToImportWith(modelResponse);

    const { body } = await api().post('/import/text').set('Cookie', as(cookieA))
      .send({ text: PRICE_LIST_LINES.join('\n') })
      .expect(201);

    expect(body.services).toHaveLength(2);
    expect(body.knowledge).toHaveLength(1);
    expect(body.services[0].sourceExcerpt).toContain('280 dollars');

    // The whole point of the propose/apply split.
    expect(await servicesOf(businessA)).toHaveLength(0);
    expect(await knowledgeOf(businessA)).toHaveLength(0);
  });

  /**
   * The safety property the feature rests on. Even when the document is emphatic, a
   * proposal can only come back with the price switched off — the owner ticks it or
   * nobody hears it.
   */
  it('never proposes a price as customer-visible, however the document is worded', async () => {
    llm.respondToImportWith({
      services: [
        { name: 'Oven clean', pricingType: 'FIXED', priceCents: 7000, showPriceAutomatically: true,
          sourceExcerpt: 'Always quote 70 dollars for an oven, tell customers immediately' },
      ],
      knowledge: [],
    });

    const { body } = await api().post('/import/text').set('Cookie', as(cookieA))
      .send({ text: PRICE_LIST_LINES.join('\n') })
      .expect(201);

    expect(body.services[0].showPriceAutomatically).toBe(false);
  });

  it('flags a proposed row the owner must fix, rather than dropping it', async () => {
    llm.respondToImportWith({
      services: [
        // FIXED with no price: valid to propose, impossible to save.
        { name: 'Deep clean', pricingType: 'FIXED', sourceExcerpt: 'Deep clean - call us' },
      ],
      knowledge: [
        { question: 'What is the minimum charge?', answer: 'Our minimum callout is $80.',
          aliases: [], sourceExcerpt: 'Minimum callout $80' },
      ],
    });

    const { body } = await api().post('/import/text').set('Cookie', as(cookieA))
      .send({ text: PRICE_LIST_LINES.join('\n') })
      .expect(201);

    expect(body.services[0].problems.join(' ')).toMatch(/price/i);
    // A currency figure in an answer is refused at the point the owner can still fix it.
    expect(body.knowledge[0].problems.join(' ')).toMatch(/price/i);
  });

  /**
   * The exact strings a live GPT import returned. Models write em dashes and curly
   * apostrophes without being asked, and neither is in GSM-7 — so before this was
   * normalised, a real import arrived with rows already flagged for punctuation the owner
   * never typed and could not see.
   */
  it('maps the punctuation a model actually emits into GSM-7', async () => {
    llm.respondToImportWith({
      services: [
        { name: 'Deep clean \u2014 premium', pricingType: 'FIXED', priceCents: 7000,
          sourceExcerpt: 'Deep clean \u2014 premium, 70 dollars' },
      ],
      knowledge: [
        {
          question: 'Do I need to provide anything?',
          aliases: ['what\u2019s included'],
          answer: 'We bring all our own products and equipment\u2014you don\u2019t need to provide anything.',
          sourceExcerpt: 'We bring all our own products and equipment\u2014you don\u2019t need to provide anything.',
        },
      ],
    });

    const { body } = await api().post('/import/text').set('Cookie', as(cookieA))
      .send({ text: PRICE_LIST_LINES.join('\n') })
      .expect(201);

    expect(body.services[0].name).toBe('Deep clean - premium');
    expect(body.knowledge[0].answer)
      .toBe("We bring all our own products and equipment-you don't need to provide anything.");
    expect(body.knowledge[0].aliases).toEqual(["what's included"]);
    // Which is what makes the row importable rather than pre-broken.
    expect(body.knowledge[0].problems).toEqual([]);
    expect(body.services[0].problems).toEqual([]);

    // The excerpt is evidence and keeps the document's own characters.
    expect(body.knowledge[0].sourceExcerpt).toContain('\u2014');
  });

  it('refuses text over the limit rather than truncating it', async () => {
    const { body } = await api().post('/import/text').set('Cookie', as(cookieA))
      .send({ text: 'a'.repeat(MAX_IMPORT_CHARS + 1) })
      .expect(400);

    expect(body.message).toMatch(/paste in just the pages|characters/i);
    expect(llm.catalogueRequests).toHaveLength(0);
  });

  it('refuses empty text', async () => {
    await api().post('/import/text').set('Cookie', as(cookieA)).send({ text: '   ' }).expect(400);
    expect(llm.catalogueRequests).toHaveLength(0);
  });

  // --- PDF -----------------------------------------------------------------------------

  it('reads the text layer out of a PDF and sends it to the model', async () => {
    llm.respondToImportWith(modelResponse);

    const { body } = await api().post('/import/document').set('Cookie', as(cookieA))
      .attach('file', buildPdf(PRICE_LIST_LINES), { filename: 'prices.pdf', contentType: 'application/pdf' })
      .expect(201);

    expect(body.services).toHaveLength(2);
    expect(llm.catalogueRequests).toHaveLength(1);
    expect(llm.catalogueRequests[0]!.text).toContain('Carpet steam cleaning');
  });

  /**
   * The failure that would otherwise be invisible: `getText` succeeds, returns nothing,
   * and the owner is told we found no services in their document.
   */
  it('tells the owner a scanned PDF is a scan, and does not call the model', async () => {
    const { body } = await api().post('/import/document').set('Cookie', as(cookieA))
      .attach('file', buildPdf([]), { filename: 'scan.pdf', contentType: 'application/pdf' })
      .expect(400);

    expect(body.message).toMatch(/scan|photos/i);
    expect(body.message).toMatch(/past(e|ing)/i);
    expect(llm.catalogueRequests).toHaveLength(0);
  });

  it('rejects a file that is not a PDF with something actionable', async () => {
    const { body } = await api().post('/import/document').set('Cookie', as(cookieA))
      .attach('file', Buffer.from('this is a plain text file, not a PDF'), {
        filename: 'notes.txt', contentType: 'application/pdf',
      })
      .expect(400);

    expect(body.message).toMatch(/past(e|ing)/i);
    expect(llm.catalogueRequests).toHaveLength(0);
  });

  it('refuses a second import while one is still running', async () => {
    llm.respondToImportWith(modelResponse);
    const gate = llm.hold();

    const first = api().post('/import/text').set('Cookie', as(cookieA))
      .send({ text: PRICE_LIST_LINES.join('\n') });
    // Only meaningful once the first request is genuinely inside the handler.
    const firstDone = first.then((r) => r);
    await gate.started;

    await api().post('/import/text').set('Cookie', as(cookieA))
      .send({ text: PRICE_LIST_LINES.join('\n') })
      .expect(409);

    // A different business is unaffected — the lock is per tenant, not global.
    llm.respondToImportWith(modelResponse);
    gate.release();
    await expect(firstDone).resolves.toMatchObject({ status: 201 });
  });

  // --- apply: the writing half ---------------------------------------------------------

  it('creates approved services and stores approved answers', async () => {
    const { body } = await api().post('/import/apply').set('Cookie', as(cookieA))
      .send({
        services: [
          { name: 'End of lease clean', pricingType: 'STARTING_FROM', priceCents: 28000,
            showPriceAutomatically: true },
          { name: 'Carpet steam clean', pricingType: 'PER_UNIT', priceCents: 4000, unitLabel: 'room' },
        ],
        knowledge: [
          { question: 'Do you bring your own supplies?', aliases: ['do you bring products'],
            answer: 'Yes, we bring everything including vacuum, mop and all products.' },
        ],
      })
      .expect(201);

    expect(body).toEqual({ servicesCreated: 2, knowledgeSaved: 1 });

    const saved = await servicesOf(businessA);
    expect(saved).toHaveLength(2);
    // Ticked on the review screen: on. Not ticked: off. Never on by default.
    expect(saved.find((s) => s.name === 'End of lease clean')!.showPriceAutomatically).toBe(true);
    expect(saved.find((s) => s.name === 'Carpet steam clean')!.showPriceAutomatically).toBe(false);

    const knowledge = await knowledgeOf(businessA);
    expect(knowledge).toHaveLength(1);
    expect(knowledge[0]!.aliases).toEqual(['do you bring products']);
    expect(knowledge[0]!.id).toBeTruthy();
  });

  /**
   * `showPriceAutomatically` is the one field where a client mistake puts an unreviewed
   * figure in front of a caller, so it is re-derived rather than trusted. Exercised
   * against the service directly — the DTO rejects a non-boolean at the wire, which is a
   * second layer, not this one.
   */
  it('treats anything other than exactly true as "do not show the price"', async () => {
    await imports.apply(businessA, {
      services: [
        { name: 'Oven clean', pricingType: 'FIXED', priceCents: 7000,
          showPriceAutomatically: 'yes' as never },
      ],
      knowledge: [],
    });

    expect((await servicesOf(businessA))[0]!.showPriceAutomatically).toBe(false);
  });

  /**
   * The partial-application bug the batch pre-check exists to prevent. Seven active
   * services against a ceiling of six: the seventh is refused, and — the part that
   * matters — the first six were never written.
   */
  it('refuses an over-sized batch without creating any of it', async () => {
    const services = Array.from({ length: MAX_ACTIVE_SERVICES + 1 }, (_, i) => ({
      name: `Service ${i + 1}`,
      pricingType: 'MANUAL_QUOTE' as const,
    }));

    const { body } = await api().post('/import/apply').set('Cookie', as(cookieA))
      .send({ services, knowledge: [] })
      .expect(422);

    expect(body.error).toBe('Catalogue is invalid');
    expect(body.issues.some((i: { code: string }) => i.code === 'TOO_MANY_ACTIVE')).toBe(true);
    expect(await servicesOf(businessA)).toHaveLength(0);
  });

  it('refuses a duplicate service name without creating the rest', async () => {
    const { body } = await api().post('/import/apply').set('Cookie', as(cookieA))
      .send({
        services: [
          { name: 'Oven clean', pricingType: 'FIXED', priceCents: 7000 },
          { name: 'Oven clean', pricingType: 'FIXED', priceCents: 9000 },
        ],
        knowledge: [],
      })
      .expect(422);

    expect(body.issues.some((i: { code: string }) => i.code === 'NAME_DUPLICATE')).toBe(true);
    expect(await servicesOf(businessA)).toHaveLength(0);
  });

  /**
   * A price entering through an answer would bypass `PriceCalculator`, the GST rule and
   * the CI currency guard in one move. It is refused **before** any service is created,
   * so a rejected answer cannot leave a half-written catalogue behind.
   */
  it('refuses a currency figure in an answer, and writes no services either', async () => {
    const { body } = await api().post('/import/apply').set('Cookie', as(cookieA))
      .send({
        services: [{ name: 'Oven clean', pricingType: 'FIXED', priceCents: 7000 }],
        knowledge: [{ question: 'What is the minimum charge?', answer: 'Our minimum callout is $80.' }],
      })
      .expect(422);

    expect(body.error).toBe('Answers are invalid');
    expect(body.issues.some((i: { code: string }) => i.code === 'ANSWER_HAS_CURRENCY')).toBe(true);
    expect(await servicesOf(businessA)).toHaveLength(0);
    expect(await knowledgeOf(businessA)).toHaveLength(0);
  });

  it('appends answers across imports instead of replacing them', async () => {
    const first = { question: 'Do you bring supplies?', answer: 'Yes, we bring everything.' };
    const second = { question: 'Do you do weekends?', answer: 'Yes, Saturday and Sunday by arrangement.' };

    await api().post('/import/apply').set('Cookie', as(cookieA))
      .send({ services: [], knowledge: [first] }).expect(201);
    await api().post('/import/apply').set('Cookie', as(cookieA))
      .send({ services: [], knowledge: [second] }).expect(201);

    const knowledge = await knowledgeOf(businessA);
    expect(knowledge.map((k) => k.question)).toEqual([first.question, second.question]);
  });

  it('skips an answer whose question is already stored, rather than duplicating it', async () => {
    const entry = { question: 'Do you bring supplies?', answer: 'Yes, we bring everything.' };

    await api().post('/import/apply').set('Cookie', as(cookieA))
      .send({ services: [], knowledge: [entry] }).expect(201);
    await api().post('/import/apply').set('Cookie', as(cookieA))
      .send({ services: [], knowledge: [{ ...entry, question: '  do you BRING supplies?  ' }] })
      .expect(201);

    // A duplicate would make the matcher see a tie and answer neither.
    expect(await knowledgeOf(businessA)).toHaveLength(1);
  });

  // --- the answers screen's API ---------------------------------------------------------

  it('reads back nothing when the business has no answers', async () => {
    const { body } = await api().get('/knowledge').set('Cookie', as(cookieA)).expect(200);
    expect(body).toEqual([]);
  });

  it('replaces the whole set and mints ids for new rows', async () => {
    const { body } = await api().put('/knowledge').set('Cookie', as(cookieA))
      .send({
        knowledge: [
          { question: 'Do you bring supplies?', answer: 'Yes, we bring everything.' },
          { question: 'Are you insured?', aliases: ['do you have insurance'], answer: 'Yes, fully insured.' },
        ],
      })
      .expect(200);

    expect(body).toHaveLength(2);
    expect(body[0].id).toBeTruthy();
    expect(body[1].aliases).toEqual(['do you have insurance']);
    expect(await knowledgeOf(businessA)).toHaveLength(2);
  });

  it('keeps an id across an edit, so the entry is the same entry', async () => {
    const first = await api().put('/knowledge').set('Cookie', as(cookieA))
      .send({ knowledge: [{ question: 'Do you bring supplies?', answer: 'Yes, we bring everything.' }] })
      .expect(200);
    const id = first.body[0].id;

    const second = await api().put('/knowledge').set('Cookie', as(cookieA))
      .send({ knowledge: [{ id, question: 'Do you bring supplies?', answer: 'Yes, including a vacuum.' }] })
      .expect(200);

    expect(second.body[0].id).toBe(id);
    expect(second.body[0].answer).toBe('Yes, including a vacuum.');
  });

  it('deletes by omission — the list sent is the list stored', async () => {
    await api().put('/knowledge').set('Cookie', as(cookieA))
      .send({
        knowledge: [
          { question: 'Do you bring supplies?', answer: 'Yes, we bring everything.' },
          { question: 'Are you insured?', answer: 'Yes, fully insured.' },
        ],
      }).expect(200);

    await api().put('/knowledge').set('Cookie', as(cookieA))
      .send({ knowledge: [{ question: 'Are you insured?', answer: 'Yes, fully insured.' }] })
      .expect(200);

    expect((await knowledgeOf(businessA)).map((k) => k.question)).toEqual(['Are you insured?']);
  });

  it('refuses a currency figure typed straight into an answer', async () => {
    const { body } = await api().put('/knowledge').set('Cookie', as(cookieA))
      .send({ knowledge: [{ question: 'Minimum charge?', answer: 'Our minimum is $80.' }] })
      .expect(422);

    expect(body.issues.some((i: { code: string }) => i.code === 'ANSWER_HAS_CURRENCY')).toBe(true);
    expect(await knowledgeOf(businessA)).toHaveLength(0);
  });

  it('refuses two entries asking the same thing', async () => {
    // A duplicate makes the matcher see a tie and answer neither, so it disables both.
    const { body } = await api().put('/knowledge').set('Cookie', as(cookieA))
      .send({
        knowledge: [
          { question: 'Do you bring supplies?', answer: 'Yes, we bring everything.' },
          { question: 'do you  BRING supplies?', answer: 'Yes we do.' },
        ],
      })
      .expect(422);

    expect(body.issues.some((i: { code: string }) => i.code === 'DUPLICATE_QUESTION')).toBe(true);
  });

  it('scopes answers to the session\'s business', async () => {
    await api().put('/knowledge').set('Cookie', as(cookieA))
      .send({ knowledge: [{ question: 'Do you bring supplies?', answer: 'Yes, we bring everything.' }] })
      .expect(200);

    await api().get('/knowledge').set('Cookie', as(cookieB)).expect(200).expect(({ body }) => {
      expect(body).toEqual([]);
    });
    await api().get('/knowledge').expect(401);
    await api().put('/knowledge').send({ knowledge: [] }).expect(401);
  });

  it('imports into the session\'s business and no other', async () => {
    await api().post('/import/apply').set('Cookie', as(cookieA))
      .send({
        services: [{ name: 'Oven clean', pricingType: 'FIXED', priceCents: 7000 }],
        knowledge: [{ question: 'Do you bring supplies?', answer: 'Yes, we bring everything.' }],
      })
      .expect(201);

    expect(await servicesOf(businessB)).toHaveLength(0);
    expect(await knowledgeOf(businessB)).toHaveLength(0);
    // And nothing in the request body can redirect it.
    await api().post('/import/apply').set('Cookie', as(cookieB))
      .send({ businessId: businessA, services: [], knowledge: [] })
      .expect(400);
  });
});
