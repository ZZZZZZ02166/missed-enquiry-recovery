'use client';

import { useEffect, useState } from 'react';
import {
  MAX_ACTIVE_SERVICES,
  MAX_SERVICE_NAME_CHARS,
  validateServiceName,
  validateServicePricing,
} from 'shared-types';
import { AppShell } from '@/components/AppShell';
import { api, ValidationError, type PricingType, type ServiceRow } from '@/lib/api';
import { money } from '@/lib/format';

/**
 * The service catalogue.
 *
 * The only screen where an owner creates something the conversation engine then depends
 * on. What they configure here is read to a caller as a numbered menu and priced by
 * deterministic code, so every rule needs an affordance and an error state — a save that
 * fails without explaining itself leaves a business whose customers are never quoted.
 *
 * **Validation runs here and again on the server, from the same module.**
 * `shared-types/service-catalogue` is imported by both, so the form cannot accept
 * something the API will reject. The browser copy is for speed of feedback, not for
 * safety — the server's copy is the one that counts, and the 422 it returns carries the
 * same issue objects this file already knows how to render.
 */

const PRICING: { value: PricingType; label: string; hint: string }[] = [
  { value: 'FIXED', label: 'Fixed price', hint: 'One price, quoted straight away.' },
  { value: 'STARTING_FROM', label: 'Starting from', hint: 'A floor. "Prices start from…"' },
  { value: 'PER_UNIT', label: 'Per unit', hint: 'A rate times a quantity — per room, per hour.' },
  { value: 'MANUAL_QUOTE', label: 'Quote manually', hint: 'No price is ever stated. You call back.' },
];

/** All this screen needs from an issue, whoever produced it. */
interface Displayable {
  code: string;
  message: string;
}

interface Draft {
  name: string;
  pricingType: PricingType;
  price: string;
  unitLabel: string;
  showPriceAutomatically: boolean;
}

const EMPTY: Draft = {
  name: '',
  pricingType: 'MANUAL_QUOTE',
  price: '',
  unitLabel: '',
  showPriceAutomatically: true,
};

/** Dollars typed by a person to integer cents (rule 11). Blank stays blank. */
function toCents(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) : null;
}

