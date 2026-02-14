// index.js
import { onCall, onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import admin from "firebase-admin";
import axios from "axios";
import twilio from "twilio";
import crypto from "crypto";

console.log("🔥 index.js loaded");

// -------------------- FIREBASE INIT --------------------
admin.initializeApp();
const db = admin.firestore();

// -------------------- HELPERS --------------------
function getTwilioClient() {
  const sid = process.env.TWILIO_SID;
  const token = process.env.TWILIO_TOKEN;
  if (!sid || !token) {
    console.warn("Twilio env vars missing, messages will fail");
    return null;
  }
  return twilio(sid, token);
}

async function sendMessage(phone, message, method = "sms") {
  const client = getTwilioClient();
  if (!client) {
    console.warn("Twilio client not configured. Message not sent:", message);
    return;
  }

  const TWILIO_SMS = process.env.TWILIO_SMS || "+1234567890";
  const TWILIO_WHATSAPP = "whatsapp:+14155238886";

  try {
    if (method === "whatsapp") {
      await client.messages.create({ body: message, from: TWILIO_WHATSAPP, to: `whatsapp:${phone}` });
    } else {
      await client.messages.create({ body: message, from: TWILIO_SMS, to: phone });
    }
  } catch (err) {
    console.error("Twilio sendMessage error:", err.message);
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

// -------------------- ADMIN CHECK --------------------
async function checkAdmin(authContext) {
  if (!authContext) throw new Error("Not authenticated");

  const adminDoc = await db.collection("admins").doc(authContext.uid).get();
  if (!adminDoc.exists || adminDoc.data().role !== "admin") {
    throw new Error("Not authorized");
  }

  return authContext.uid;
}

// -------------------- AUDIT LOG --------------------
async function logAdminAction(adminId, action, details = {}) {
  await db.collection("adminLogs").add({
    adminId,
    action,
    details,
    timestamp: admin.firestore.FieldValue.serverTimestamp()
  });
}

// -------------------- CREATE BOOKING --------------------
export const createBooking = onCall(
  { secrets: ["PAYSTACK_SECRET"], timeoutSeconds: 90 },
  async (request) => {
    try {
      const { style, length, clientName, clientPhone, date, time, method, email } = request.data;

      // Validate required fields
      if (!style || !length || !clientName || !clientPhone || !date || !time || !email) {
        console.error("❌ createBooking error: Missing required fields", request.data);
        throw new Error("Missing required booking fields.");
      }

      // Determine price
      const priceMap = {
        "Box Braids": { Short: 200, Medium: 300, Long: 500 },
        "Knotless Braids": { Short: 250, Medium: 350, Long: 600 },
        "CornRows": { Simple: 50 },
        "Ben & Betty": { Simple: 20 }
      };
      const price = priceMap[style]?.[length];
      if (!price) {
        console.error("❌ createBooking error: Invalid style or length", { style, length });
        throw new Error("Invalid style or length selected.");
      }

      // Calculate deposit
      const DEPOSIT_PERCENT = 0.45;
      const DEPOSIT_THRESHOLD = 100;
      let depositPaid = 0;
      let balanceRemaining = price;

      if (price >= DEPOSIT_THRESHOLD) {
        depositPaid = Math.round(price * DEPOSIT_PERCENT);
        balanceRemaining = price - depositPaid;
      }

      // Create booking in Firestore
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
        paymentStatus: depositPaid > 0 ? "Deposit Pending" : "No Deposit Required",
        reminderSent: false,
        deleted: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // If deposit is required, initialize Paystack payment
      if (depositPaid > 0) {
        try {
          const response = await axios.post(
            "https://api.paystack.co/transaction/initialize",
            {
              email,
              amount: depositPaid * 100, // Paystack expects kobo
              metadata: { bookingId: bookingRef.id },
              callback_url: "https://braiding-bookings.web.app/confirmation"
            },
            {
              headers: {
                Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`,
                "Content-Type": "application/json"
              }
            }
          );

          // Log full response for debugging
          console.log("✅ Paystack initialize response:", response.data);

          if (!response.data || !response.data.data || !response.data.data.authorization_url) {
            console.error("❌ Paystack response missing authorization_url", response.data);
            throw new Error("Unable to initiate payment with Paystack.");
          }

          return { authorization_url: response.data.data.authorization_url };
        } catch (payErr) {
          console.error("❌ Paystack API error:", payErr.response?.data || payErr.message);
          throw new Error("Payment initiation failed. Please try again later.");
        }
      }

      // No deposit needed, return booking ID
      return { bookingId: bookingRef.id };

    } catch (err) {
      // Log the full error for debugging
      console.error("❌ createBooking unexpected error:", err);
      throw new Error(err.message || "Unable to start booking. Please contact support.");
    }
  }
);

// -------------------- COMPLETE PAYMENT --------------------
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
export const sendBookingReminders = onSchedule(
  "every 5 minutes",
  async (event) => { const snapshot = await db.collection("bookings")
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
export const calculateDailyRevenue = onSchedule(
  "10 0 * * *",
  async (event) => {const snapshot = await db.collection("bookings").get();
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

// -------------------- TEST FUNCTION --------------------
export const testFn = onCall(() => {
  return { ok: true };
});
