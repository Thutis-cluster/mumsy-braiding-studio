// -------------------- IMPORTS --------------------
const { onRequest, onCall } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const twilio = require("twilio");
const axios = require("axios");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();

// -------------------- TWILIO CLIENT --------------------
const twilioClient = () =>
  twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

const TWILIO_WHATSAPP = "whatsapp:+14155238886";

// -------------------- HELPERS --------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendWithRetry(sendFn, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await sendFn();
    } catch (err) {
      lastErr = err;
      console.error(`Attempt ${i} failed:`, err.message);
      if (i < attempts) await sleep(2 ** i * 500); // exponential backoff
    }
  }
  throw lastErr;
}

async function sendSms(phone, message) {
  return sendWithRetry(() =>
    twilioClient().messages.create({
      body: message,
      from: process.env.TWILIO_SMS,
      to: phone,
    })
  );
}

async function sendWhatsApp(phone, message) {
  return sendWithRetry(() =>
    twilioClient().messages.create({
      body: message,
      from: TWILIO_WHATSAPP,
      to: "whatsapp:" + phone,
    })
  );
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

// -------------------- CREATE BOOKING --------------------
exports.createBooking = onCall(
  {
    secrets: ["PAYSTACK_SECRET"],
  },
  async (req) => {
    const {
      style,
      length,
      price,
      clientName,
      clientPhone,
      date,
      time,
      method,
      email,
    } = req.data;

    if (
      !style ||
      !length ||
      !price ||
      !clientName ||
      !clientPhone ||
      !date ||
      !time ||
      !email
    ) {
      throw new Error("Missing required fields");
    }

    const bookingRef = await db.collection("bookings").add({
      style,
      length,
      price,
      clientName,
      clientPhone: validatePhone(clientPhone),
      clientEmail: validateEmail(email),
      date,
      time,
      method,
      status: "Pending",
      paymentStatus: "Unpaid",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: Math.round(price * 100),
        metadata: { bookingId: bookingRef.id },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`,
        },
      }
    );

    return { authorization_url: response.data.data.authorization_url };
  }
);

// -------------------- PAYSTACK WEBHOOK --------------------
exports.paystackWebhook = onRequest(
  {
    secrets: ["PAYSTACK_SECRET", "TWILIO_SID", "TWILIO_TOKEN", "TWILIO_SMS"],
  },
  async (req, res) => {
    try {
      if (req.method !== "POST") return res.sendStatus(405);
      if (!req.headers["x-paystack-signature"]) return res.sendStatus(401);

      const hash = crypto
        .createHmac("sha512", process.env.PAYSTACK_SECRET)
        .update(req.rawBody)
        .digest("hex");

      if (hash !== req.headers["x-paystack-signature"])
        return res.sendStatus(403);

      const event = req.body;
      if (event.event !== "charge.success") return res.sendStatus(200);

      const bookingId = event.data?.metadata?.bookingId;
      if (!bookingId) return res.sendStatus(400);

      const bookingRef = db.collection("bookings").doc(bookingId);

      await db.runTransaction(async (tx) => {
        const snap = await tx.get(bookingRef);
        const booking = snap.data();
        if (!booking || booking.paymentStatus === "Paid") return;

        tx.update(bookingRef, {
          paymentStatus: "Paid",
          verified: true,
          depositPaid: event.data.amount / 100,
          status: "Accepted",
          receiptEmailSent: false,
        });

        const message = `✅ Booking confirmed!
Hi ${booking.clientName}, your ${booking.style} (${booking.length}) appointment is confirmed.
📅 ${booking.date}
🕒 ${booking.time}`;

        if (booking.method === "whatsapp")
          await sendWhatsApp(booking.clientPhone, message);
        else await sendSms(booking.clientPhone, message);
      });

      return res.sendStatus(200);
    } catch (err) {
      console.error("Webhook error:", err);
      return res.sendStatus(500);
    }
  }
);

// -------------------- 5-HOUR REMINDERS --------------------
exports.sendFiveHourReminders = onSchedule(
  {
    schedule: "every 5 minutes",
    secrets: ["TWILIO_SID", "TWILIO_TOKEN", "TWILIO_SMS"],
  },
  async () => {
    const now = admin.firestore.Timestamp.now();
    const snapshot = await db
      .collection("bookings")
      .where("status", "==", "Accepted")
      .where("reminderSent", "==", false)
      .where("reminderAt", "<=", now)
      .get();

    for (const doc of snapshot.docs) {
      const booking = doc.data();
      const message = `⏰ Reminder
Hi ${booking.clientName}, your ${booking.style} (${booking.length}) appointment is in 5 hours.
📅 ${booking.date}
🕒 ${booking.time}`;

      try {
        if (booking.method === "whatsapp")
          await sendWhatsApp(booking.clientPhone, message);
        else await sendSms(booking.clientPhone, message);

        await doc.ref.update({ reminderSent: true });
      } catch (err) {
        console.error("Reminder failed:", err.message);
      }
    }
  }
);
