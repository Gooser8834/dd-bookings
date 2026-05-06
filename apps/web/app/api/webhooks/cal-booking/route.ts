import crypto from "node:crypto";
import { NextResponse, after } from "next/server";
import twilio from "twilio";

import prisma from "@calcom/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TZ = "America/Edmonton";
const ORGANIZER_NAME = "Kory";
const REBOOK_URL = "https://book.designer.digital/meet/discovery-call";
const BOOKING_BASE_URL = "https://book.designer.digital/booking";

type CalAttendee = {
  email: string;
  name?: string;
  phoneNumber?: string;
  timeZone?: string;
};

type CalPayload = {
  uid: string;
  bookingId?: number;
  type?: string;
  title?: string;
  startTime: string;
  endTime: string;
  organizer?: { email: string; name?: string };
  attendees?: CalAttendee[];
  rescheduleStartTime?: string;
  rescheduleEndTime?: string;
  location?: string;
  videoCallData?: { url?: string; type?: string };
  additionalInformation?: { hangoutLink?: string };
};

function getMeetLink(payload: CalPayload): string | null {
  const candidates = [
    payload.videoCallData?.url,
    payload.additionalInformation?.hangoutLink,
    payload.location,
  ];
  for (const c of candidates) {
    if (c && typeof c === "string" && /^https?:\/\//i.test(c)) {
      return c;
    }
  }
  return null;
}

type CalWebhook = {
  triggerEvent: "BOOKING_CREATED" | "BOOKING_CANCELLED" | "BOOKING_RESCHEDULED" | string;
  payload: CalPayload;
};

const TWILIO_MINIMUM_SCHEDULE_SECONDS = 16 * 60; // Twilio rejects sendAt < 15 min ahead; pad to 16

function fmtTime(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: TZ,
  }).format(date);
}

function fmtDateLong(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: TZ,
  }).format(date);
}

function morningOfMT(start: Date) {
  const partsArr = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: TZ,
  }).formatToParts(start);
  const parts: Record<string, string> = {};
  for (const p of partsArr) parts[p.type] = p.value;
  // Construct "YYYY-MM-DDT09:00" in MT, then resolve to UTC by computing the offset.
  // America/Edmonton is UTC-7 (MDT) or UTC-6 (MST). We let JS handle DST via toLocaleString.
  const naive = new Date(`${parts.year}-${parts.month}-${parts.day}T09:00:00`);
  // naive is interpreted as local time of THIS machine; we need it as MT.
  // Get offset in minutes between MT and UTC for that instant.
  const mtFormatted = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    timeZoneName: "shortOffset",
  }).formatToParts(naive);
  const offsetPart = mtFormatted.find((p) => p.type === "timeZoneName")?.value || "GMT-07";
  const m = offsetPart.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  const sign = m?.[1] === "-" ? -1 : 1;
  const hours = parseInt(m?.[2] ?? "0", 10);
  const minutes = parseInt(m?.[3] ?? "0", 10);
  const offsetMinutes = sign * (hours * 60 + minutes);
  // naive is parsed as machine-local; reconstruct UTC for 9:00 MT directly.
  return new Date(Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    9 - offsetMinutes / 60,
    0,
    0,
  ));
}

type TwilioClient = ReturnType<typeof twilio>;
let _twilioClient: TwilioClient | null = null;
function getTwilio(): TwilioClient {
  if (_twilioClient) return _twilioClient;
  const sid = process.env.TWILIO_SID;
  const token = process.env.TWILIO_TOKEN;
  if (!sid || !token) {
    throw new Error("Twilio credentials missing (TWILIO_SID / TWILIO_TOKEN)");
  }
  _twilioClient = twilio(sid, token);
  return _twilioClient;
}

async function sendNow(to: string, body: string): Promise<string | null> {
  try {
    const msg = await getTwilio().messages.create({
      to,
      messagingServiceSid: process.env.TWILIO_MESSAGING_SID!,
      body,
    });
    return msg.sid;
  } catch (err) {
    console.error("[cal-booking] sendNow failed:", to, (err as Error).message);
    return null;
  }
}

async function scheduleAt(to: string, body: string, sendAt: Date): Promise<string | null> {
  const secondsAhead = (sendAt.getTime() - Date.now()) / 1000;
  if (secondsAhead < TWILIO_MINIMUM_SCHEDULE_SECONDS) {
    console.log(`[cal-booking] skip schedule, only ${Math.round(secondsAhead)}s ahead:`, body.slice(0, 50));
    return null;
  }
  try {
    const msg = await getTwilio().messages.create({
      to,
      messagingServiceSid: process.env.TWILIO_MESSAGING_SID!,
      body,
      sendAt,
      scheduleType: "fixed",
    });
    return msg.sid;
  } catch (err) {
    console.error("[cal-booking] scheduleAt failed:", to, (err as Error).message);
    return null;
  }
}

