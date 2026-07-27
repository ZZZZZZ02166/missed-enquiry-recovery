/**
 * Placeholder root. The real entry point for an owner is `/l/[token]` — the magic
 * link in the lead SMS — which exchanges the token for a session and redirects to
 * the lead. Nobody navigates here by typing a URL.
 *
 * MVP routes still to build (.claude/skills/frontend/SKILL.md §4):
 *   /l/[token]           magic-link exchange
 *   /leads               inbox
 *   /leads/[id]          the screen that matters
 *   /settings/services   catalogue and pricing
 *   /settings/messages   templates, hours, after-hours
 */
export default function Home() {
  return (
    <main style={{ padding: '2rem', maxWidth: '40rem' }}>
      <h1>Missed Enquiry Recovery</h1>
      <p style={{ marginTop: '0.5rem' }}>
        Setup complete. No screens built yet — see <code>docs/codebase.md</code>.
      </p>
    </main>
  );
}
