'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import {
  MAX_KNOWLEDGE_ANSWER_CHARS,
  MAX_SERVICE_NAME_CHARS,
  validateKnowledgeEntry,
  validateServiceName,
  validateServicePricing,
} from 'shared-types';
import { AppShell } from '@/components/AppShell';
import {
  api,
  ValidationError,
  type ImportApplyResult,
  type ImportProposal,
  type PricingType,
} from '@/lib/api';

/**
 * Import a price list, handbook or service document.
 *
 * **This screen exists to be doubted.** A model read the owner's document and it can have
 * misread it — so the job here is not to present a result, it is to make a wrong result
 * obvious in the two seconds an owner will actually spend looking.
 *
 * Three things follow from that, and they are the whole design:
 *
 * 1. **Every row shows the sentence it came from.** A price misread from "from $28.00 per
 *    room" is glaring beside its source and invisible without it. This is the difference
 *    between a review screen and a rubber stamp, and it is why the excerpt is not tucked
 *    behind a disclosure.
 * 2. **"Tell callers this price" starts off, on every row.** The owner turns it on
 *    deliberately or nobody ever hears the figure. An unticked price still reaches their
 *    lead, so the cost of leaving it off is nothing and the cost of a wrong number going
 *    out is a job quoted at the wrong price.
 * 3. **Nothing is saved until Import is pressed.** The document was read in memory and
 *    thrown away; what gets written is what is on this screen when the button is pressed,
 *    edits included.
 *
 * Validation is the same module the server runs, so a row this screen accepts is a row
 * the API will accept — and the 422 it would return carries the same issue objects.
 */

const PRICING: { value: PricingType; label: string }[] = [
  { value: 'FIXED', label: 'Fixed price' },
  { value: 'STARTING_FROM', label: 'Starting from' },
  { value: 'PER_UNIT', label: 'Per unit' },
  { value: 'MANUAL_QUOTE', label: 'Quote manually' },
];

interface ServiceDraft {
  include: boolean;
  name: string;
  description: string;
  pricingType: PricingType;
  /** Dollars as typed. Converted to integer cents on submit (rule 11). */
  price: string;
  unitLabel: string;
  showPriceAutomatically: boolean;
  sourceExcerpt: string;
}

interface KnowledgeDraft {
  include: boolean;
  question: string;
  aliases: string[];
  answer: string;
  sourceExcerpt: string;
}

function toCents(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) : null;
}

const toDollars = (cents: number | undefined): string =>
  cents === undefined ? '' : (cents / 100).toFixed(2).replace(/\.00$/, '');

function toDrafts(proposal: ImportProposal): { services: ServiceDraft[]; knowledge: KnowledgeDraft[] } {
  return {
    services: proposal.services.map((s) => ({
      // Rows the server already flagged start unticked. The owner opts a broken row back
      // in after fixing it, rather than being blocked by something they did not choose.
      include: s.problems.length === 0,
      name: s.name,
      description: s.description ?? '',
      pricingType: s.pricingType,
      price: toDollars(s.priceCents),
      unitLabel: s.unitLabel ?? '',
      // Never carried over from the model, whatever it returned.
      showPriceAutomatically: false,
      sourceExcerpt: s.sourceExcerpt,
    })),
    knowledge: proposal.knowledge.map((k) => ({
      include: k.problems.length === 0,
      question: k.question,
      aliases: k.aliases,
      answer: k.answer,
      sourceExcerpt: k.sourceExcerpt,
    })),
  };
}

/** The same rules the server runs, live, so a fix is visible as it is typed. */
function serviceProblems(draft: ServiceDraft): string[] {
  return [
    ...validateServiceName(draft.name),
    ...validateServicePricing({
      pricingType: draft.pricingType,
      priceCents: toCents(draft.price),
      unitLabel: draft.unitLabel,
    }),
  ].map((i) => i.message);
}

const knowledgeProblems = (draft: KnowledgeDraft): string[] =>
  validateKnowledgeEntry({ question: draft.question, answer: draft.answer }).map((i) => i.message);

function Source({ text }: { text: string }) {
  if (!text) return <div className="faint">No source text — check this one yourself.</div>;
  return (
    <div className="faint" style={{ marginTop: '0.4rem' }}>
      From your document: <q>{text}</q>
    </div>
  );
}