function Catalogue() {
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Deliberately widened to just what this page renders. Server issues and
  // locally-computed ones have the same shape but not the same `code` type — narrowing a
  // wire value to the client's own enum assumes the two can never drift, and they can.
  const [issues, setIssues] = useState<Displayable[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api
      .get<ServiceRow[]>('/services')
      .then(setServices)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load your services'))
      .finally(() => setLoading(false));

  useEffect(() => { void load(); }, []);

  const activeCount = services.filter((s) => s.availability === 'ACTIVE').length;
  const atCeiling = activeCount >= MAX_ACTIVE_SERVICES;

  /** The same rules the server runs, for immediate feedback while typing. */
  const draftIssues: Displayable[] = [
    ...validateServiceName(draft.name),
    ...validateServicePricing({
      pricingType: draft.pricingType,
      priceCents: toCents(draft.price),
      unitLabel: draft.unitLabel,
    }),
  ];

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setIssues([]);
    setError(null);
    try {
      await action();
      await load();
      return true;
    } catch (e: unknown) {
      if (e instanceof ValidationError) {
        // Kept structured all the way from the server. The API returns every issue at
        // once precisely so a five-field mistake does not take five saves.
        setIssues(e.issues);
      } else {
        setError(e instanceof Error ? e.message : 'Something went wrong');
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const cents = toCents(draft.price);
    const created = await run(() =>
      api.post('/services', {
        name: draft.name.trim(),
        pricingType: draft.pricingType,
        ...(cents === null ? {} : { priceCents: cents }),
        ...(draft.pricingType === 'PER_UNIT' ? { unitLabel: draft.unitLabel.trim() } : {}),
        showPriceAutomatically: draft.showPriceAutomatically,
      }),
    );
    if (created) {
      setDraft(EMPTY);
      setAdding(false);
    }
  }

  const move = (index: number, by: number) => {
    const next = [...services];
    const target = index + by;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    // The whole list, every time — the only shape the server can validate atomically,
    // and it is what a drag-and-drop would send anyway.
    void run(() => api.put('/services/order', { orderedIds: next.map((s) => s.id) }));
  };

  return (
    <>
      <div className="row-between">
        <h1>Services</h1>
        <span className="faint">
          {activeCount} of {MAX_ACTIVE_SERVICES} active
        </span>
      </div>

      <p className="muted">
        These are read to a caller as a numbered list — they reply with one digit. Only
        active services appear, in this order.
      </p>

      {error ? <div className="notice notice-error">{error}</div> : null}

      {issues.length > 0 ? (
        <div className="notice notice-error">
          <strong>That could not be saved.</strong>
          <ul>
            {issues.map((issue, i) => (
              <li key={`${issue.code}-${i}`}>{issue.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {atCeiling ? (
        <div className="notice notice-warn">
          You have the maximum {MAX_ACTIVE_SERVICES} active services. Turn one off before adding
          another — nothing is deleted, and you can switch it back any time.
        </div>
      ) : null}

      {loading ? <p className="muted">Loading…</p> : null}

      {!loading && services.length === 0 ? (
        <div className="empty">
          <p>No services yet.</p>
          <p className="faint" style={{ margin: '0.5rem 0 1rem' }}>
            Until you add some, callers are asked to describe what they need in their own
            words and nothing is priced automatically.
          </p>
          <button className="btn btn-primary" disabled={busy} onClick={() => void run(() => api.post('/services/seed-defaults'))}>
            Start with the usual four
          </button>
        </div>
      ) : null}

      {services.map((service, index) => (
        <div className="card" key={service.id}>
          <div className="row-between">
            <div>
              <strong>{index + 1}. {service.name}</strong>
              <div className="faint">
                {service.pricingType === 'MANUAL_QUOTE'
                  ? 'Quoted manually'
                  : service.pricingType === 'PER_UNIT'
                    ? `${money(service.priceCents)} per ${service.unitLabel ?? 'unit'}`
                    : service.pricingType === 'STARTING_FROM'
                      ? `From ${money(service.priceCents)}`
                      : money(service.priceCents)}
                {service.priceCents !== null && !service.showPriceAutomatically
                  ? ' · not shown to callers'
                  : ''}
              </div>
            </div>
            <span className={service.availability === 'ACTIVE' ? 'badge badge-won' : 'badge'}>
              {service.availability === 'ACTIVE' ? 'Active' : 'Off'}
            </span>
          </div>

          <div className="btn-row" style={{ marginTop: '0.7rem' }}>
            <button className="btn btn-quiet" disabled={busy || index === 0} onClick={() => move(index, -1)}>
              ↑
            </button>
            <button
              className="btn btn-quiet"
              disabled={busy || index === services.length - 1}
              onClick={() => move(index, 1)}
            >
              ↓
            </button>
            <button
              className="btn"
              disabled={busy || (service.availability !== 'ACTIVE' && atCeiling)}
              onClick={() =>
                void run(() =>
                  api.patch(`/services/${service.id}/availability`, {
                    availability: service.availability === 'ACTIVE' ? 'DISABLED' : 'ACTIVE',
                  }),
                )
              }
            >
              {service.availability === 'ACTIVE' ? 'Turn off' : 'Turn on'}
            </button>
            <button
              className="btn btn-danger"
              disabled={busy}
              onClick={() => void run(() => api.delete(`/services/${service.id}`))}
            >
              Remove
            </button>
          </div>
        </div>
      ))}

      {adding ? (
        <div className="card">
          <h2>New service</h2>

          <div className="field" style={{ marginTop: '0.7rem' }}>
            <label htmlFor="name">Name</label>
            <input
              id="name"
              value={draft.name}
              maxLength={MAX_SERVICE_NAME_CHARS}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="End-of-lease cleaning"
            />
            <div className="faint">
              {draft.name.length}/{MAX_SERVICE_NAME_CHARS} — this is read out in a text message,
              so it has to be short.
            </div>
          </div>

          <div className="field">
            <label htmlFor="type">How is it priced?</label>
            <select
              id="type"
              value={draft.pricingType}
              onChange={(e) => setDraft({ ...draft, pricingType: e.target.value as PricingType })}
            >
              {PRICING.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
            <div className="faint">{PRICING.find((p) => p.value === draft.pricingType)?.hint}</div>
          </div>

          {draft.pricingType !== 'MANUAL_QUOTE' ? (
            <div className="field-row">
              <div className="field">
                <label htmlFor="price">
                  {draft.pricingType === 'PER_UNIT' ? 'Rate per unit' : 'Price'}
                </label>
                <input
                  id="price"
                  inputMode="decimal"
                  value={draft.price}
                  onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                  placeholder="280"
                />
              </div>
              {draft.pricingType === 'PER_UNIT' ? (
                <div className="field">
                  <label htmlFor="unit">Per what?</label>
                  <input
                    id="unit"
                    value={draft.unitLabel}
                    onChange={(e) => setDraft({ ...draft, unitLabel: e.target.value })}
                    placeholder="room"
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {draft.pricingType !== 'MANUAL_QUOTE' ? (
            <div className="field">
              <label htmlFor="show" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <input
                  id="show"
                  type="checkbox"
                  style={{ width: 'auto', minHeight: 'auto' }}
                  checked={draft.showPriceAutomatically}
                  onChange={(e) => setDraft({ ...draft, showPriceAutomatically: e.target.checked })}
                />
                Tell the caller this price
              </label>
              <div className="faint">
                Off means we work the price out for your lead but never say it to the customer.
              </div>
            </div>
          ) : null}

          {/* Whatever the owner is typing, checked live by the same rules the server
              runs. Shown as guidance rather than as a blocked save — the button is
              disabled, and the reason is right here. */}
          {draft.name.length > 0 && draftIssues.length > 0 ? (
            <div className="notice notice-warn" style={{ marginTop: '0.7rem' }}>
              <ul>
                {draftIssues.map((issue, i) => (
                  <li key={`${issue.code}-${i}`}>{issue.message}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="btn-row" style={{ marginTop: '0.8rem' }}>
            <button
              className="btn btn-primary"
              disabled={busy || draft.name.trim().length === 0 || draftIssues.length > 0}
              onClick={() => void add()}
            >
              Add service
            </button>
            <button className="btn btn-quiet" onClick={() => { setAdding(false); setDraft(EMPTY); }}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          className="btn btn-primary"
          disabled={busy || atCeiling}
          onClick={() => setAdding(true)}
        >
          Add a service
        </button>
      )}
    </>
  );
}

export default function ServicesPage() {
  return (
    <AppShell>
      <Catalogue />
    </AppShell>
  );
}
