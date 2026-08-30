import { redirect } from 'next/navigation';

/**
 * Nobody types this URL.
 *
 * The owner arrives from an SMS on the API's `/auth/callback`, which sets the session and
 * redirects to a specific lead. This exists so the bare domain lands on the hub rather
 * than a placeholder.
 */
export default function Home() {
  redirect('/hub');
}
