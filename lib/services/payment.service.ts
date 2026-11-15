import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import { bookings, payments } from "@/db/schema";
import { err, ok, type Result } from "../result";
import type { BookingService, BookingView } from "./booking.service";
import type { IClock, ILogger, IPaymentGateway } from "../ports";

const paySchema = z.object({ bookingId: z.uuid(), userId: z.uuid(), idempotencyKey: z.uuid() });
export type PayInput = z.input<typeof paySchema>;
export type PaymentView = { paymentId: string; status: "succeeded"; booking: BookingView };

export class PaymentService {
  constructor(
    private db: Db,
    private clock: IClock,
    private gateway: IPaymentGateway,
    private bookings_: BookingService,
    private log: ILogger,
  ) {}

  async pay(input: PayInput): Promise<Result<PaymentView>> {
    const p = paySchema.safeParse(input);
    if (!p.success) return err("INVALID", p.error.issues[0]?.message ?? "invalid request");
    const { bookingId, userId, idempotencyKey } = p.data;

    const [booking] = await this.db.select().from(bookings).where(and(eq(bookings.id, bookingId), eq(bookings.userId, userId)));
    if (!booking) return err("NOT_FOUND", "booking not found");

    // Replay: the same key always yields the same outcome and never charges again.
    const [prior] = await this.db.select().from(payments).where(eq(payments.idempotencyKey, idempotencyKey));
    if (prior) {
      if (prior.bookingId !== bookingId) return err("CONFLICT", "idempotency key already used");
      if (prior.status === "succeeded") return this.succeeded(prior.id, bookingId, userId);
      if (prior.status === "failed") return err("PAYMENT_FAILED", prior.failureReason ?? "payment failed");
      if (prior.status === "refunded") return err("HOLD_EXPIRED", "the hold expired; your payment was refunded");
      return err("CONFLICT", "payment already in progress");
    }

    if (booking.status === "confirmed") return this.succeeded(null, bookingId, userId);
    if (booking.status === "expired") return err("HOLD_EXPIRED", "your hold expired");
    if (booking.status !== "pending") return err("CONFLICT", `booking is ${booking.status}`);
    const now = this.clock.now();
    if (!booking.holdExpiresAt || booking.holdExpiresAt <= now) return err("HOLD_EXPIRED", "your hold expired");

    // One active attempt per booking (business rule 4).
    const active = await this.db.select({ id: payments.id }).from(payments).where(and(eq(payments.bookingId, bookingId), eq(payments.status, "pending")));
    if (active.length > 0) return err("CONFLICT", "payment already in progress");

    let paymentId: string;
    try {
      const [row] = await this.db
        .insert(payments)
        .values({ bookingId, provider: this.gateway.name, idempotencyKey, amountCents: booking.totalCents, currency: booking.currency })
        .returning({ id: payments.id });
      paymentId = row!.id;
    } catch {
      return err("CONFLICT", "payment already in progress"); // lost an idempotency race
    }

    let charge;
    try {
      charge = await this.gateway.charge({ bookingId, amountCents: booking.totalCents, currency: booking.currency.trim(), idempotencyKey });
    } catch (e) {
      this.log.error({ err: (e as Error).message, bookingId }, "gateway threw");
      charge = { status: "failed" as const, reason: "gateway_error" };
    }

    if (charge.status === "failed") {
      await this.db.update(payments).set({ status: "failed", failureReason: charge.reason, providerPaymentId: charge.providerPaymentId ?? null, updatedAt: now }).where(eq(payments.id, paymentId));
      return err("PAYMENT_FAILED", charge.reason); // hold untouched: the user may retry with a new key
    }

    // Confirm only while the hold is still valid. This UPDATE and the sweeper's expiry predicate are mutually exclusive.
    const confirmedAt = this.clock.now();
    const confirmed = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.actor_id', ${userId}, true)`);
      const upd = await tx
        .update(bookings)
        .set({ status: "confirmed", confirmedAt, version: sql`${bookings.version} + 1`, updatedAt: confirmedAt })
        .where(and(eq(bookings.id, bookingId), eq(bookings.status, "pending"), gt(bookings.holdExpiresAt, confirmedAt)))
        .returning({ id: bookings.id });
      if (upd.length === 0) {
        await tx.update(payments).set({ status: "refunded", failureReason: "hold_expired", providerPaymentId: charge.providerPaymentId, updatedAt: confirmedAt }).where(eq(payments.id, paymentId));
        return false;
      }
      await tx.update(payments).set({ status: "succeeded", providerPaymentId: charge.providerPaymentId, updatedAt: confirmedAt }).where(eq(payments.id, paymentId));
      return true;
    });

    if (!confirmed) {
      await this.gateway.refund(charge.providerPaymentId).catch((e) => this.log.error({ err: (e as Error).message, paymentId }, "REFUND FAILED: needs manual review"));
      return err("HOLD_EXPIRED", "your hold expired while paying; the charge was refunded");
    }
    return this.succeeded(paymentId, bookingId, userId);
  }

  private async succeeded(paymentId: string | null, bookingId: string, userId: string): Promise<Result<PaymentView>> {
    const b = await this.bookings_.get(bookingId, userId);
    if (!b.ok) return b;
    return ok({ paymentId: paymentId ?? "", status: "succeeded", booking: b.value });
  }
}
