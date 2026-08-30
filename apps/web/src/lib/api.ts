/**
 * The one place the dashboard talks to the API.
 *
 * Everything goes through here so that three things are decided once rather than at
 * every call site: credentials, what a 401 means, and how a 422 from the catalogue rules
 * reaches a form.
 *
 * **Client-side fetch, deliberately.** The API is a separate origin with a cookie session
 * on the shared registrable domain (D9), and `main.ts` already sets CORS to that exact
 * origin with `credentials: true`. Fetching from a server component instead would mean
 * manually forwarding the browser's cookie on every request — more code, and one
 * forgotten header is a page that silently renders as logged out.
 */

/**
 * Injected by `next.config.ts` from `PUBLIC_API_URL` — see the comment there for why it
 * is derived rather than read from a variable of its own.
 */
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3101';

/**
 * A 401 from any call.
 *
 * Thrown rather than redirected from inside the client, because a fetch helper that
 * navigates is a fetch helper you cannot test and cannot use during render. The pages
 * decide what to do with it — which is always the same thing, but visibly so.
 */
export class UnauthenticatedError extends Error {
  constructor() {
    super('Not authenticated');
    this.name = 'UnauthenticatedError';
  }
}

/** One issue from the shared catalogue rules, as the 422 body carries it. */
export interface ApiIssue {
  code: string;
  message: string;
  serviceId: string | null;
  index: number | null;
}

/**
 * A 422 carrying the catalogue rules' own issue list.
 *
 * Kept structured all the way to the form. The API deliberately returns *every* issue
 * rather than the first, and flattening them to a string here would throw that away and
 * put us back to one problem per save.
 */
export class ValidationError extends Error {
  constructor(readonly issues: ApiIssue[]) {
    super(issues.map((i) => i.message).join(' '));
    this.name = 'ValidationError';
  }

  /** Issues for one row of a form, by service id. */
  forService(serviceId: string | null): ApiIssue[] {
    return this.issues.filter((i) => i.serviceId === serviceId);
  }

  /** Issues that belong to the catalogue as a whole, not to one service. */
  get general(): ApiIssue[] {
    return this.issues.filter((i) => i.serviceId === null && i.index === null);
  }
}

/** Any other non-2xx. Carries the status so a caller can tell 404 from 500. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      ...init,
      // The whole session mechanism. Without it the cookie is not sent cross-origin and
      // every call is anonymous — which looks exactly like being logged out.
      credentials: 'include',
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch {
    // A network failure and a 500 are different things to a person: one says "check your
    // signal", the other says "we broke it". Status 0 marks the former.
    throw new ApiError(0, 'Could not reach the server. Check your connection and try again.');
  }

  if (response.status === 401) throw new UnauthenticatedError();

  if (response.status === 422) {
    const body = (await response.json().catch(() => ({}))) as { issues?: ApiIssue[] };
    throw new ValidationError(body.issues ?? []);
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(response.status, body.message ?? `Request failed (${response.status})`);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

// ---------------------------------------------------------------------------
// Response shapes.
//
// Hand-written rather than generated, and narrow on purpose: the dashboard reads a
// fraction of what the API returns, and declaring only that fraction means a column
// added to `leads` does not silently become part of this contract.
// ---------------------------------------------------------------------------

export interface Session {
  userId: string;
  businessId: string;
}

export type LeadStatus = 'NEW' | 'QUALIFYING' | 'QUALIFIED' | 'QUOTED' | 'WON' | 'LOST';
export type QuoteType = 'FIXED' | 'ESTIMATE' | 'FROM' | 'NONE';

export interface LeadSummary {
  id: string;
  status: LeadStatus;
  needsHuman: boolean;
  serviceType: string | null;
  suburb: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  preferredDate: string | null;
  quotedAmountCents: number | null;
  quoteType: QuoteType;
  quoteShownToCustomer: boolean;
  wonValueCents: number | null;
  createdAt: string;
  customer: { name: string | null; phoneE164: string };
  service: { name: string } | null;
}

export interface LeadMessage {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  body: string;
  status: string;
  purpose: string | null;
  createdAt: string;
}

export interface LeadDetail extends LeadSummary {
  needsHumanReason: string | null;
  lostReason: string | null;
  carpetedRooms: number | null;
  missingFields: string[];
  quotedAt: string | null;
  messages: LeadMessage[];
  conversation: { id: string; state: string; questionsAsked: number } | null;
}

export interface LeadPage {
  leads: LeadSummary[];
  nextCursor: string | null;
}

export type PricingType = 'FIXED' | 'STARTING_FROM' | 'PER_UNIT' | 'MANUAL_QUOTE';
export type Availability = 'ACTIVE' | 'DISABLED' | 'TEMPORARILY_UNAVAILABLE';

export interface ServiceRow {
  id: string;
  name: string;
  description: string | null;
  pricingType: PricingType;
  priceCents: number | null;
  unitLabel: string | null;
  minUnits: number | null;
  maxUnits: number | null;
  showPriceAutomatically: boolean;
  priceConfidence: 'FIRM' | 'ESTIMATE';
  requiresConfirmation: boolean;
  availability: Availability;
  sortOrder: number;
}
