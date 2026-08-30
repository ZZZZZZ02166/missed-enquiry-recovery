'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { api, ApiError, type LeadDetail } from '@/lib/api';
import { ago, clock, money, phone, rooms } from '@/lib/format';

/**
 * The screen the magic link in every lead SMS opens.
 *
 * It has one job: let the owner ring this person back informed, in under ten seconds of
 * reading. So the number is the largest tappable thing on the page, the transcript is
 * right there, and marking the outcome is two taps.
 */

function Detail({ id }: { id: string }) {
  const [lead, setLead] = useState<LeadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [wonValue, setWonValue] = useState('');
  const [askingValue, setAskingValue] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .get<LeadDetail>(`/leads/${id}`)
      .then((l) => { if (live) setLead(l); })
      .catch((e: unknown) => {
        if (!live) return;
        // 404 is also what another business's lead returns — deliberately, so an id
        // cannot be probed. The message is the same either way.
        setError(e instanceof ApiError && e.status === 404 ? 'Lead not found.' : 'Could not load this lead.');
      });
    return () => { live = false; };
  }, [id]);

  async function mark(body: Record<string, unknown>) {
    setSaving(true);
    try {
      setLead(await api.patch<LeadDetail>(`/leads/${id}`, body));
      setAskingValue(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not save that.');
    } finally {
      setSaving(false);
    }
  }

  async function markWon() {
    const dollars = Number.parseFloat(wonValue);
    // The value is optional. Asking for it is worth doing — it is the number the renewal
    // conversation rests on — but refusing to record the outcome without it would mean
    // owners simply stop marking leads at all.
    await mark({
      status: 'WON',
      ...(Number.isFinite(dollars) && dollars >= 0
        ? { wonValueCents: Math.round(dollars * 100) }
        : {}),
    });
  }

  if (error) return <div className="notice notice-error">{error}</div>;
  if (!lead) return <p className="muted">Loading…</p>;

  const property = [lead.suburb, rooms(lead.bedrooms, lead.bathrooms)].filter(Boolean).join(' · ');
  const closed = lead.status === 'WON' || lead.status === 'LOST';

  return (
    <>
      <Link className="btn btn-quiet" href="/leads" style={{ paddingLeft: 0 }}>
        ← All leads
      </Link>

      {lead.needsHuman ? (
        <div className="notice notice-warn">
          <strong>This one needs you.</strong>
          {lead.needsHumanReason ? <div>{lead.needsHumanReason}</div> : null}
        </div>
      ) : null}

      <div className="card">
        <h1>{lead.customer.name ?? 'Caller'}</h1>
        <p className="faint">{ago(lead.createdAt)}</p>

        {/* The largest tap target on the page. The owner is standing outside a job and
            the only action that earns money is ringing this person back. */}
        <a
          className="btn btn-primary"
          href={`tel:${lead.customer.phoneE164}`}
          style={{ width: '100%', marginTop: '0.8rem', fontSize: '1.1rem' }}
        >
          Call {phone(lead.customer.phoneE164)}
        </a>
      </div>

      <div className="card stack">
        <h2>{lead.service?.name ?? lead.serviceType ?? 'Service not identified'}</h2>
        {property ? <div>{property}</div> : null}
        {lead.carpetedRooms !== null ? <div>{lead.carpetedRooms} carpeted rooms</div> : null}
        {lead.preferredDate ? <div>Wants: {lead.preferredDate}</div> : null}

        {/* Only when the customer was actually told. `quoteShownToCustomer: false` with a
            real amount is a valid state — the owner wanted the figure without it being
            promised on their behalf — and showing it as a quote would undo that choice. */}
        {lead.quotedAmountCents !== null ? (
          <div className={lead.quoteShownToCustomer ? 'notice notice-info' : 'faint'}>
            {lead.quoteShownToCustomer ? (
              <>
                <strong>
                  Quoted {money(lead.quotedAmountCents)}
                  {lead.quoteType === 'FROM' ? '+' : ''} incl. GST
                </strong>
                <div>The customer has been told this figure.</div>
              </>
            ) : (
              <>
                Estimated {money(lead.quotedAmountCents)} — not shown to the customer.
              </>
            )}
          </div>
        ) : null}

        {lead.missingFields.length > 0 ? (
          <div className="faint">Still to confirm: {lead.missingFields.join(', ')}</div>
        ) : null}
      </div>

      <div className="card">
        <h2>Conversation</h2>
        <div className="thread" style={{ marginTop: '0.7rem' }}>
          {lead.messages.length === 0 ? (
            <p className="muted">No messages yet.</p>
          ) : (
            lead.messages.map((m) => (
              <div key={m.id} className={m.direction === 'INBOUND' ? '' : 'row-between'}>
                <div className={`bubble ${m.direction === 'INBOUND' ? 'bubble-in' : 'bubble-out'}`}>
                  {m.body}
                  <div className="bubble-meta">
                    {m.direction === 'INBOUND' ? 'Them' : 'Us'} · {clock(m.createdAt)}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="card">
        <h2>How did it go?</h2>
        {closed ? (
          <div className="stack" style={{ marginTop: '0.5rem' }}>
            <div>
              <span className={lead.status === 'WON' ? 'badge badge-won' : 'badge badge-lost'}>
                {lead.status === 'WON' ? 'Won' : 'Lost'}
              </span>
              {lead.wonValueCents !== null ? <span> · {money(lead.wonValueCents)}</span> : null}
            </div>
            {lead.lostReason ? <div className="muted">{lead.lostReason}</div> : null}
            {/* Reversible: an owner who taps the wrong one on a phone in sunlight should
                not have to live with it. */}
            <button className="btn btn-quiet" disabled={saving} onClick={() => mark({ status: 'QUOTED' })}>
              Reopen
            </button>
          </div>
        ) : askingValue ? (
          <div style={{ marginTop: '0.6rem' }}>
            <div className="field">
              <label htmlFor="value">What was the job worth? (optional)</label>
              <input
                id="value"
                inputMode="decimal"
                placeholder="480"
                value={wonValue}
                onChange={(e) => setWonValue(e.target.value)}
              />
            </div>
            <div className="btn-row" style={{ marginTop: '0.7rem' }}>
              <button className="btn btn-good" disabled={saving} onClick={markWon}>
                Mark won
              </button>
              <button className="btn btn-quiet" onClick={() => setAskingValue(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="btn-row" style={{ marginTop: '0.6rem' }}>
            <button className="btn btn-good" disabled={saving} onClick={() => setAskingValue(true)}>
              Won
            </button>
            <button className="btn btn-danger" disabled={saving} onClick={() => mark({ status: 'LOST' })}>
              Lost
            </button>
            {lead.needsHuman ? (
              <button className="btn btn-quiet" disabled={saving} onClick={() => mark({ needsHuman: false })}>
                Dealt with
              </button>
            ) : null}
          </div>
        )}
      </div>
    </>
  );
}

export default function LeadPage() {
  const params = useParams<{ id: string }>();
  return (
    <AppShell>
      <Detail id={params.id} />
    </AppShell>
  );
}
