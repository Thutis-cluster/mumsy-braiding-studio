// index.js
import { onCall, onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/pubsub";
import admin from "firebase-admin";
import axios from "axios";
import twilio from "twilio";
import crypto from "crypto";

console.log("🔥 index.js loaded");

// -------------------- FIREBASE INIT --------------------
admin.initializeApp();
const db = admin.firestore();

// -------------------- TWILIO SETUP --------------------
const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_TOKEN = process.env.TWILIO_TOKEN;
const TWILIO_SMS = process.env.TWILIO_SMS;
const TWILIO_WHATSAPP = "whatsapp:+14155238886";
const client = twilio(TWILIO_SID, TWILIO_TOKEN);

// -------------------- HELPERS --------------------
async function sendMessage(phone, message, method = "sms") {
  if (method === "whatsapp") {
    await client.messages.create({ body: message, from: TWILIO_WHATSAPP, to: `whatsapp:${phone}` });
  } else {
    await client.messages.create({ body: message, from: TWILIO_SMS, to: phone });
  }
}

function validatePhone(phone) {
  let p = String(phone).replace(/\D/g, "");
  if (p.startsWith("0")) p = "27" + p.slice(1);
  if (!/^\d{11,15}$/.test(p)) throw new Error("Invalid phone number");
  return "+" + p;
}

function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!re.test(email)) throw new Error("Invalid email address");
  return email;
}

