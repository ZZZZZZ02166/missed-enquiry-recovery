import { Inject, Injectable, Logger } from '@nestjs/common';
import { SuppressionsService } from '../../calls/suppressions.service';
import { env } from '../../config/env';
import { toNationalDisplay } from '../../common/phone';
import { AuthService } from '../../auth/auth.service';
import { MAX_OWNER_SEGMENTS, ownerLeadMessage } from '../../notifications/templates';
import { PrismaService } from '../../prisma/prisma.service';
import { SendCapService } from '../../telephony/send-cap.service';
import { PermanentSendError, SMS_PROVIDER, type SmsProvider } from '../../telephony/sms.provider';
import type { NotifyOwnerJobData } from '../queues';

/**
 * Texts the structured lead to the owner.
 *
 * The point of the whole product. Everything before this produces a record; this is
 * the step that puts it in someone's hand inside a minute, which is the difference
 * between a lead and a row in a table the owner never looks at.
 *
 * `ownerNotifiedAt` is both the idempotency key and the outbox marker — the same
 * pattern as `messages.processingStatus`. A lead with a null value and a qualified
 * status is work that has not been delivered, and the maintenance sweep re-drives it.
 */

@Injectable()
export class NotifyOwnerProcessor {
  private readonly logger = new Logger(NotifyOwnerProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly suppressions: SuppressionsService,
    private readonly sendCap: SendCapService,
    private readonly auth: AuthService,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
  ) {}

  async process(data: NotifyOwnerJobData): Promise<void> {
    const { leadId, businessId } = data;

    const lead = await this.prisma.db.lead.findFirst({
      where: { businessId, id: leadId },
      include: {
        business: { select: { name: true, notifyPhoneE164: true } },
        customer: { select: { phoneE164: true, name: true } },
      },
    });

    if (!lead) {
      this.logger.warn(`Notify job for unknown lead ${leadId} — dropping`);
      return;
    }

    // Idempotency. Texting an owner the same lead twice is the kind of thing that
    // gets a product switched off, and a retried or re-swept job must not do it.
    if (lead.ownerNotifiedAt) {
      this.logger.debug(`Lead ${leadId} already notified — skipping`);
      return;
    }

    const ownerPhone = lead.business.notifyPhoneE164;
    if (!ownerPhone) {
      // Not retryable, and not the job's fault. Left un-notified deliberately: the
      // moment someone configures a number, the sweep delivers the backlog.
      this.logger.error(
        `Business ${businessId} has no notifyPhoneE164 — lead ${leadId} cannot be delivered. ` +
          'The owner is receiving nothing at all; this is a setup gap, not a send failure.',
      );
      return;
    }

    // The owner's own number can end up suppressed — they replied STOP to their own
    // system, or it was blocked by mistake. Honouring it is not optional, but it does
    // mean the product is silently off for them, so it is logged as an error rather
    // than a routine skip.
    const suppressed = await this.suppressions.isSuppressed(businessId, ownerPhone);
    if (suppressed) {
      this.logger.error(
        `Owner number ${ownerPhone} for business ${businessId} is suppressed (${suppressed}) — ` +
          'lead notifications are not being delivered to them.',
      );
      return;
    }

    // Owner notifications draw on the same allowance as customer messages; they cost
    // the same. Left un-notified so the sweep retries once the window rolls.
    const cap = await this.sendCap.check(businessId);
    if (!cap.allowed) {
      this.logger.warn(`Not notifying owner of lead ${leadId} — ${cap.detail}`);
      return;
    }

    const from = await this.smsNumberFor(businessId);
    if (!from) {
      // Throwing makes this retry, which is right: a number mid-provisioning will
      // appear, and the job staying visible in the failed set is better than silence.
      throw new Error(`Business ${businessId} has no ACTIVE SMS number; cannot notify owner`);
    }

    const body = ownerLeadMessage({
      serviceType: lead.serviceType,
      // The name the conversation learned, falling back to whatever the customer
      // record already had.
      customerName: lead.customer.name,
      // National format: the owner reads this on a lock screen and dials it.
      customerPhoneDisplay: toNationalDisplay(lead.customer.phoneE164) ?? lead.customer.phoneE164,
      suburb: lead.suburb,
      bedrooms: lead.bedrooms,
      bathrooms: lead.bathrooms,
      carpetedRooms: lead.carpetedRooms,
      preferredDate: lead.preferredDate,
      needsHuman: lead.needsHuman,
      needsHumanReason: lead.needsHumanReason,
      missingFields: lead.missingFields,
      magicLink: await this.magicLinkFor(businessId, lead.id),
    });

    await this.send(lead.id, businessId, from, ownerPhone, body);
  }

