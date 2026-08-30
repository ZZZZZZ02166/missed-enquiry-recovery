'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { api, type LeadPage, type LeadStatus, type LeadSummary } from '@/lib/api';
import { ago, money, phone, rooms } from '@/lib/format';

/**
 * The inbox.
 *
 * Ordered newest first and built to be scanned, not read: an owner opens this between
 * jobs and needs to know in about two seconds whether anything needs them right now.
 * Everything on a row answers one of three questions — who, what, how stale.
 */

const FILTERS: { label: string; value: LeadStatus | 'ALL' | 'ATTENTION' }[] = [
  { label: 'All', value: 'ALL' },
  { label: 'Needs you', value: 'ATTENTION' },
  { label: 'Won', value: 'WON' },
  { label: 'Lost', value: 'LOST' },
];

function statusBadge(lead: LeadSummary) {
  if (lead.needsHuman) return { className: 'badge badge-attention', label: 'Needs you' };
  if (lead.status === 'WON') return { className: 'badge badge-won', label: 'Won' };
  if (lead.status === 'LOST') return { className: 'badge badge-lost', label: 'Lost' };
  if (lead.status === 'NEW' || lead.status === 'QUALIFYING') {
    return { className: 'badge badge-new', label: 'New' };
  }
  return { className: 'badge', label: lead.status === 'QUOTED' ? 'Quoted' : 'Qualified' };
}

function LeadRow({ lead }: { lead: LeadSummary }) {
  const badge = statusBadge(lead);
  const property = [lead.suburb, rooms(lead.bedrooms, lead.bathrooms)].filter(Boolean).join(' · ');

  return (
    <Link className="card" href={`/leads/${lead.id}`}>
      <div className="row-between">
        <strong>{lead.customer.name ?? phone(lead.customer.phoneE164)}</strong>
        <span className={badge.className}>{badge.label}</span>
      </div>

      <div className="stack" style={{ marginTop: '0.35rem' }}>
        <div>{lead.service?.name ?? lead.serviceType ?? 'Service not yet known'}</div>
        {property ? <div className="muted">{property}</div> : null}
        {lead.preferredDate ? <div className="muted">Wants: {lead.preferredDate}</div> : null}
      </div>

      <div className="row-between" style={{ marginTop: '0.5rem' }}>
        <span className="faint">{ago(lead.createdAt)}</span>
        {/* Only shown when the customer was actually told. A figure the owner never
            quoted, displayed as though they had, is how a price gets honoured by
            accident. */}
        {lead.quotedAmountCents !== null && lead.quoteShownToCustomer ? (
          <span className="faint">
            Quoted {money(lead.quotedAmountCents)}
            {lead.quoteType === 'FROM' ? '+' : ''}
          </span>
        ) : null}
        {lead.wonValueCents !== null ? (
          <span className="faint">Won {money(lead.wonValueCents)}</span>
        ) : null}
      </div>
    </Link>
  );
}

function Inbox() {
  // The hub links straight to a filtered view — "2 leads need you" should land on those
  // two, not on everything.
  const params = useSearchParams();
  const requested = params.get('filter');
  const initial = FILTERS.find(
    (f) => f.value === requested || (requested === 'attention' && f.value === 'ATTENTION'),
  )?.value;

  const [filter, setFilter] = useState<(typeof FILTERS)[number]['value']>(initial ?? 'ALL');
  const [leads, setLeads] = useState<LeadSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const query = useCallback(
    (after?: string) => {
      const params = new URLSearchParams({ limit: '25' });
      if (filter === 'ATTENTION') params.set('needsHuman', 'true');
      else if (filter !== 'ALL') params.set('status', filter);
      if (after) params.set('cursor', after);
      return `/leads?${params.toString()}`;
    },
    [filter],
  );

  useEffect(() => {
    let live = true;
    // One state update per outcome rather than a `setLoading(true)` on the way in.
    // Setting state synchronously inside an effect schedules an extra render before the
    // request has even started, and React flags it — the loading flag is derived from
    // the request instead.
    api
      .get<LeadPage>(query())
      .then((page) => {
        if (!live) return;
        setLeads(page.leads);
        setCursor(page.nextCursor);
        setError(null);
      })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : 'Something went wrong'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [query]);

  async function loadMore() {
    if (!cursor) return;
    const page = await api.get<LeadPage>(query(cursor));
    // Appended, not replaced. The cursor is stable while new leads arrive, so this
    // cannot show the same lead twice the way an offset would.
    setLeads((current) => [...current, ...page.leads]);
    setCursor(page.nextCursor);
  }

  return (
    <>
      <div className="row-between">
        <h1>Leads</h1>
      </div>

      <div className="pills">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            className="pill"
            aria-pressed={filter === f.value}
            onClick={() => setFilter(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error ? <div className="notice notice-error">{error}</div> : null}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : leads.length === 0 ? (
        <div className="empty">
          <p>No leads here yet.</p>
          <p className="faint" style={{ marginTop: '0.5rem' }}>
            A lead appears when someone you missed replies to our text.
          </p>
        </div>
      ) : (
        <div>
          {leads.map((lead) => (
            <LeadRow key={lead.id} lead={lead} />
          ))}
          {cursor ? (
            <button className="btn" style={{ marginTop: '0.8rem' }} onClick={loadMore}>
              Load more
            </button>
          ) : null}
        </div>
      )}
    </>
  );
}

export default function LeadsPage() {
  return (
    <AppShell>
      {/* `useSearchParams` needs a Suspense boundary, or the whole route opts out of
          static rendering and the build says so. */}
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Inbox />
      </Suspense>
    </AppShell>
  );
}
