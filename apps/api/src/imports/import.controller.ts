import {
  BadRequestException, Body, ConflictException, Controller, Post, UploadedFile, UseFilters,
  UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Min,
  ValidateNested,
} from 'class-validator';
import { memoryStorage } from 'multer';
import { MAX_KNOWLEDGE_ENTRIES, MAX_SERVICE_NAME_CHARS } from 'shared-types';
import type { AuthenticatedSession } from '../auth/auth.service';
import { Session, SessionGuard } from '../auth/session.guard';
import { MAX_IMPORT_CHARS } from '../conversations/llm.provider';
import { CatalogueValidationFilter } from '../services/catalogue-validation.filter';
import { ImportService } from './import.service';

/**
 * Document import over HTTP.
 *
 * Three routes, and the split between them is the design: **`propose` reads and returns,
 * `apply` writes.** Nothing is stored in between, so the rows that get saved are the rows
 * the owner actually read and edited — not a server-side draft that could have drifted
 * from what the review screen showed them.
 *
 * Like every other authenticated controller here, the tenant comes from `@Session()` and
 * there is no `businessId` parameter anywhere in the file (rule 1).
 */

/** 10 MB. A text-layer price list is tens of kilobytes; past this it is scans or photos,
 *  which we cannot read anyway and which would be refused a step later with a better
 *  message. Rejecting at the edge keeps a large upload from being buffered at all. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

class ImportTextDto {
  // Generous relative to `MAX_IMPORT_CHARS` on purpose: this is the shape guard that
  // stops an absurd payload being parsed at all, while `assertImportable` produces the
  // message the owner actually reads, with the real limit in it.
  @IsString() @MaxLength(MAX_IMPORT_CHARS * 2)
  text!: string;
}

/**
 * A service as the review screen submits it.
 *
 * Deliberately narrower than `ServiceBodyDto` in the services controller. Import offers
 * the owner name, description, pricing and the show-price tick — not aliases, required
 * fields or unit bounds. Accepting fields the screen never shows would mean validating a
 * contract nothing produces.
 */
class ApprovedServiceDto {
  @IsString() @MaxLength(MAX_SERVICE_NAME_CHARS * 2)
  name!: string;

  @IsOptional() @IsString() @MaxLength(500)
  description?: string;

  @IsIn(['FIXED', 'STARTING_FROM', 'PER_UNIT', 'MANUAL_QUOTE'])
  pricingType!: 'FIXED' | 'STARTING_FROM' | 'PER_UNIT' | 'MANUAL_QUOTE';

  // Integer cents, AUD (rule 11).
  @IsOptional() @IsInt() @Min(0)
  priceCents?: number | null;

  @IsOptional() @IsString() @MaxLength(24)
  unitLabel?: string | null;

  /**
   * The owner's explicit "customers may hear this price".
   *
   * Optional here and re-derived in `ImportService.apply` as `=== true`, so an absent,
   * null or string value can only ever mean off. This is the one field where a
   * client-side mistake would put an unreviewed figure in front of a caller.
   */
  @IsOptional() @IsBoolean()
  showPriceAutomatically?: boolean;
}

class ApprovedKnowledgeDto {
  @IsString() @MaxLength(400)
  question!: string;

  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(8)
  aliases?: string[];

  @IsString() @MaxLength(1000)
  answer!: string;

  @IsOptional() @IsString() @MaxLength(400)
  sourceExcerpt?: string;
}

class ImportApplyDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => ApprovedServiceDto)
  // A document proposing more than this is a parse failure, not a catalogue.
  @ArrayMaxSize(30)
  services!: ApprovedServiceDto[];

  @IsArray() @ValidateNested({ each: true }) @Type(() => ApprovedKnowledgeDto)
  @ArrayMaxSize(MAX_KNOWLEDGE_ENTRIES)
  knowledge!: ApprovedKnowledgeDto[];
}

@Controller('import')
@UseGuards(SessionGuard)
@UseFilters(CatalogueValidationFilter)
export class ImportController {
  /**
   * Businesses with an import already running.
   *
   * **This is a cost guard, not a correctness one.** These are the only two routes in the
   * application that spend money per request, and the likeliest way to spend it twice is
   * the owner clicking "Import" again because the first one is taking eight seconds. A
   * second call while one is in flight is refused rather than queued.
   *
   * Held in memory, so it is per-process: with more than one API instance a determined
   * double-click could still get through. That is an honest limit of a ten-line guard and
   * it is the right size for a pilot — the real ceiling is a per-business daily spend cap,
   * which belongs with the other circuit breakers, not here.
   */
  private readonly running = new Set<string>();

  constructor(private readonly imports: ImportService) {}

  /**
   * Read an uploaded PDF. **Writes nothing.**
   *
   * `memoryStorage` is explicit rather than left to multer's default, because "the
   * document never touches disk" is a property of this feature rather than an
   * implementation detail — an upstream default changing would turn every customer's
   * handbook into a file in a temp directory with nothing to clean it up.
   */
  @Post('document')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    }),
  )
  async fromDocument(
    @Session() session: AuthenticatedSession,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) throw new BadRequestException('No file was uploaded.');
    return this.withLock(session.businessId, async () => {
      const text = await this.imports.readPdf(file.buffer);
      return this.imports.propose(text);
    });
  }

  /**
   * Read pasted text. **Writes nothing.**
   *
   * Not a fallback — it is the path that works when the PDF is a scan, when the price
   * list lives in an email, and when the owner only wants three pages of an eighty-page
   * handbook read. Every error message on the document route points here.
   */
  @Post('text')
  async fromText(@Session() session: AuthenticatedSession, @Body() body: ImportTextDto) {
    return this.withLock(session.businessId, () => this.imports.propose(body.text));
  }

  /**
   * Save what the owner approved.
   *
   * No lock: this one is cheap, and it goes through the same catalogue validation as the
   * form, so a duplicate submission fails on duplicate names rather than silently
   * doubling the catalogue.
   */
  @Post('apply')
  async apply(@Session() session: AuthenticatedSession, @Body() body: ImportApplyDto) {
    return this.imports.apply(session.businessId, {
      services: body.services,
      knowledge: body.knowledge.map((entry) => ({
        question: entry.question,
        aliases: entry.aliases ?? [],
        answer: entry.answer,
        sourceExcerpt: entry.sourceExcerpt,
      })),
    });
  }

  private async withLock<T>(businessId: string, run: () => Promise<T>): Promise<T> {
    if (this.running.has(businessId)) {
      throw new ConflictException('An import is already running. Give it a moment.');
    }
    this.running.add(businessId);
    try {
      return await run();
    } finally {
      // `finally`, not after a successful return: a failed import that never released the
      // lock would leave the owner unable to retry, which is worse than the double spend
      // this is guarding against.
      this.running.delete(businessId);
    }
  }
}
