import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { CatalogueValidationError, KnowledgeValidationError } from 'shared-types';

/**
 * Turns a `CatalogueValidationError` into a 422 the dashboard can render.
 *
 * **422 with the issue array intact, not a 400 with a joined string.** Every issue
 * carries a `code`, an owner-readable `message`, and the row it belongs to — so the form
 * can attach "You already have a service called Deep cleaning" to the offending field
 * instead of showing one generic banner and making the owner hunt.
 *
 * The alternative — flattening to a single message — is why so many settings screens
 * make you save five times to find five problems. `validateCatalogue` deliberately
 * returns *every* issue for exactly this reason, and throwing that away at the HTTP
 * boundary would waste it.
 *
 * **It catches the knowledge error too.** `KnowledgeValidationError` carries the same
 * `issues` shape for the same reason, and its issues reach the owner through the same
 * kind of form. A second near-identical filter would be two places to keep a response
 * contract in step, for no gain — the only difference is which id a row carries, and both
 * are emitted so a client can bind whichever it has.
 */
@Catch(CatalogueValidationError, KnowledgeValidationError)
export class CatalogueValidationFilter implements ExceptionFilter {
  catch(error: CatalogueValidationError | KnowledgeValidationError, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(422)
      .json({
        statusCode: 422,
        error: error instanceof KnowledgeValidationError ? 'Answers are invalid' : 'Catalogue is invalid',
        // The shape the dashboard binds to. Stable field names matter more here than
        // brevity — this is a contract with a form.
        issues: error.issues.map((issue) => ({
          code: issue.code,
          message: issue.message,
          serviceId: 'serviceId' in issue ? (issue.serviceId ?? null) : null,
          entryId: 'entryId' in issue ? (issue.entryId ?? null) : null,
          index: issue.index ?? null,
        })),
      });
  }
}
