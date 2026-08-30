import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ServicesController } from './services.controller';
import { ServicesService } from './services.service';

/**
 * The service catalogue.
 *
 * Imports `AuthModule` for `SessionGuard`. Exports `ServicesService` because onboarding
 * will need `seedDefaults`, and because the conversation flow reads the catalogue — today
 * it does that with its own query in the inbound processor, which is a duplication worth
 * collapsing once there is a second reader.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [ServicesController],
  providers: [ServicesService],
  exports: [ServicesService],
})
export class ServicesModule {}