async function cancelScheduled(sid: string) {
  try {
    await getTwilio().messages(sid).update({ status: "canceled" });
  } catch (err) {
    // 20009 = message already sent or not in scheduled state — fine
    console.log("[cal-booking] cancelScheduled (likely already sent):", sid, (err as Error).message);
  }
}

async function getStoredScheduledSids(bookingUid: string): Promise<string[]> {
  const booking = await prisma.booking.findUnique({
    where: { uid: bookingUid },
    select: { metadata: true },
  });
  const meta = (booking?.metadata as Record<string, unknown> | null) ?? {};
  const sids = (meta.scheduledSmsIds as string[] | undefined) ?? [];
  return Array.isArray(sids) ? sids : [];
}

/**
 * Atomically write our scheduledSmsIds to booking.metadata using jsonb_set so
 * we touch only our own path. Cal.diy's RegularBookingService writes
 * `videoCallUrl` to metadata AFTER our webhook returns, using a stale
 * in-memory reference of metadata — so a naive read-modify-write here gets
 * clobbered. By queueing this write with `after()` we let cal.diy's update
 * land first; our jsonb_set then merges in our path without overwriting
 * `videoCallUrl` or anything else cal.diy added.
 */
function scheduleStoreSids(bookingUid: string, sids: string[]) {
  after(async () => {
    try {
      // Wait a few seconds for cal.diy's post-webhook metadata update to land.
      await new Promise((r) => setTimeout(r, 3000));
      await prisma.$executeRaw`
        UPDATE "Booking"
        SET metadata = jsonb_set(
          COALESCE(metadata, '{}'::jsonb),
          '{scheduledSmsIds}',
          ${JSON.stringify(sids)}::jsonb,
          true
        )
        WHERE uid = ${bookingUid}
      `;
    } catch (err) {
      console.error("[cal-booking] scheduleStoreSids failed:", (err as Error).message);
    }
  });
}

async function scheduleAllForBooking(payload: CalPayload, isReschedule: boolean): Promise<string[]> {
  const start = new Date(payload.startTime);
  const dateStr = fmtDateLong(start);
  const timeStr = fmtTime(start);
  const attendee = payload.attendees?.[0];
  const attendeeName = attendee?.name ?? "there";
  const attendeePhone = attendee?.phoneNumber;
  const organizerPhone = process.env.ORGANIZER_PHONE_NUMBER;
  const meetLink = getMeetLink(payload);

  const sids: string[] = [];

  // Organizer instant notification
  if (organizerPhone) {
    const verb = isReschedule ? "Rescheduled" : "New booking";
    const phoneSuffix = attendeePhone ? ` (${attendeePhone})` : "";
    const sid = await sendNow(
      organizerPhone,
      `${verb}: ${attendeeName}${phoneSuffix} for Discovery Call ${dateStr} at ${timeStr} MT.`
    );
    if (sid) sids.push(sid);
  }

  // Organizer 15-min before
  if (organizerPhone) {
    const at = new Date(start.getTime() - 15 * 60 * 1000);
    const sid = await scheduleAt(
      organizerPhone,
      `Heads up: Discovery Call with ${attendeeName} starts in 15 minutes.`,
      at
    );
    if (sid) sids.push(sid);
  }

  const manageUrl = `${BOOKING_BASE_URL}/${payload.uid}`;

  // Attendee instant confirmation (skip for reschedule — has its own message in caller)
  if (attendeePhone && !isReschedule) {
    const confirmBody = meetLink
      ? `Thanks ${attendeeName}. Your call with ${ORGANIZER_NAME} is confirmed for ${dateStr} at ${timeStr} MT. Join: ${meetLink}. Manage: ${manageUrl}`
      : `Thanks ${attendeeName}. Your call with ${ORGANIZER_NAME} at Designer Digital is confirmed for ${dateStr} at ${timeStr} MT. Manage: ${manageUrl}`;
    const sid = await sendNow(attendeePhone, confirmBody);
    if (sid) sids.push(sid);
  }

  // Attendee scheduled reminders
  if (attendeePhone) {
    // 24h before — include manage URL so they can cancel/reschedule with one tap
    const at24h = new Date(start.getTime() - 24 * 60 * 60 * 1000);
    const sid24h = await scheduleAt(
      attendeePhone,
      `Reminder: your call with ${ORGANIZER_NAME} tomorrow at ${timeStr} MT. Need to change? ${manageUrl}`,
      at24h
    );
    if (sid24h) sids.push(sid24h);

    // Morning of (9 AM MT) — include link if available
    const morning = morningOfMT(start);
    if (morning.getTime() < start.getTime()) {
      const morningBody = meetLink
        ? `Quick reminder, ${attendeeName}. Your call with ${ORGANIZER_NAME} is today at ${timeStr} MT. Join: ${meetLink}`
        : `Quick reminder, ${attendeeName}. Your call with ${ORGANIZER_NAME} at Designer Digital is today at ${timeStr} MT. Link in your calendar invite.`;
      const sidMorning = await scheduleAt(attendeePhone, morningBody, morning);
      if (sidMorning) sids.push(sidMorning);
    }

    // 15 min before — link prominent
    const at15m = new Date(start.getTime() - 15 * 60 * 1000);
    const fifteenBody = meetLink
      ? `Your call with ${ORGANIZER_NAME} starts in 15 minutes. Join: ${meetLink}`
      : `Your call with ${ORGANIZER_NAME} starts in 15 minutes. Link in your calendar invite.`;
    const sid15m = await scheduleAt(attendeePhone, fifteenBody, at15m);
    if (sid15m) sids.push(sid15m);
  }

  return sids;
}