  /**
   * A one-time login that lands the owner on this lead.
   *
   * **Never throws.** A failure here must not cost the owner their lead: the name, the
   * number and the job details are what win the work, and a text without a link is worth
   * far more than no text at all. So a missing user, a database hiccup or a
   * misconfiguration degrades the message rather than failing the job — which would
   * otherwise retry, and keep failing, on a business that has no user row yet.
   *
   * Picks the oldest user of the business. Every pilot business has exactly one, and
   * per-user routing is an additive change for when staff invitations land — the same
   * reasoning that put `notifyPhoneE164` on `businesses` rather than on `users`.
   *
   * The link is minted fresh on every notification and overwrites any previous one. That
   * is deliberate: the owner's most recent lead text always works, and older texts stop
   * working, which is the right trade for a credential sitting in a message history.
   */
  private async magicLinkFor(businessId: string, leadId: string): Promise<string | null> {
    try {
      const user = await this.prisma.db.user.findFirst({
        where: { businessId },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });

      if (!user) {
        this.logger.warn(
          `Business ${businessId} has no user, so the lead SMS carries no link. ` +
            'The lead still sends.',
        );
        return null;
      }

      return await this.auth.mintLinkForUser(user.id, `/leads/${leadId}`);
    } catch (error) {
      this.logger.error(
        `Could not mint a magic link for lead ${leadId}: ` +
          `${error instanceof Error ? error.message : String(error)}. Sending without one.`,
      );
      return null;
    }
  }

  /**
   * Send, record, then mark notified.
   *
   * Marked **after** the provider accepts it, not before. The alternative — claim the
   * lead first, then send — would prevent a rare duplicate at the cost of losing the
   * notification entirely if the process died in between. A duplicate lead text is
   * mildly annoying; a lead the owner is never told about is a lost job, and the
   * deterministic job id already collapses concurrent attempts.
   */
  private async send(
    leadId: string,
    businessId: string,
    from: string,
    to: string,
    body: string,
  ): Promise<void> {
    try {
      const result = await this.sms.sendSms({
        to,
        from,
        body,
        // The owner summary is legitimately longer than one segment — see
        // MAX_OWNER_SEGMENTS. The default of 1 is kept for every customer-facing
        // message, where a second segment means a template has drifted.
        maxSegments: MAX_OWNER_SEGMENTS,
        statusCallbackUrl: `${env.PUBLIC_API_URL}/webhooks/twilio/messages/status`,
      });

      await this.prisma.db.message.create({
        data: {
          businessId,
          // Null: this went to the owner, not to a customer. The column is nullable
          // for exactly this case.
          customerId: null,
          direction: 'OUTBOUND',
          status: 'QUEUED',
          purpose: 'OWNER_NOTIFICATION',
          fromE164: from,
          toE164: to,
          body,
          providerMessageSid: result.providerMessageSid,
          segments: result.segments,
          sentAt: new Date(),
        },
      });

      // Conditional, so a concurrent attempt that got there first is not overwritten
      // with a later timestamp.
      await this.prisma.db.lead.updateMany({
        where: { id: leadId, businessId, ownerNotifiedAt: null },
        data: { ownerNotifiedAt: new Date() },
      });

      this.logger.log(
        `Owner notified of lead ${leadId} (${result.segments} segment${result.segments === 1 ? '' : 's'})`,
      );
    } catch (error) {
      if (error instanceof PermanentSendError) {
        // Will fail identically on retry. Recorded so the failure is visible, and the
        // lead deliberately stays un-notified — someone has to look at it.
        this.logger.error(
          `Permanent failure notifying owner of lead ${leadId}: ${error.message}. ` +
            'The owner has not been told about this lead.',
        );
        await this.prisma.db.message.create({
          data: {
            businessId,
            customerId: null,
            direction: 'OUTBOUND',
            status: 'FAILED',
            purpose: 'OWNER_NOTIFICATION',
            fromE164: from,
            toE164: to,
            body,
            errorCode: error.code,
            errorMessage: error.message,
          },
        });
        if (error.code === 21610) await this.suppressions.optOut(businessId, to);
        return;
      }
      throw error;
    }
  }

  private async smsNumberFor(businessId: string): Promise<string | null> {
    const number = await this.prisma.db.phoneNumber.findFirst({
      where: { businessId, purpose: 'SMS_TWO_WAY', status: 'ACTIVE' },
      select: { e164: true },
    });
    return number?.e164 ?? null;
  }
}
