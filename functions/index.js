// index.js
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const twilio = require("twilio");
const axios = require("axios");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();

// -------------------- TWILIO CONFIG --------------------
const client = twilio(
  functions.config().twilio.sid,
  functions.config().twilio.token
);
const TWILIO_SMS = functions.config().twilio.phone;
const TWILIO_WHATSAPP = "whatsapp:+14155238886";

// -------------------- HELPERS --------------------

/**
 * Send an SMS via Twilio.
 * @param {string} phone - The phone number in international format.
 * @param {string} message - The message to send.
 */
async function sendSms(phone, message) {
  try {
    await client.messages.create({
      body: message,
      from: TWILIO_SMS,
      to: phone,
    });
  } catch (err) {
    console.error("SMS failed for", phone, err.message);
  }
}

/**
 * Send a WhatsApp message via Twilio.
 * @param {string} phone - The phone number in international format.
 * @param {string} message - The message to send.
 */
async function sendWhatsApp(phone, message) {
  try {
    await client.messages.create({
      body: message,
      from: TWILIO_WHATSAPP,
      to: "whatsapp:" + phone,
    });
  } catch (err) {
    console.error("WhatsApp failed for", phone, err.message);
  }
}

/**
 * Validate and format a phone number.
 * @param {string} phone
 * @returns {string} formatted phone
 */
function validatePhone(phone) {
  let p = phone.replace(/\D/g, "");
  if (p.startsWith("0")) p = "27" + p.slice(1);
  if (!/^\d{11,15}$/.test(p)) throw new Error("Invalid phone number");
  return "+" + p;
}

/**
 * Validate an email address.
 * @param {string} email
 * @returns {string} email
 */
function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!re.test(email)) throw new Error("Invalid email address");
  return email;
}

// -------------------- CREATE BOOKING --------------------

/**
 * Create a booking and initialize Paystack payment.
 */
exports.createBooking = functions.https.onCall(async (data, context) => {
  const { style, length, price, clientName, clientPhone, date, time, method, email } = data;

  if (!style || !length || !price || !clientName || !clientPhone || !date || !time || !email) {
    throw new functions.https.HttpsError("invalid-argument", "Missing fields");
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
        Authorization: `Bearer ${functions.config().paystack.secret}`,
      },
    }
  );

  return {
    authorization_url: response.data.data.authorization_url,
  };
});

// -------------------- PAYSTACK WEBHOOK --------------------

/**
 * Handle Paystack webhook events.
 */
exports.paystackWebhook = functions.https.onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).send("Method not allowed");

    const paystackSignature = req.headers["x-paystack-signature"];
    const secret = functions.config().paystack.secret;

    // Verify webhook signature
    const hash = crypto
      .createHmac("sha512", secret)
      .update(JSON.stringify(req.body))
      .digest("hex");

    if (hash !== paystackSignature) return res.status(400).send("Invalid signature");

    const event = req.body;

    if (event.event === "charge.success") {
      const transaction = event.data;
      const bookingId = transaction.metadata && transaction.metadata.bookingId;

      if (!bookingId) return res.status(400).send("Missing bookingId");

      const bookingRef = db.collection("bookings").doc(bookingId);

      await db.runTransaction(async (tx) => {
        const snap = await tx.get(bookingRef);
        const booking = snap.data();
        if (!booking) throw new Error("Booking not found");
        if (booking.paymentStatus === "Paid") return;

        tx.update(bookingRef, {
          paymentStatus: "Paid",
          verified: true,
          depositPaid: transaction.amount / 100,
          status: "Accepted",
          receiptEmailSent: false,
        });

        const message =
          `✅ Booking confirmed!\nHi ${booking.clientName}, your ${booking.style} ` +
          `(${booking.length}) appointment is confirmed.\n📅 ${booking.date}\n🕒 ${booking.time}`;

        if (booking.method === "whatsapp") await sendWhatsApp(booking.clientPhone, message);
        else await sendSms(booking.clientPhone, message);
      });

      console.log(`Booking ${bookingId} verified and confirmed.`);
      return res.status(200).send("Webhook processed");
    }

    return res.status(200).send("Event ignored");
  } catch (err) {
    console.error("Webhook error:", err.message);
    return res.status(500).send("Internal Server Error");
  }
});

// -------------------- 5-HOUR REMINDERS --------------------

/**
 * Send reminders 5 hours before accepted bookings.
 */
exports.sendFiveHourReminders = functions.pubsub.schedule("every 5 minutes").onRun(
  async () => {
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
      const message =
        `⏰ Reminder\nHi ${booking.clientName}, your ${booking.style} ` +
        `(${booking.length}) appointment is in 5 hours.\n📅 ${booking.date}\n🕒 ${booking.time}`;

      try {
        if (booking.method === "whatsapp") await sendWhatsApp(booking.clientPhone, message);
        else await sendSms(booking.clientPhone, message);

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
  }
);
