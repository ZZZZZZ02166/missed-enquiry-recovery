import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

// Global: every feature module needs the database, and re-importing PrismaModule
// in each one is noise. This is the exception to "no global modules", not a pattern
// to copy — a global module hides its dependency edges, which is only acceptable
// for something genuinely used everywhere.
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