function Importer() {
  const [proposal, setProposal] = useState<ImportProposal | null>(null);
  const [services, setServices] = useState<ServiceDraft[]>([]);
  const [knowledge, setKnowledge] = useState<KnowledgeDraft[]>([]);
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<{ code: string; message: string }[]>([]);
  const [done, setDone] = useState<ImportApplyResult | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const received = (result: ImportProposal) => {
    setProposal(result);
    const drafts = toDrafts(result);
    setServices(drafts.services);
    setKnowledge(drafts.knowledge);
  };

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setIssues([]);
    try {
      await action();
      return true;
    } catch (e: unknown) {
      if (e instanceof ValidationError) setIssues(e.issues);
      else setError(e instanceof Error ? e.message : 'Something went wrong');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File) {
    const form = new FormData();
    form.append('file', file);
    await run(async () => received(await api.postForm<ImportProposal>('/import/document', form)));
  }

  async function readPasted() {
    await run(async () => received(await api.post<ImportProposal>('/import/text', { text: pasted })));
  }

  const chosenServices = services.filter((s) => s.include);
  const chosenKnowledge = knowledge.filter((k) => k.include);
  // Only what is actually going to be sent can block the button. An excluded broken row
  // is not a problem — it is a row the owner decided against.
  const blocking =
    chosenServices.some((s) => serviceProblems(s).length > 0) ||
    chosenKnowledge.some((k) => knowledgeProblems(k).length > 0);

  async function apply() {
    const saved = await run(async () => {
      const result = await api.post<ImportApplyResult>('/import/apply', {
        services: chosenServices.map((s) => {
          const cents = toCents(s.price);
          return {
            name: s.name.trim(),
            ...(s.description.trim() ? { description: s.description.trim() } : {}),
            pricingType: s.pricingType,
            ...(cents === null || s.pricingType === 'MANUAL_QUOTE' ? {} : { priceCents: cents }),
            ...(s.pricingType === 'PER_UNIT' ? { unitLabel: s.unitLabel.trim() } : {}),
            showPriceAutomatically: s.showPriceAutomatically,
          };
        }),
        knowledge: chosenKnowledge.map((k) => ({
          question: k.question.trim(),
          aliases: k.aliases,
          answer: k.answer.trim(),
          ...(k.sourceExcerpt ? { sourceExcerpt: k.sourceExcerpt } : {}),
        })),
      });
      setDone(result);
    });
    if (saved) setProposal(null);
  }

  const patchService = (index: number, change: Partial<ServiceDraft>) =>
    setServices(services.map((s, i) => (i === index ? { ...s, ...change } : s)));
  const patchKnowledge = (index: number, change: Partial<KnowledgeDraft>) =>
    setKnowledge(knowledge.map((k, i) => (i === index ? { ...k, ...change } : k)));

  // --- after a successful import -------------------------------------------------------

  if (done) {
    return (
      <>
        <h1>Imported</h1>
        <div className="notice notice-info">
          <strong>
            {done.servicesCreated} {done.servicesCreated === 1 ? 'service' : 'services'} and{' '}
            {done.knowledgeSaved} {done.knowledgeSaved === 1 ? 'answer' : 'answers'} added.
          </strong>
          <div>
            Check the order your services are read out in — callers pick from a numbered list.
          </div>
        </div>
        <div className="btn-row">
          <Link className="btn btn-primary" href="/settings/services">Review services</Link>
          <Link className="btn" href="/settings/knowledge">Review answers</Link>
          <button className="btn btn-quiet" onClick={() => { setDone(null); setPasted(''); }}>
            Import another document
          </button>
        </div>
      </>
    );
  }

  // --- the review screen ---------------------------------------------------------------

  if (proposal) {
    return (
      <>
        <div className="row-between">
          <h1>Check what we found</h1>
          <button className="btn btn-quiet" onClick={() => setProposal(null)} disabled={busy}>
            Start over
          </button>
        </div>

        <p className="muted">
          Nothing is saved yet. Edit anything that looks wrong, untick anything you do not
          want, then import.
        </p>

        {error ? <div className="notice notice-error">{error}</div> : null}
        {issues.length > 0 ? (
          <div className="notice notice-error">
            <strong>That could not be saved.</strong>
            <ul>
              {issues.map((issue, i) => <li key={`${issue.code}-${i}`}>{issue.message}</li>)}
            </ul>
          </div>
        ) : null}

        {services.length === 0 && knowledge.length === 0 ? (
          <div className="empty">
            <p>We could not find any services in that document.</p>
            <p className="faint" style={{ margin: '0.5rem 0 1rem' }}>
              It may not list them plainly. Try pasting just the section with your services
              and prices in it.
            </p>
            <button className="btn btn-primary" onClick={() => setProposal(null)}>Try again</button>
          </div>
        ) : null}

        {services.length > 0 ? <div className="section-label">Services</div> : null}

        {services.map((draft, index) => {
          const problems = serviceProblems(draft);
          return (
            <div className="card" key={`service-${index}`}>
              <label className="row-between" style={{ gap: '0.6rem', alignItems: 'flex-start' }}>
                <span style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto', minHeight: 'auto' }}
                    checked={draft.include}
                    onChange={(e) => patchService(index, { include: e.target.checked })}
                  />
                  <strong>{draft.name || 'Unnamed service'}</strong>
                </span>
              </label>

              {/* The source sentence, right beside the figure it produced. */}
              <Source text={draft.sourceExcerpt} />

              {draft.include ? (
                <>
                  <div className="field" style={{ marginTop: '0.7rem' }}>
                    <label htmlFor={`name-${index}`}>Name</label>
                    <input
                      id={`name-${index}`}
                      value={draft.name}
                      maxLength={MAX_SERVICE_NAME_CHARS}
                      onChange={(e) => patchService(index, { name: e.target.value })}
                    />
                    <div className="faint">
                      {draft.name.length}/{MAX_SERVICE_NAME_CHARS} — read out in a text message.
                    </div>
                  </div>

                  <div className="field">
                    <label htmlFor={`type-${index}`}>How is it priced?</label>
                    <select
                      id={`type-${index}`}
                      value={draft.pricingType}
                      onChange={(e) =>
                        patchService(index, { pricingType: e.target.value as PricingType })
                      }
                    >
                      {PRICING.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                    </select>
                  </div>

                  {draft.pricingType !== 'MANUAL_QUOTE' ? (
                    <>
                      <div className="field-row">
                        <div className="field">
                          <label htmlFor={`price-${index}`}>
                            {draft.pricingType === 'PER_UNIT' ? 'Rate per unit' : 'Price'}
                          </label>
                          <input
                            id={`price-${index}`}
                            inputMode="decimal"
                            value={draft.price}
                            onChange={(e) => patchService(index, { price: e.target.value })}
                          />
                        </div>
                        {draft.pricingType === 'PER_UNIT' ? (
                          <div className="field">
                            <label htmlFor={`unit-${index}`}>Per what?</label>
                            <input
                              id={`unit-${index}`}
                              value={draft.unitLabel}
                              onChange={(e) => patchService(index, { unitLabel: e.target.value })}
                              placeholder="room"
                            />
                          </div>
                        ) : null}
                      </div>

                      {/*
                        Off by default and stated plainly. This is the one control on the
                        screen that decides whether a figure we read out of a PDF is said
                        to a customer.
                      */}
                      <div className="field">
                        <label
                          htmlFor={`show-${index}`}
                          style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}
                        >
                          <input
                            id={`show-${index}`}
                            type="checkbox"
                            style={{ width: 'auto', minHeight: 'auto' }}
                            checked={draft.showPriceAutomatically}
                            onChange={(e) =>
                              patchService(index, { showPriceAutomatically: e.target.checked })
                            }
                          />
                          Tell callers this price
                        </label>
                        <div className="faint">
                          Leave this off until you have checked the figure against your
                          document. Off means we still work it out for your lead — we just
                          never say it to the customer.
                        </div>
                      </div>
                    </>
                  ) : null}

                  {problems.length > 0 ? (
                    <div className="notice notice-warn" style={{ marginTop: '0.7rem' }}>
                      <ul>{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="faint" style={{ marginTop: '0.5rem' }}>Will not be imported.</div>
              )}
            </div>
          );
        })}

        {knowledge.length > 0 ? (
          <>
            <div className="section-label">Answers to common questions</div>
            <p className="muted">
              When a caller asks one of these, we text your answer back straight away —
              word for word, without asking a computer to rewrite it.
            </p>
          </>
        ) : null}

        {knowledge.map((draft, index) => {
          const problems = knowledgeProblems(draft);
          return (
            <div className="card" key={`knowledge-${index}`}>
              <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto', minHeight: 'auto' }}
                  checked={draft.include}
                  onChange={(e) => patchKnowledge(index, { include: e.target.checked })}
                />
                <strong>{draft.question || 'Unnamed question'}</strong>
              </label>

              <Source text={draft.sourceExcerpt} />

              {draft.include ? (
                <>
                  <div className="field" style={{ marginTop: '0.7rem' }}>
                    <label htmlFor={`q-${index}`}>Question</label>
                    <input
                      id={`q-${index}`}
                      value={draft.question}
                      onChange={(e) => patchKnowledge(index, { question: e.target.value })}
                    />
                  </div>

                  <div className="field">
                    <label htmlFor={`a-${index}`}>Your answer, exactly as we will send it</label>
                    <textarea
                      id={`a-${index}`}
                      rows={3}
                      value={draft.answer}
                      onChange={(e) => patchKnowledge(index, { answer: e.target.value })}
                    />
                    <div className="faint">
                      {draft.answer.length}/{MAX_KNOWLEDGE_ANSWER_CHARS} characters. No prices
                      here — add those as a service so the figure includes GST.
                    </div>
                  </div>

                  {problems.length > 0 ? (
                    <div className="notice notice-warn">
                      <ul>{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="faint" style={{ marginTop: '0.5rem' }}>Will not be imported.</div>
              )}
            </div>
          );
        })}

        {services.length > 0 || knowledge.length > 0 ? (
          <div className="card">
            <div className="row-between">
              <strong>
                Importing {chosenServices.length}{' '}
                {chosenServices.length === 1 ? 'service' : 'services'} and{' '}
                {chosenKnowledge.length} {chosenKnowledge.length === 1 ? 'answer' : 'answers'}
              </strong>
            </div>
            {blocking ? (
              <div className="faint" style={{ marginTop: '0.4rem' }}>
                Fix the highlighted rows above, or untick them.
              </div>
            ) : null}
            <div className="btn-row" style={{ marginTop: '0.8rem' }}>
              <button
                className="btn btn-primary"
                disabled={
                  busy || blocking || (chosenServices.length === 0 && chosenKnowledge.length === 0)
                }
                onClick={() => void apply()}
              >
                {busy ? 'Importing…' : 'Import'}
              </button>
              <button className="btn btn-quiet" disabled={busy} onClick={() => setProposal(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </>
    );
  }

  // --- the upload screen ---------------------------------------------------------------

  return (
    <>
      {/* Named for the action, not for one of its two outputs. "Import your services" was
          the first heading and it undersold the screen — the answers it reads are half of
          what an owner gets out of a handbook. */}
      <h1>Import from a document</h1>
      <p className="muted">
        Upload a price list, handbook or quote template and we will read your services,
        prices and common answers out of it. You check everything before anything is saved.
      </p>

      {error ? <div className="notice notice-error">{error}</div> : null}

      <div className="card">
        <h2>Upload a PDF</h2>
        <div className="field" style={{ marginTop: '0.7rem' }}>
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf,.pdf"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
              // Cleared so choosing the same file twice still fires a change event —
              // otherwise a retry after an error looks like a dead button.
              e.target.value = '';
            }}
          />
          <div className="faint">
            It has to be a PDF with real text in it. A scan or photos of pages has nothing
            to read — paste the text below instead.
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Or paste it in</h2>
        <p className="faint">
          Works with anything — an email, a page from your website, part of a handbook.
        </p>
        <div className="field" style={{ marginTop: '0.7rem' }}>
          <textarea
            rows={10}
            value={pasted}
            disabled={busy}
            placeholder={'End of lease cleaning from 280\nCarpet steam clean 40 per room\nWe bring all our own products'}
            onChange={(e) => setPasted(e.target.value)}
          />
        </div>
        <button
          className="btn btn-primary"
          disabled={busy || pasted.trim().length === 0}
          onClick={() => void readPasted()}
        >
          {busy ? 'Reading…' : 'Read this'}
        </button>
      </div>

      {busy ? <p className="muted">Reading your document — this takes a few seconds.</p> : null}
    </>
  );
}

export default function ImportPage() {
  return (
    <AppShell>
      <Importer />
    </AppShell>
  );
}