export async function POST(req: Request) {
  const raw = await req.text();
  const signature = req.headers.get("x-cal-signature-256") ?? "";
  const secret = process.env.CAL_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[cal-booking] CAL_WEBHOOK_SECRET not configured");
    return NextResponse.json({ error: "server misconfigured" }, { status: 500 });
  }
  const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  if (signature !== expected) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let webhook: CalWebhook;
  try {
    webhook = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const { triggerEvent, payload } = webhook;
  if (!payload?.uid) {
    return NextResponse.json({ error: "missing booking uid" }, { status: 400 });
  }

  const start = new Date(payload.startTime);
  const dateStr = fmtDateLong(start);
  const timeStr = fmtTime(start);
  const attendee = payload.attendees?.[0];
  const attendeeName = attendee?.name ?? "there";
  const attendeePhone = attendee?.phoneNumber;
  const organizerPhone = process.env.ORGANIZER_PHONE_NUMBER;

  try {
    if (triggerEvent === "BOOKING_CREATED") {
      const sids = await scheduleAllForBooking(payload, false);
      scheduleStoreSids(payload.uid, sids);
      return NextResponse.json({ ok: true, action: "created", scheduled: sids.length });
    }

    if (triggerEvent === "BOOKING_CANCELLED") {
      const oldSids = await getStoredScheduledSids(payload.uid);
      await Promise.all(oldSids.map(cancelScheduled));
      scheduleStoreSids(payload.uid, []);

      if (organizerPhone) {
        await sendNow(
          organizerPhone,
          `Cancelled: ${attendeeName} cancelled their ${dateStr} ${timeStr} Discovery Call.`
        );
      }
      if (attendeePhone) {
        await sendNow(
          attendeePhone,
          `Your Discovery Call on ${dateStr} at ${timeStr} was cancelled. To rebook: ${REBOOK_URL}`
        );
      }
      return NextResponse.json({ ok: true, action: "cancelled", sidsCancelled: oldSids.length });
    }

    if (triggerEvent === "BOOKING_RESCHEDULED") {
      const oldSids = await getStoredScheduledSids(payload.uid);
      await Promise.all(oldSids.map(cancelScheduled));

      const newSids = await scheduleAllForBooking(payload, true);
      scheduleStoreSids(payload.uid, newSids);

      if (organizerPhone) {
        await sendNow(
          organizerPhone,
          `Rescheduled: ${attendeeName} moved their call to ${dateStr} at ${timeStr}.`
        );
      }
      if (attendeePhone) {
        const meetLink = getMeetLink(payload);
        const body = meetLink
          ? `Your call moved to ${dateStr} at ${timeStr} MT. New link: ${meetLink} (also in your updated email).`
          : `Your call moved to ${dateStr} at ${timeStr} MT. Updated invite is in your email.`;
        await sendNow(attendeePhone, body);
      }
      return NextResponse.json({
        ok: true,
        action: "rescheduled",
        oldSids: oldSids.length,
        newSids: newSids.length,
      });
    }

    return NextResponse.json({ ok: true, action: "ignored", triggerEvent });
  } catch (err) {
    console.error("[cal-booking] handler error:", err);
    return NextResponse.json({ error: "handler failed" }, { status: 500 });
  }
}
