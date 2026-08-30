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

const NAV = [
  { href: '/hub', icon: '◆', label: 'Hub' },
  { href: '/leads', icon: '☰', label: 'Leads' },
  { href: '/settings/services', icon: '⚙', label: 'Services' },
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
        {NAV.map((item) => (
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
        ))}
      </nav>
      <main className="page">{children}</main>
    </div>
  );
}
