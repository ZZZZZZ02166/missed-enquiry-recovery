import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import type { AuthenticatedSession } from '../auth/auth.service';
import { Session, SessionGuard } from '../auth/session.guard';
import { LeadsService, OWNER_SETTABLE_STATUSES } from './leads.service';

/**
 * The owner's inbox and the lead they land on from the SMS link.
 *
 * Two routes to read and one to record an outcome. There is no create and no delete: a
 * lead is produced by a customer replying, and deleting one would destroy the record of
 * a conversation that actually happened.
 */

const STATUSES = ['NEW', 'QUALIFYING', 'QUALIFIED', 'QUOTED', 'WON', 'LOST'] as const;

class ListQuery {
  @IsOptional() @IsIn(STATUSES)
  status?: (typeof STATUSES)[number];

  // Query strings are strings. Without the transform, `?needsHuman=false` is the
  // non-empty string "false", which is truthy — the exact bug the env parser avoids.
  @IsOptional() @IsBoolean()
  @Transform(({ value }) => (value === undefined ? undefined : value === 'true'))
  needsHuman?: boolean;

  @IsOptional() @IsString() @MaxLength(40)
  cursor?: string;

  @IsOptional() @IsInt() @Min(1) @Max(100)
  @Transform(({ value }) => (value === undefined ? undefined : Number.parseInt(String(value), 10)))
  limit?: number;
}

class OutcomeDto {
  /**
   * Only outcomes an owner owns. `NEW` and `QUALIFYING` belong to the conversation
   * engine, and letting a client set them would let the dashboard rewind a lead into a
   * state the state machine then disagrees with.
   */
  @IsOptional() @IsIn(OWNER_SETTABLE_STATUSES as readonly string[])
  status?: 'QUOTED' | 'WON' | 'LOST';

  /** Integer cents, AUD (rule 11). Stored only alongside WON. */
  @IsOptional() @IsInt() @Min(0)
  wonValueCents?: number | null;

  @IsOptional() @IsString() @MaxLength(200)
  lostReason?: string | null;

  /** Lets the owner clear the flag once they have dealt with whatever raised it. */
  @IsOptional() @IsBoolean()
  needsHuman?: boolean;
}

@Controller('leads')
@UseGuards(SessionGuard)
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Get()
  list(@Session() session: AuthenticatedSession, @Query() query: ListQuery) {
    return this.leads.list(session.businessId, query);
  }

  /**
   * The hub's counts.
   *
   * **Declared before `:id`, and that ordering is load-bearing.** Nest matches routes in
   * declaration order, so with `@Get(':id')` first this would arrive as a lead lookup for
   * an id of "summary" — a 404 that looks like a missing lead rather than a routing
   * mistake.
   */
  @Get('summary')
  summary(@Session() session: AuthenticatedSession) {
    return this.leads.summary(session.businessId);
  }

  /** The destination of the magic link in every lead SMS. */
  @Get(':id')
  get(@Session() session: AuthenticatedSession, @Param('id') id: string) {
    return this.leads.get(session.businessId, id);
  }

  @Patch(':id')
  setOutcome(
    @Session() session: AuthenticatedSession,
    @Param('id') id: string,
    @Body() body: OutcomeDto,
  ) {
    return this.leads.setOutcome(session.businessId, id, body);
  }
}
