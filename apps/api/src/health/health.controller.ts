import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness — the process is up. Deliberately touches nothing else. */
  @Get()
  live(): { status: string } {
    return { status: 'ok' };
  }

  /**
   * Readiness — dependencies are reachable.
   *
   * Kept separate from liveness on purpose: if the database blips, we want the
   * platform to stop routing traffic here, not to kill and restart the process.
   * A restart does not fix someone else's database.
   */
  @Get('ready')
  async ready(): Promise<{ status: string; database: string }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'ok' };
    } catch {
      return { status: 'degraded', database: 'unreachable' };
    }
  }
}
