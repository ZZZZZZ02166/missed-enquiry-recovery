'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, UnauthenticatedError, type Session } from '@/lib/api';

/**
 * The authenticated frame around every owner-facing page.
 *
 * Resolves the session once so each page inside can assume it is authenticated, rather
 * than every screen re-deciding what a 401 means.
 *
 * **Renders nothing until the session is known.** A flash of the inbox before a redirect
 * looks like a bug and, on a shared phone, briefly shows a customer's name and number to
 * someone who should not see them.
 *
 * The navigation is a **fixed rail on desktop and a bottom bar on a phone** — same
 * markup, one media query. The bar is at the bottom because the owner is holding the
 * phone one-handed and the top of a modern screen is out of thumb reach.
 */

/**
 * The rail, in two halves.
 *
 * **Hub and Leads are the daily work; the rest is what the system knows about the
 * business.** Splitting them matters more than it looks: an owner opens this app to deal
 * with a lead, and three settings screens sitting flat alongside that make the two look
 * like equal choices. The group label says "these are set up once" without a word of
 * instruction.
 *
 * The label is desktop-only. On the phone bottom bar there is no room for it and no need
 * — five icons in a row read fine, and a heading in a thumb bar would just eat the space
 * the tap targets need.
 */
type NavItem = { href: string; icon: string; label: string } | { group: string };

const NAV: NavItem[] = [
  { href: '/hub', icon: '◆', label: 'Hub' },
  { href: '/leads', icon: '☰', label: 'Leads' },
  { group: 'Set up' },
  { href: '/settings/services', icon: '⚙', label: 'Services' },
  { href: '/settings/knowledge', icon: '?', label: 'Answers' },
  // Import earns a place of its own rather than living as a tile on the hub. It is the
  // fastest route from "nothing configured" to a working catalogue, and a screen that
  // only exists behind another screen is one most owners never find.
  { href: '/settings/import', icon: '⇪', label: 'Import' },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [checked, setChecked] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    let live = true;
    api
      .get<Session>('/auth/me')
      .then((s) => { if (live) setSession(s); })
      .catch((error: unknown) => {
        if (!live) return;
        if (error instanceof UnauthenticatedError) {
          router.replace(`/signin?next=${encodeURIComponent(pathname)}`);
          return;
        }
        // A network failure is not a logout. Sending them to sign in would be a lie, and
        // signing in again would not fix it.
        setSession(null);
      })
      .finally(() => { if (live) setChecked(true); });
    return () => { live = false; };
  }, [router, pathname]);

  if (!checked) return null;

  if (!session) {
    return (
      <main className="page">
        <div className="notice notice-error">
          Could not reach the server. Check your connection and reload.
        </div>
      </main>
    );
  }

  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        {NAV.map((item) =>
          'group' in item ? (
            // Presentational only. It is not a heading element because it labels nothing
            // a screen reader can scope to, and announcing it would interrupt a list of
            // links with a word that adds nothing when heard one item at a time.
            <span className="rail-group" key={item.group} aria-hidden="true">
              {item.group}
            </span>
          ) : (
            <Link
              key={item.href}
              href={item.href}
              aria-current={
                pathname === item.href || (item.href !== '/hub' && pathname.startsWith(item.href))
                  ? 'page'
                  : undefined
              }
            >
              <span className="rail-icon" aria-hidden="true">{item.icon}</span>
              {item.label}
            </Link>
          ),
        )}
      </nav>
      <main className="page">{children}</main>
    </div>
  );
}
