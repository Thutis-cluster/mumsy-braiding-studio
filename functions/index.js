
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

      // ---------------- PRICE MAP (SERVER CONTROLLED) ----------------
      const priceMap = {
        "Box Braids": { Short: 200, Medium: 300, Long: 500 },
        "Knotless Braids": { Short: 250, Medium: 350, Long: 600 },
        "CornRows": { Simple: 150 },
        "Ben & Betty": { Simple: 120 }
      };

      const price = priceMap[style]?.[length];

      if (!price) {
        throw new Error("Invalid style or length");
      }

      // ---------------- CREATE BOOKING ----------------
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

      // ---------------- PAYSTACK INIT ----------------
      const response = await axios.post(
        "https://api.paystack.co/transaction/initialize",
        {
          email,
          amount: price * 100,
          metadata: {
            bookingId: bookingRef.id
          },
          callback_url: "https://YOURDOMAIN.com/thank-you.html"
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`,
            "Content-Type": "application/json"
          }
        }
      );

      return {
        authorization_url: response.data.data.authorization_url
      };

    } catch (err) {
      console.error("❌ createBooking error:", err);
      throw new Error("Unable to start booking");
    }
  }
);

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
export const paystackWebhook = onRequest(
  { secrets: ["PAYSTACK_SECRET"] },
  async (req, res) => {
    try {
      if (req.method !== "POST") {
        return res.status(405).send("Method not allowed");
      }

      const hash = crypto
        .createHmac("sha512", process.env.PAYSTACK_SECRET)
        .update(req.rawBody)
        .digest("hex");

      if (hash !== req.headers["x-paystack-signature"]) {
        return res.status(400).send("Invalid signature");
      }

      const event = req.body;

      if (event.event === "charge.success") {

        const bookingId = event.data.metadata?.bookingId;
        const amount = event.data.amount;

        if (!bookingId) {
          return res.status(400).send("Missing bookingId");
        }

        const bookingRef = db.collection("bookings").doc(bookingId);

        await db.runTransaction(async (tx) => {
          const snap = await tx.get(bookingRef);
          if (!snap.exists) throw new Error("Booking not found");

          const booking = snap.data();

          if (booking.paymentStatus === "Paid") {
            return;
          }

          tx.update(bookingRef, {
            paymentStatus: "Paid",
            depositPaid: amount / 100,
            status: "Accepted",
            receiptEmailSent: false
          });

          const message = `✅ Booking confirmed!
Hi ${booking.clientName}, your ${booking.style} appointment is confirmed.
📅 ${booking.date}
🕒 ${booking.time}`;

          await sendMessage(booking.clientPhone, message, booking.method);
        });

        return res.status(200).send("Webhook processed");
      }

      return res.status(200).send("Event ignored");

    } catch (err) {
      console.error("Webhook error:", err);
      return res.status(500).send("Server error");
    }
  }
);

// -------------------- TEST FUNCTION --------------------
export const testFn = onCall(() => {
  return { ok: true };
});
