import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Missed Enquiry Recovery',
  description: 'Recover the customers you miss when you cannot answer the phone.',
};

// The owner arrives from an SMS, on a phone, outdoors, one-handed
// (.claude/skills/frontend/SKILL.md). Mobile is the design target, not a breakpoint.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // No maximumScale / user-scalable=no: pinch-zoom is an accessibility need, and
  // disabling it on a screen people read in sunlight is a bad trade.
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-AU">
      <body>{children}</body>
    </html>
  );
}
