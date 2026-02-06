// functions/index.js
import { onCall, onRequest } from "firebase-functions/v2/https";
import { defineString } from "firebase-functions/params";
import admin from "firebase-admin";
import axios from "axios";
import crypto from "crypto";
import twilio from "twilio";

admin.initializeApp();
const db = admin.firestore();

/* ================= ENV VARS ================= */
const PAYSTACK_SECRET = defineString("PAYSTACK_SECRET");
const TWILIO_SID = defineString("TWILIO_SID");
const TWILIO_TOKEN = defineString("TWILIO_TOKEN");
const TWILIO_SMS = defineString("TWILIO_SMS");
const TWILIO_WHATSAPP = "whatsapp:+14155238886";

let twilioClient;

function getTwilioClient() {
  if (!twilioClient) {
    twilioClient = twilio(
      TWILIO_SID.value(),
      TWILIO_TOKEN.value()
    );
  }
  return twilioClient;
}

/* ================= HELPERS ================= */
function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!re.test(email)) throw new Error("Invalid email");
  return email;
}

function validatePhone(phone) {
  let p = phone.replace(/\D/g, "");
  if (p.startsWith("0")) p = "27" + p.slice(1);
  if (!/^\d{11,15}$/.test(p)) throw new Error("Invalid phone");
  return "+" + p;
}

async function sendMessage(phone, message, method = "sms") {
  const client = getTwilioClient();

  if (method === "whatsapp") {
    return client.messages.create({
      body: message,
      from: TWILIO_WHATSAPP,
      to: `whatsapp:${phone}`,
    });
  }

  return client.messages.create({
    body: message,
    from: TWILIO_SMS.value(),
    to: phone,
  });
}

/* ================= CREATE BOOKING ================= */
export const createBooking = onCall(async (request) => {
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
  } = request.data;

  if (!style || !length || !price || !clientName || !clientPhone || !date || !time || !email) {
    throw new Error("Missing fields");
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

  // Example: 30% deposit
  const depositAmount = Math.round(price * 0.3 * 100);

  const response = await axios.post(
    "https://api.paystack.co/transaction/initialize",
    {
      email,
      amount: depositAmount,
      metadata: { bookingId: bookingRef.id },
    },
    {
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET.value()}`,
        "Content-Type": "application/json",
      },
    }
  );

  return { authorization_url: response.data.data.authorization_url };
});

/* ================= PAYSTACK WEBHOOK ================= */
export const paystackWebhook = onRequest(async (req, res) => {
  try {
    const signature = req.headers["x-paystack-signature"];
    const hash = crypto
      .createHmac("sha512", PAYSTACK_SECRET.value())
      .update(JSON.stringify(req.body))
      .digest("hex");

    if (hash !== signature) {
      return res.status(400).send("Invalid signature");
    }

    const event = req.body;

    if (event.event !== "charge.success") {
      return res.status(200).send("Ignored");
    }

    const { metadata, amount } = event.data;
    const bookingId = metadata?.bookingId;
    if (!bookingId) return res.status(400).send("No bookingId");

    const bookingRef = db.collection("bookings").doc(bookingId);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(bookingRef);
      if (!snap.exists) throw new Error("Booking not found");

      const booking = snap.data();
      if (booking.paymentStatus === "Paid") return;

      tx.update(bookingRef, {
        paymentStatus: "Paid",
        depositPaid: amount / 100,
        status: "Accepted",
        receiptEmailSent: false,
      });

      const msg = `✅ Booking confirmed!
Hi ${booking.clientName}
📅 ${booking.date}
🕒 ${booking.time}
Style: ${booking.style}`;

      await sendMessage(booking.clientPhone, msg, booking.method);
    });

    return res.status(200).send("Success");
  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error");
  }
});

// -------------------- 5-HOUR REMINDERS --------------------
export const sendFiveHourReminders = functions.pubsub.schedule("every 5 minutes").onRun(async () => {
  const now = admin.firestore.Timestamp.now();
  const snapshot = await db
    .collection("bookings")
    .where("status", "==", "Accepted")
    .where("reminderSent", "==", false)
    .where("reminderAt", "<=", now)
    .get();

  if (snapshot.empty) return null;

  for (const doc of snapshot.docs) {
    const booking = doc.data();
    const message = `⏰ Reminder\nHi ${booking.clientName}, your ${booking.style} (${booking.length}) appointment is in 5 hours.\n📅 ${booking.date}\n🕒 ${booking.time}`;
    try {
      await sendMessage(booking.clientPhone, message, booking.method);

      await db.collection("reminderLogs").add({
        bookingId: doc.id,
        clientName: booking.clientName,
        phone: booking.clientPhone,
        method: booking.method,
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
        type: "5-hour",
      });

      await doc.ref.update({ reminderSent: true });
    } catch (err) {
      console.error("Reminder failed for", booking.clientPhone, err.message);
    }
  }

  return null;
});