// -------------------- AUDIT LOG --------------------
async function logAdminAction(adminId, action, details = {}) {
  await db.collection("adminLogs").add({
    adminId,
    action,
    details,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// -------------------- CREATE BOOKING WITH 45% DEPOSIT --------------------
export const createBooking = onCall(
  { secrets: ["PAYSTACK_SECRET"] },
  async (request) => {
    try {
      const {
        style,
        length,
        clientName,
        clientPhone,
        date,
        time,
        method,
        email,
      } = request.data;

      if (!style || !length || !clientName || !clientPhone || !date || !time || !email) {
        throw new Error("Missing required fields");
      }

      // ---------------- PRICE MAP ----------------
      const priceMap = {
        "Box Braids": { Short: 200, Medium: 300, Long: 500 },
        "Knotless Braids": { Short: 250, Medium: 350, Long: 600 },
        "CornRows": { Simple: 150 },
        "Ben & Betty": { Simple: 120 }
      };

      const price = priceMap[style]?.[length];
      if (!price) throw new Error("Invalid style or length");

      // ---------------- DEPOSIT CALCULATION ----------------
      const DEPOSIT_PERCENT = 0.45;
      const DEPOSIT_THRESHOLD = 100;
      let depositPaid = 0;
      let balanceRemaining = price;

      if (price >= DEPOSIT_THRESHOLD) {
        depositPaid = Math.round(price * DEPOSIT_PERCENT);
        balanceRemaining = price - depositPaid;
      }

      // ---------------- CREATE BOOKING ----------------
      const bookingRef = await db.collection("bookings").add({
        style,
        length,
        price,
        depositPaid,
        balanceRemaining,
        clientName,
        clientPhone: validatePhone(clientPhone),
        clientEmail: validateEmail(email),
        date,
        time,
        method,
        status: "Pending",
        paymentStatus: depositPaid > 0 ? "Deposit Paid" : "No Deposit Required",
        reminderSent: false,
        deleted: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // ---------------- PAYSTACK INIT (deposit) ----------------
      if (depositPaid > 0) {
        const response = await axios.post(
          "https://api.paystack.co/transaction/initialize",
          {
            email,
            amount: depositPaid * 100,
            metadata: { bookingId: bookingRef.id },
            callback_url: "https://YOURDOMAIN.com/thank-you.html"
          },
          { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`, "Content-Type": "application/json" } }
        );

        return { authorization_url: response.data.data.authorization_url };
      }

      return { bookingId: bookingRef.id }; // no deposit required
    } catch (err) {
      console.error("❌ createBooking error:", err);
      throw new Error("Unable to start booking");
    }
  }
);

// -------------------- COMPLETE PAYMENT (ADMIN MARKS BALANCE AS PAID) --------------------
export const completePayment = onCall(async (request) => {
  const { bookingId, amountPaid, paymentReference } = request.data;
  const adminId = await checkAdmin(request.auth);

  if (!bookingId || !amountPaid || !paymentReference) throw new Error("Missing payment data");

  const bookingRef = db.collection("bookings").doc(bookingId);
  const snap = await bookingRef.get();
  if (!snap.exists) throw new Error("Booking not found");

  const booking = snap.data();
  const remainingBalance = (booking.price || 0) - (booking.depositPaid || 0);

  if (amountPaid < remainingBalance) {
    throw new Error(`Payment is less than remaining balance: R${remainingBalance}`);
  }

  await bookingRef.update({
    paymentStatus: "Paid",
    depositPaid: (booking.depositPaid || 0) + amountPaid,
    balanceRemaining: 0,
    paymentReference,
    status: "Accepted",
  });

  await sendMessage(
    booking.clientPhone,
    `💳 Payment complete. Your booking for ${booking.style} on ${booking.date} at ${booking.time} is confirmed.`,
    booking.method
  );

  await logAdminAction(adminId, "completePayment", { bookingId, amountPaid, paymentReference });
  return { success: true };
});

// -------------------- PAYSTACK WEBHOOK --------------------
export const paystackWebhook = onRequest({ secrets: ["PAYSTACK_SECRET"] }, async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).send("Method not allowed");

    const hash = crypto.createHmac("sha512", process.env.PAYSTACK_SECRET).update(req.rawBody).digest("hex");
    if (hash !== req.headers["x-paystack-signature"]) return res.status(400).send("Invalid signature");

    const event = req.body;
    if (event.event === "charge.success") {
      const bookingId = event.data.metadata?.bookingId;
      if (!bookingId) return res.status(400).send("Missing bookingId");

      const bookingRef = db.collection("bookings").doc(bookingId);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(bookingRef);
        if (!snap.exists) throw new Error("Booking not found");
        const booking = snap.data();
        if (booking.paymentStatus === "Paid") return;

        tx.update(bookingRef, { paymentStatus: "Paid", depositPaid: event.data.amount / 100, balanceRemaining: 0, status: "Accepted" });

        const msg = `✅ Booking confirmed! Hi ${booking.clientName}, your ${booking.style} appointment is confirmed.\n📅 ${booking.date}\n🕒 ${booking.time}`;
        await sendMessage(booking.clientPhone, msg, booking.method);
      });

      return res.status(200).send("Webhook processed");
    }

    return res.status(200).send("Event ignored");
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).send("Server error");
  }
});

// -------------------- UPDATE BOOKING STATUS --------------------
export const updateBookingStatus = onCall(async (request) => {
  const { bookingId, status } = request.data;
  const adminId = await checkAdmin(request.auth);

  if (!bookingId || !["Accepted", "Declined"].includes(status)) {
    throw new Error("Invalid data");
  }

  const bookingRef = db.collection("bookings").doc(bookingId);
  const snap = await bookingRef.get();
  if (!snap.exists) throw new Error("Booking not found");

  const booking = snap.data();
  await bookingRef.update({ status });

  // Notify client
  const message = `📢 Booking Update
Hi ${booking.clientName},
Your booking has been ${status}.
📅 ${booking.date}
🕒 ${booking.time}
💰 Deposit Paid: R${booking.depositPaid || 0}
💳 Remaining Balance: R${booking.balanceRemaining || booking.price}`;

  await sendMessage(booking.clientPhone, message, booking.method);

  await logAdminAction(adminId, "updateBookingStatus", { bookingId, status });
  return { success: true };
});

// -------------------- SOFT DELETE --------------------
export const softDeleteBooking = onCall(async (request) => {
  const { bookingId } = request.data;
  const adminId = await checkAdmin(request.auth);

  if (!bookingId) throw new Error("Missing bookingId");

  await db.collection("bookings").doc(bookingId).update({
    deleted: true,
    deletedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await logAdminAction(adminId, "softDeleteBooking", { bookingId });
  return { success: true };
});

// -------------------- SCHEDULED REMINDERS WITH DEPOSIT --------------------
export const sendBookingReminders = onSchedule("every 5 minutes", async () => {
  const snapshot = await db.collection("bookings")
    .where("status", "==", "Accepted")
    .where("reminderSent", "==", false)
    .where("deleted", "==", false)
    .get();

  const now = new Date();

  for (const doc of snapshot.docs) {
    const booking = doc.data();
    if (!booking.date || !booking.time) continue;

    const [hour, minute] = booking.time.split(":").map(Number);
    const appointmentDate = new Date(booking.date);
    appointmentDate.setHours(hour, minute, 0, 0);

    const diffHours = (appointmentDate - now) / (1000 * 60 * 60);

    if (diffHours <= 5 && diffHours > 4) {
      const message = `⏰ Reminder: Hi ${booking.clientName}, your appointment for ${booking.style} (${booking.length}) is in 5 hours at ${booking.time} on ${booking.date}.
💰 Deposit Paid: R${booking.depositPaid || 0}
💳 Remaining Balance: R${booking.balanceRemaining || booking.price}
Please bring the remaining balance on the day of your appointment.`;

      await sendMessage(booking.clientPhone, message, booking.method);
      await db.collection("bookings").doc(doc.id).update({ reminderSent: true });
    }
  }
});

// -------------------- MARK PITCHED/NOT --------------------
export const markPitched = onCall(async (request) => {
  const { bookingId, value } = request.data;
  const adminId = await checkAdmin(request.auth);

  if (!bookingId || !["yes", "no"].includes(value)) throw new Error("Invalid data");

  await db.collection("bookings").doc(bookingId).update({ pitched: value });
  await logAdminAction(adminId, "markPitched", { bookingId, value });
  return { success: true };
});

// -------------------- DAILY REVENUE --------------------
export const calculateDailyRevenue = onSchedule("every day 00:10", async () => {
  const snapshot = await db.collection("bookings").get();
  const dailyTotals = {};

  snapshot.forEach(doc => {
    const b = doc.data();
    if (!b.date || b.status !== "Accepted") return;
    if (!dailyTotals[b.date]) dailyTotals[b.date] = { revenue: 0, hours: 0 };
    dailyTotals[b.date].revenue += b.price || 0;
    dailyTotals[b.date].hours += parseFloat(b.timeEstimate || 0);
  });

  const batch = db.batch();
  for (const date in dailyTotals) {
    batch.set(db.collection("dashboard").doc(date), dailyTotals[date]);
  }
  await batch.commit();
});

//-------------------- ADMIN -------------------------
async function checkAdmin(authContext) {
  if (!authContext) throw new Error("Not authenticated");

  const adminDoc = await db.collection("admins").doc(authContext.uid).get();
  if (!adminDoc.exists || adminDoc.data().role !== "admin") {
    throw new Error("Not authorized");
  }

  return authContext.uid;
}

async function logAdminAction(adminId, action, details = {}) {
  await db.collection("adminLogs").add({
    adminId,
    action,
    details,
    timestamp: admin.firestore.FieldValue.serverTimestamp()
  });
}

// -------------------- TEST FUNCTION --------------------
export const testFn = onCall(() => {
  return { ok: true };
});
