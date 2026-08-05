/**
 * Everything both apps share.
 *
 * Kept to types and pure rules. Anything needing a database, a queue, an environment
 * variable or a Prisma client belongs in `apps/api` — the moment this package imports one
 * of those it stops being usable in the browser, which is half its purpose.
 */
export * from './service-catalogue';
