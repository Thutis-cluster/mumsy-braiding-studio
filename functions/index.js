// index.js
import { onCall } from "firebase-functions/v2/https";
import { onRequest } from "firebase-functions/v2/https";
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
    await client.messages.create({
      body: message,
      from: TWILIO_WHATSAPP,
      to: `whatsapp:${phone}`,
    });
  } else {
    await client.messages.create({
      body: message,
      from: TWILIO_SMS,
      to: phone,
    });
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

// -------------------- CREATE BOOKING --------------------
export const createBooking = onCall(async (data) => {
  try {
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
    } = data;

    if (!style || !length || !price || !clientName || !clientPhone || !date || !time || !email) {
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
      { email, amount: Math.round(price * 100), metadata: { bookingId: bookingRef.id } },
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET}` } }
    );

    return { authorization_url: response.data.data.authorization_url };
  } catch (err) {
    console.error("❌ createBooking failed:", err.message);
    throw new Error("Could not start payment");
  }
});

// -------------------- TEST SECRETS --------------------
export const testSecrets = onCall(() => {
  return {
    paystack: !!process.env.PAYSTACK_SECRET,
    twilioSID: !!process.env.TWILIO_SID,
    twilioToken: !!process.env.TWILIO_TOKEN,
    twilioSMS: !!process.env.TWILIO_SMS,
  };
});

// -------------------- PAYSTACK WEBHOOK --------------------
export const paystackWebhook = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).send("Method not allowed");

    const signature = req.headers["x-paystack-signature"];
    const hash = crypto
      .createHmac("sha512", process.env.PAYSTACK_SECRET)
      .update(JSON.stringify(req.body))
      .digest("hex");

    if (hash !== signature) return res.status(400).send("Invalid signature");

    const event = req.body;

    if (event.event === "charge.success") {
      const { metadata, amount } = event.data;
      const bookingId = metadata?.bookingId;
      if (!bookingId) return res.status(400).send("Missing bookingId");

      const bookingRef = db.collection("bookings").doc(bookingId);

      await db.runTransaction(async (tx) => {
        const snap = await tx.get(bookingRef);
        const booking = snap.data();
        if (!booking) throw new Error("Booking not found");
        if (booking.paymentStatus === "Paid") return;

        tx.update(bookingRef, {
          paymentStatus: "Paid",
          depositPaid: amount / 100,
          status: "Accepted",
          receiptEmailSent: false,
        });

        const message = `✅ Booking confirmed!\nHi ${booking.clientName}, your ${booking.style} (${booking.length}) appointment is confirmed.\n📅 ${booking.date}\n🕒 ${booking.time}`;
        await sendMessage(booking.clientPhone, message, booking.method);
      });

      console.log(`Booking ${bookingId} verified and confirmed.`);
      return res.status(200).send("Webhook processed");
    }

    return res.status(200).send("Event ignored");
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    return res.status(500).send("Internal Server Error");
  }
});

// -------------------- TEST FUNCTION --------------------
export const testFn = onCall(() => {
  return { ok: true };
});
