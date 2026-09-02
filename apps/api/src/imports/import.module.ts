import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ServicesModule } from '../services/services.module';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';
import { KnowledgeController } from './knowledge.controller';

/**
 * Document import.
 *
 * The interesting line is `ConversationsModule`. Import is the one place a model is
 * called **inside an HTTP request** rather than on the worker, and that is a deliberate
 * exception to rule 8 rather than an oversight: rule 8 exists because Twilio times out
 * webhooks around fifteen seconds and a caller is waiting. Here the caller is an owner
 * who just pressed "Import" and is watching a spinner, there is no provider timeout to
 * beat, and the alternative — a job, a queue, a poll and a place to keep the result —
 * would need the import state that `ImportService` deliberately does not have.
 *
 * `ServicesModule` for `ServicesService.create`, so an approved row goes through exactly
 * the validation a hand-typed one does. `AuthModule` for `SessionGuard`. No exports:
 * nothing else in the application imports.
 *
 * `KnowledgeController` lives here too: import is what creates the answers and that
 * controller is what corrects them. One feature, one module.
 */
@Module({
  imports: [PrismaModule, AuthModule, ServicesModule, ConversationsModule],
  controllers: [ImportController, KnowledgeController],
  providers: [ImportService],
})
export class ImportModule {}
