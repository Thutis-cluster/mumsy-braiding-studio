// index.js
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
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
async function checkAdmin(auth) {
  if (!auth) {
    throw new HttpsError("unauthenticated", "Login required.");
  }

  const adminDoc = await db.collection("admins").doc(auth.uid).get();

  if (!adminDoc.exists || adminDoc.data().role !== "admin") {
    throw new HttpsError("permission-denied", "Admin access required.");
  }

  return auth.uid;
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
  { secrets: ["PAYSTACK_SECRET"], timeoutSeconds: 420 },
  async (request) => {
    try {
      const { style, length, clientName, clientPhone, date, time, method, email } = request.data;

      // Validate required fields
      if (!style || !length || !clientName || !clientPhone || !date || !time || !email) {
        throw new Error("Missing required booking fields.");
      }

      const validatedPhone = validatePhone(clientPhone);
      const validatedEmail = validateEmail(email);

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

      const DEPOSIT_PERCENT = 0.45;
      const DEPOSIT_THRESHOLD = 100;

      // ---------------- NO DEPOSIT REQUIRED ----------------
      if (price < DEPOSIT_THRESHOLD) {
        const bookingRef = await db.collection("bookings").add({
          style,
          length,
          price,
          depositRequired: 0,
          depositPaid: 0,
          balanceRemaining: price,
          clientName,
          clientPhone: validatedPhone,
          clientEmail: validatedEmail,
          date,
          time,
          method,
          status: "Pending",
          paymentStatus: "No Deposit Required",
          reminderSent: false,
          deleted: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return { bookingId: bookingRef.id };
      }

      // ---------------- DEPOSIT REQUIRED ----------------
      const depositRequired = Math.round(price * DEPOSIT_PERCENT);

// 1️⃣ Create a booking document first (status = Pending Payment)
 const bookingRef = await db.collection("bookings").add({
    style,
    length,
    price,
    depositRequired: depositRequired,
    depositPaid: 0,
    balanceRemaining: price - depositRequired,
    clientName,
    clientPhone: validatedPhone,
    clientEmail: validatedEmail,
    date,
    time,
    method,
    status: "Pending Payment",
    paymentStatus: "Deposit Required",
    reminderSent: false,
    deleted: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
});

   const response = await axios.post(
        "https://api.paystack.co/transaction/initialize",
        {
          email: validatedEmail,
          amount: depositRequired * 100,
          metadata: {
            bookingId: bookingRef.id,
            style,
            length,
            price,
            clientName,
            clientPhone: validatedPhone,
            clientEmail: validatedEmail,
            date,
            time,
            method
          },
     callback_url: `https://braiding-bookings.web.app/confirmation?bookingId=${bookingRef.id}`
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`,
            "Content-Type": "application/json"
          }
        }
      );

      if (!response.data?.data?.authorization_url) {
        throw new Error("Unable to initiate payment.");
      }

      return {
        authorization_url: response.data.data.authorization_url
      };

    } catch (err) {
      console.error("❌ createBooking error:", err);
      throw new Error(err.message || "Unable to start booking.");
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
export const paystackWebhook = onRequest(
  { secrets: ["PAYSTACK_SECRET"], cors: false },
  async (req, res) => {
    try {
      if (req.method !== "POST") {
        return res.status(405).send("Method not allowed");
      }

      const hash = crypto
        .createHmac("sha512", process.env.PAYSTACK_SECRET)
        .update(Buffer.from(JSON.stringify(req.body)))
        .digest("hex");

      if (hash !== req.headers["x-paystack-signature"]) {
        return res.status(400).send("Invalid signature");
      }

      const event = req.body;

     if (event.event === "charge.success") {
  const data = event.data;
  const bookingId = data.metadata.bookingId;
  const depositPaid = data.amount / 100;

  const bookingRef = db.collection("bookings").doc(bookingId);
  const snap = await bookingRef.get();

  if (!snap.exists) {
    return res.status(404).send("Booking not found");
  }

  const booking = snap.data();

  await bookingRef.update({
    depositPaid: depositPaid,
    balanceRemaining: booking.price - depositPaid,
    paymentStatus: "Deposit Received",
    status: "Pending",
  });

  return res.status(200).send("Booking updated");
}

      return res.status(200).send("Event ignored");
    } catch (err) {
      console.error("Webhook error:", err);
      return res.status(500).send("Server error");
    }
  }
);

// -------------------- ADMIN LOGIN--------------------
export const verifyAdmin = onCall(async (request) => {
  const { auth } = request;
  if (!auth) throw new HttpsError("unauthenticated", "Not logged in");

  const adminDoc = await db.collection("admins").doc(auth.uid).get();
  if (!adminDoc.exists || adminDoc.data().role !== "admin") {
    throw new HttpsError("permission-denied", "Not authorized as admin.");
  }

  return { success: true };
});

// -------------------- FORGOT ADMIN PASSWORD --------------------
export const forgotAdminPassword = onCall(async (request) => {
  const { email } = request.data;

  if (!email) {
    throw new HttpsError("invalid-argument", "Email is required.");
  }

  try {
    // Check if email exists in admins collection
    const q = await db.collection("admins").where("email", "==", email).get();

    if (q.empty) {
      // Always respond the same way to avoid leaking which emails are admins
      return { success: true, message: "If this email is registered as an admin, a reset email has been sent." };
    }

    // Generate password reset link via Firebase Admin SDK
    const link = await admin.auth().generatePasswordResetLink(email);

    // Optionally, you can send it via your email provider here
    console.log("✅ Generated admin password reset link:", link);

    return { success: true, message: "If this email is registered as an admin, a reset email has been sent." };
  } catch (err) {
    console.error("❌ forgotAdminPassword error:", err);
    throw new HttpsError("internal", "Failed to send reset email.");
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
export const sendBookingReminders = onSchedule("*/5 * * * *", async (event) => { const snapshot = await db.collection("bookings")
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

// -------------------- CONFIRM PITCHED / NOT --------------------
export const confirmPitched = onCall(async (request) => {
  const { bookingId, pitched } = request.data;
  const adminId = await checkAdmin(request.auth);

  if (!bookingId || typeof pitched !== "boolean") {
    throw new HttpsError("invalid-argument", "Invalid data");
  }

  const bookingRef = db.collection("bookings").doc(bookingId);
  const snap = await bookingRef.get();

  if (!snap.exists) {
    throw new HttpsError("not-found", "Booking not found");
  }

  await bookingRef.update({
    pitched: pitched,
    pitchedConfirmedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await logAdminAction(adminId, "confirmPitched", {
    bookingId,
    pitched
  });

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

// -------------------- AUTO ARCHIVE OLD BOOKINGS --------------------
export const archiveOldBookings = onSchedule(
  "0 2 * * *", // Runs daily at 2AM
  async () => {

    const THIRTY_DAYS_AGO = new Date();
    THIRTY_DAYS_AGO.setDate(THIRTY_DAYS_AGO.getDate() - 30);

    const snapshot = await db.collection("bookings")
      .where("createdAt", "<=", THIRTY_DAYS_AGO)
      .get();

    if (snapshot.empty) {
      console.log("No old bookings to archive.");
      return;
    }

    const batch = db.batch();

    snapshot.forEach(doc => {
      const data = doc.data();

      const archiveRef = db.collection("archivedBookings").doc(doc.id);
      batch.set(archiveRef, {
        ...data,
        archivedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      batch.delete(doc.ref);
    });

    await batch.commit();

    console.log(`✅ Archived ${snapshot.size} old bookings.`);
  }
);

// -------------------- MONTHLY FINANCIAL REPORT --------------------
export const generateMonthlyReport = onSchedule(
  "0 3 1 * *", // 3AM on the 1st of every month
  async () => {

    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const nextMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const snapshot = await db.collection("bookings")
      .where("pitched", "==", true)
      .where("pitchedConfirmedAt", ">=", lastMonth)
      .where("pitchedConfirmedAt", "<", nextMonth)
      .get();

    let totalRevenue = 0;
    let totalBookings = 0;
    let styleBreakdown = {};

    snapshot.forEach(doc => {
      const b = doc.data();
      totalRevenue += b.price || 0;
      totalBookings++;

      if (!styleBreakdown[b.style]) {
        styleBreakdown[b.style] = 0;
      }

      styleBreakdown[b.style] += b.price || 0;
    });

    await db.collection("monthlyReports").doc(
      `${lastMonth.getFullYear()}-${lastMonth.getMonth()+1}`
    ).set({
      totalRevenue,
      totalBookings,
      styleBreakdown,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log("✅ Monthly report generated");
  }
);

// -------------------- TEST FUNCTION --------------------
export const testFn = onCall(() => {
  return { ok: true };
});
