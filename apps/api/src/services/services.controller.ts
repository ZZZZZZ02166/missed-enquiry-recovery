import {
  Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, UseFilters, UseGuards,
} from '@nestjs/common';
import {
  ArrayMaxSize, ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString,
  MaxLength, Min,
} from 'class-validator';
import { MAX_ACTIVE_SERVICES, MAX_SERVICE_NAME_CHARS } from 'shared-types';
import { Session, SessionGuard } from '../auth/session.guard';
import type { AuthenticatedSession } from '../auth/auth.service';
import { CatalogueValidationFilter } from './catalogue-validation.filter';
import { ServicesService } from './services.service';

/**
 * The owner's catalogue over HTTP.
 *
 * Every route is guarded and every one takes its tenant from `@Session()`. There is no
 * `businessId` parameter anywhere in this file, which is the point — rule 1 is not a
 * convention you remember here, it is the only tenant available.
 */

const PRICING_TYPES = ['FIXED', 'STARTING_FROM', 'PER_UNIT', 'MANUAL_QUOTE'] as const;
const AVAILABILITIES = ['ACTIVE', 'DISABLED', 'TEMPORARILY_UNAVAILABLE'] as const;

/**
 * Shape only. The *rules* — duplicate names, the six-active ceiling, currency in a name,
 * a `FIXED` service with no price — live in `shared-types` and run in the service layer,
 * because they need the whole catalogue and because the dashboard runs the identical
 * check before it ever posts.
 */
class ServiceBodyDto {
  @IsString() @MaxLength(MAX_SERVICE_NAME_CHARS * 2)
  name!: string;

  @IsOptional() @IsString() @MaxLength(500)
  description?: string;

  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(20)
  aliases?: string[];

  @IsIn(PRICING_TYPES)
  pricingType!: (typeof PRICING_TYPES)[number];

  // Integer cents, AUD (rule 11). Never a float — a price that arrives as 70.00000001 is
  // a rounding argument with a customer six months later.
  @IsOptional() @IsInt() @Min(0)
  priceCents?: number | null;

  @IsOptional() @IsString() @MaxLength(24)
  unitLabel?: string | null;

  @IsOptional() @IsInt() @Min(0)
  minUnits?: number | null;

  @IsOptional() @IsInt() @Min(0)
  maxUnits?: number | null;

  @IsOptional() @IsBoolean()
  showPriceAutomatically?: boolean;

  @IsOptional() @IsIn(['FIRM', 'ESTIMATE'])
  priceConfidence?: 'FIRM' | 'ESTIMATE';

  @IsOptional() @IsBoolean()
  requiresConfirmation?: boolean;

  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(20)
  requiredFields?: string[];

  @IsOptional() @IsIn(AVAILABILITIES)
  availability?: (typeof AVAILABILITIES)[number];
}

class AvailabilityDto {
  @IsIn(AVAILABILITIES)
  availability!: (typeof AVAILABILITIES)[number];
}

class ReorderDto {
  @IsArray() @ArrayNotEmpty() @IsString({ each: true })
  // Generous relative to `MAX_ACTIVE_SERVICES` because inactive services are unlimited
  // and they are reordered too.
  @ArrayMaxSize(MAX_ACTIVE_SERVICES * 20)
  orderedIds!: string[];
}

@Controller('services')
@UseGuards(SessionGuard)
@UseFilters(CatalogueValidationFilter)
export class ServicesController {
  constructor(private readonly services: ServicesService) {}

  @Get()
  list(@Session() session: AuthenticatedSession) {
    return this.services.list(session.businessId);
  }

  @Get(':id')
  get(@Session() session: AuthenticatedSession, @Param('id') id: string) {
    return this.services.get(session.businessId, id);
  }

  @Post()
  create(@Session() session: AuthenticatedSession, @Body() body: ServiceBodyDto) {
    return this.services.create(session.businessId, body);
  }

  @Patch(':id')
  update(
    @Session() session: AuthenticatedSession,
    @Param('id') id: string,
    @Body() body: Partial<ServiceBodyDto>,
  ) {
    return this.services.update(session.businessId, id, body);
  }

  /**
   * Turn a service on or off.
   *
   * Its own route because it is the one an owner uses most, and because it is where the
   * six-active ceiling bites — a dedicated endpoint means the dashboard's toggle gets a
   * 422 naming the limit rather than a generic save failure.
   */
  @Patch(':id/availability')
  setAvailability(
    @Session() session: AuthenticatedSession,
    @Param('id') id: string,
    @Body() body: AvailabilityDto,
  ) {
    return this.services.setAvailability(session.businessId, id, body.availability);
  }

  /**
   * Remove a service.
   *
   * Returns `{ deleted }` so the dashboard can say what actually happened: a service with
   * leads against it is disabled rather than deleted, and telling the owner "deleted"
   * when the row is still there is how trust in an interface goes.
   */
  @Delete(':id')
  remove(@Session() session: AuthenticatedSession, @Param('id') id: string) {
    return this.services.remove(session.businessId, id);
  }

  /** The whole list, in order. See `ServicesService.reorder` for why not one at a time. */
  @Put('order')
  @HttpCode(200)
  reorder(@Session() session: AuthenticatedSession, @Body() body: ReorderDto) {
    return this.services.reorder(session.businessId, body.orderedIds);
  }

  /** Onboarding only. Refuses when a catalogue already exists. */
  @Post('seed-defaults')
  seedDefaults(@Session() session: AuthenticatedSession) {
    return this.services.seedDefaults(session.businessId);
  }
}
