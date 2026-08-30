'use client';

import { Suspense, useState } from 'react';
import { api } from '@/lib/api';

/**
 * Ask for a magic link.
 *
 * **Says the same thing whichever address is typed.** The API deliberately answers
 * identically for a real and an unknown account — a "no such user" message would be an
 * enumeration oracle, and this product's customers are listed on Google Maps with their
 * business email. The UI has to hold that line too, or the API's care is wasted.
 */
function SignInForm() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api.post('/auth/request-link', { email });
    } catch {
      // Even a failure shows the same confirmation. A visible error here would leak
      // whether the address exists just as surely as a message saying so.
    } finally {
      setSent(true);
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="card">
        <h1>Check your messages</h1>
        <p className="muted" style={{ marginTop: '0.5rem' }}>
          If that address belongs to an account, a sign-in link is on its way. It works once
          and expires in 15 minutes.
        </p>
      </div>
    );
  }

  return (
    <form className="card" onSubmit={submit}>
      <h1>Sign in</h1>
      <p className="muted" style={{ margin: '0.5rem 0 1rem' }}>
        We will send you a link. There is no password to remember.
      </p>
      <div className="field">
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@yourbusiness.com.au"
        />
      </div>
      <button className="btn btn-primary" style={{ marginTop: '0.8rem' }} disabled={busy}>
        {busy ? 'Sending…' : 'Send me a link'}
      </button>
    </form>
  );
}

export default function SignInPage() {
  return (
    <main className="page">
      <Suspense fallback={null}>
        <SignInForm />
      </Suspense>
    </main>
  );
}
