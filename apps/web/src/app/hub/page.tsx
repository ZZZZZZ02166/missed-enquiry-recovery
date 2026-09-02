'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { MAX_ACTIVE_SERVICES } from 'shared-types';
import { AppShell } from '@/components/AppShell';
import { api, type LeadSummary, type ServiceRow } from '@/lib/api';
import { money } from '@/lib/format';

/**
 * The hub — the first thing an owner sees.
 *
 * **It answers one question: do I need to do anything right now?**
 *
 * That is a deliberate reversal. The dashboard used to open on a list of leads, which is
 * a *data* view — it makes you read before you know whether reading was necessary. The
 * owner opening this is standing outside a job with about four seconds of attention, and
 * most of the time the honest answer is "no, the system handled it". A list cannot say
 * that. A number can, and an empty state can say it best of all.
 *
 * So the layout is: a status line, then the exceptions, then the doors. When nothing is
 * wrong the page is mostly reassurance, and that is the correct output — this product's
 * value is that it works while nobody is watching.
 */

interface Summary {
  needsAttention: number;
  openLeads: number;
  quoted: number;
  newToday: number;
  wonThisWeek: { count: number; valueCents: number | null };
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

interface TileProps {
  href?: string;
  icon: string;
  title: string;
  note: string;
  count?: number | string;
  urgent?: boolean;
  soon?: boolean;
}

function Tile({ href, icon, title, note, count, urgent, soon }: TileProps) {
  const className = `tile${urgent ? ' tile-urgent' : ''}${soon ? ' tile-soon' : ''}`;
  const inner = (
    <>
      <span className="tile-icon" aria-hidden="true">{icon}</span>
      <span className="tile-body">
        <span className="tile-title">
          {title}
          {soon ? <span className="badge badge-soon">Soon</span> : null}
        </span>
        <span className="tile-note">{note}</span>
      </span>
      {count !== undefined ? <span className="tile-count">{count}</span> : null}
    </>
  );

  // A tile with nowhere to go is not a link. Making it one would put a keyboard stop on
  // something that does nothing.
  return href ? (
    <Link className={className} href={href}>{inner}</Link>
  ) : (
    <div className={className}>{inner}</div>
  );
}

function Hub() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [recent, setRecent] = useState<LeadSummary[]>([]);
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([
      api.get<Summary>('/leads/summary'),
      api.get<{ leads: LeadSummary[] }>('/leads?limit=3'),
      api.get<ServiceRow[]>('/services'),
    ])
      .then(([s, page, catalogue]) => {
        if (!live) return;
        setSummary(s);
        setRecent(page.leads);
        setServices(catalogue);
      })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : 'Something went wrong'); });
    return () => { live = false; };
  }, []);

  if (error) return <div className="notice notice-error">{error}</div>;
  if (!summary) return <p className="muted">Loading…</p>;

  const active = services.filter((s) => s.availability === 'ACTIVE').length;
  const calm = summary.needsAttention === 0;

  return (
    <>
      <h1>{greeting()}</h1>

      <p className="muted">
        {summary.newToday === 0
          ? 'No new enquiries in the last day.'
          : `${summary.newToday} new ${summary.newToday === 1 ? 'enquiry' : 'enquiries'} in the last day.`}
      </p>

      {/* The reassurance panel. When nothing needs the owner, saying so *is* the
          product's output — it means the system answered everyone without them. */}
      {calm ? (
        <div className="calm">
          <span className="calm-mark" aria-hidden="true">✓</span>
          <span>
            <strong>You&apos;re all caught up.</strong>
            <div className="muted">
              {active === 0
                ? 'Add your services and callers will be able to pick one and get a price.'
                : 'We’re texting back everyone who calls while you’re on a job.'}
            </div>
          </span>
        </div>
      ) : (
        <div className="notice notice-warn">
          <strong>
            {summary.needsAttention} {summary.needsAttention === 1 ? 'lead needs' : 'leads need'} you.
          </strong>
          <div>Someone asked something the system will not answer on your behalf.</div>
        </div>
      )}

      <div className="section-label">Your work</div>

      <div className="tiles">
        <Tile
          href="/leads?filter=attention"
          icon="!"
          title="Needs you"
          note={summary.needsAttention === 0 ? 'Nothing waiting on you.' : 'Read these first.'}
          count={summary.needsAttention}
          urgent={summary.needsAttention > 0}
        />
        <Tile
          href="/leads"
          icon="☰"
          title="Open leads"
          note={summary.openLeads === 0 ? 'Nothing open right now.' : 'Not yet won or lost.'}
          count={summary.openLeads}
        />
        <Tile
          href="/leads?filter=QUOTED"
          icon="$"
          title="Quoted"
          note="Waiting on the customer."
          count={summary.quoted}
        />
        <Tile
          href="/leads?filter=WON"
          icon="✓"
          title="Won this week"
          note={
            summary.wonThisWeek.count === 0
              ? 'No jobs marked won yet.'
              : summary.wonThisWeek.valueCents === null
                ? 'Add what they were worth.'
                : `${money(summary.wonThisWeek.valueCents)} of work.`
          }
          count={summary.wonThisWeek.count}
        />
        <Tile
          href="/settings/services"
          icon="⚙"
          title="Services"
          note={
            active === 0
              ? 'None yet — callers are asked to describe the job.'
              : `Callers pick from ${active} of ${MAX_ACTIVE_SERVICES}.`
          }
          count={active}
        />
        <Tile
          href="/settings/import"
          icon="⇪"
          title="Import"
          note={
            active === 0
              ? 'Read your services out of a price list.'
              : 'Add more from a document.'
          }
        />
        <Tile
          href="/settings/knowledge"
          icon="?"
          title="Answers"
          note="Common questions, answered instantly."
        />
        <Tile
          icon="✉"
          title="Reply yourself"
          note="Text a customer from here."
          soon
        />
      </div>

      {recent.length > 0 ? (
        <>
          <div className="row-between">
            <div className="section-label">Latest</div>
            <Link className="btn btn-quiet" href="/leads">See all</Link>
          </div>
          {recent.map((lead) => (
            <Link className="card" key={lead.id} href={`/leads/${lead.id}`}>
              <div className="row-between">
                <strong>{lead.customer.name ?? 'Caller'}</strong>
                {lead.needsHuman ? <span className="badge badge-attention">Needs you</span> : null}
              </div>
              <div className="muted">
                {lead.service?.name ?? lead.serviceType ?? 'Service not yet known'}
                {lead.suburb ? ` · ${lead.suburb}` : ''}
              </div>
            </Link>
          ))}
        </>
      ) : null}
    </>
  );
}

export default function HubPage() {
  return (
    <AppShell>
      <Hub />
    </AppShell>
  );
}
