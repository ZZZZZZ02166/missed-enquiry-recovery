import Link from 'next/link';

/**
 * Where a link that did not work lands.
 *
 * **One page for every reason.** Expired, already used, and never existed are the same
 * message — telling them apart would tell someone probing tokens which of those they
 * achieved. The owner does not need to know either; they need a new link.
 */
export default function ExpiredPage() {
  return (
    <main className="page">
      <div className="card">
        <h1>That link has expired</h1>
        <p className="muted" style={{ margin: '0.5rem 0 1rem' }}>
          Sign-in links work once and last 15 minutes. Every lead text contains a fresh one,
          or you can request another.
        </p>
        <Link className="btn btn-primary" href="/signin">
          Send me a new link
        </Link>
      </div>
    </main>
  );
}
