import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Put, UseFilters, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength, ValidateNested,
} from 'class-validator';
import {
  assertKnowledgeValid, readKnowledge, MAX_KNOWLEDGE_ENTRIES, type KnowledgeEntry,
} from 'shared-types';
import type { AuthenticatedSession } from '../auth/auth.service';
import { Session, SessionGuard } from '../auth/session.guard';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogueValidationFilter } from '../services/catalogue-validation.filter';

/**
 * The answers the SMS flow replies with, as the owner maintains them.
 *
 * Lives beside import rather than in a `businesses` module because import is what creates
 * these and this is what corrects them — the two are one feature, and a `businesses`
 * module holding one column would be a folder pretending to be a boundary. It moves when
 * there is a second thing in it.
 */

class KnowledgeEntryDto {
  @IsOptional() @IsString() @MaxLength(64)
  id?: string;

  @IsString() @MaxLength(400)
  question!: string;

  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(8)
  aliases?: string[];

  @IsString() @MaxLength(1000)
  answer!: string;

  @IsOptional() @IsString() @MaxLength(400)
  sourceExcerpt?: string;
}

class ReplaceKnowledgeDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => KnowledgeEntryDto)
  // Generous relative to `MAX_KNOWLEDGE_ENTRIES`, which produces the message the owner
  // actually reads. This only stops an absurd payload being validated at all.
  @ArrayMaxSize(MAX_KNOWLEDGE_ENTRIES * 4)
  knowledge!: KnowledgeEntryDto[];
}

@Controller('knowledge')
@UseGuards(SessionGuard)
@UseFilters(CatalogueValidationFilter)
export class KnowledgeController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Everything stored, including entries that would no longer validate.
   *
   * `readKnowledge` drops what it cannot *read* but keeps what is merely invalid — an
   * over-long answer written before the limit existed still comes back, so the owner can
   * see it and fix it. A screen that silently hid an entry the SMS flow might still try
   * to send would be worse than one showing a row with an error on it.
   */
  @Get()
  async list(@Session() session: AuthenticatedSession): Promise<KnowledgeEntry[]> {
    const business = await this.prisma.db.business.findFirstOrThrow({
      where: { id: session.businessId },
      select: { knowledge: true },
    });
    return readKnowledge(business.knowledge);
  }

  /**
   * Replace the whole set.
   *
   * **The whole list, not one entry at a time**, for the same reason `PUT /services/order`
   * takes the whole list: the rules that matter here — no duplicate questions, no more
   * than forty — are properties of the set and cannot be checked against a single row. A
   * per-entry endpoint would validate each edit against a list it could not see.
   *
   * Ids are preserved when supplied and minted when not, so the screen can add a row
   * without inventing one.
   */
  @Put()
  async replace(
    @Session() session: AuthenticatedSession,
    @Body() body: ReplaceKnowledgeDto,
  ): Promise<KnowledgeEntry[]> {
    const entries: KnowledgeEntry[] = body.knowledge.map((entry) => ({
      id: entry.id && entry.id.length > 0 ? entry.id : randomUUID(),
      question: entry.question.trim(),
      aliases: (entry.aliases ?? []).map((a) => a.trim()).filter((a) => a.length > 0),
      answer: entry.answer.trim(),
      ...(entry.sourceExcerpt ? { sourceExcerpt: entry.sourceExcerpt } : {}),
    }));

    // Throws `KnowledgeValidationError`, which the filter turns into a 422 carrying every
    // issue — so a five-row mistake does not take five saves.
    assertKnowledgeValid(entries);

    await this.prisma.db.business.update({
      where: { id: session.businessId },
      data: { knowledge: entries as unknown as Prisma.InputJsonValue },
    });
    return entries;
  }
}
