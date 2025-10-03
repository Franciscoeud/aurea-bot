import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import { Client as ftpClient } from 'basic-ftp';
import QRCode from 'qrcode';
import { Readable } from 'stream';
import PDFDocument from 'pdfkit';
import dayjs from 'dayjs';
import twilio from 'twilio';

// Load environment variables
dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Twilio setup
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;

// Firebase setup
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8')
  );
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}
const db = admin.firestore();

// FTP Upload QR
async function uploadQRtoFTP(qrBuffer, filename) {
  const client = new ftpClient();
  try {
    await client.access({
      host: process.env.FTP_HOST,
      user: process.env.FTP_USER,
      password: process.env.FTP_PASSWORD,
      secure: false
    });
    await client.ensureDir('/qr');
    const stream = Readable.from(qrBuffer);
    await client.uploadFrom(stream, filename);
    return `https://duomoholding.com/qr/${filename}`;
  } finally {
    client.close();
  }
}

// Generate PDF
async function generarPDFReserva(reserva, qrBuffer) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument();
      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers)));

      doc.fontSize(20).text('Confirmación de Reserva', { align: 'center' });
      doc.moveDown();
      doc.fontSize(12).text(`ID de Reserva: ${reserva.id}`);
      doc.text(`Nombre: ${reserva.nombre}`);
      doc.text(`Fechas: ${reserva.fechaEntrada} a ${reserva.fechaSalida}`);
      doc.text(`Personas: ${reserva.personas}`);
      doc.moveDown();
      doc.text('Escanea este QR al llegar para tu check-in:');
      doc.image(qrBuffer, { fit: [150, 150], align: 'center' });
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// Upload PDF
async function uploadPDFtoFTP(pdfBuffer, filename) {
  const client = new ftpClient();
  try {
    await client.access({
      host: process.env.FTP_HOST,
      user: process.env.FTP_USER,
      password: process.env.FTP_PASSWORD,
      secure: false
    });
    await client.ensureDir('/qr');
    const stream = Readable.from(pdfBuffer);
    await client.uploadFrom(stream, filename);
    return `https://duomoholding.com/qr/${filename}`;
  } finally {
    client.close();
  }
}

// Check availability in Firebase
async function isRangeAvailable({ roomId, startDate, endDate }) {
  const reservasRef = db.collection('reservas');
  const snapshot = await reservasRef
    .where('roomId', '==', roomId)
    .get();

  for (let doc of snapshot.docs) {
    const data = doc.data();
    if (
      !(endDate < data.fechaEntrada || startDate > data.fechaSalida)
    ) {
      return { available: false };
    }
  }
  return { available: true };
}

// WhatsApp Webhook
const sessions = {};

app.post('/whatsapp', async (req, res) => {
  const incomingMsg = req.body.Body?.trim() || '';
  const from = req.body.From;
  const msg = incomingMsg.toLowerCase();

  // If waiting for dates
  if (sessions[from]?.step === 'waiting_dates') {
    const regex = /(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{2}\/\d{2}\/\d{4})/;
    const match = incomingMsg.match(regex);
    if (!match) {
      await sendMessage(from, 'Formato inválido. Ejemplo: 20/10/2025 - 23/10/2025');
      return res.sendStatus(200);
    }

    const startDate = dayjs(match[1], 'DD/MM/YYYY').format('YYYY-MM-DD');
    const endDate = dayjs(match[2], 'DD/MM/YYYY').format('YYYY-MM-DD');
    const roomId = '1';

    const { available } = await isRangeAvailable({ roomId, startDate, endDate });
    if (!available) {
      await sendMessage(from, `😔 No disponible del ${startDate} al ${endDate}.`);
    } else {
      const reserva = {
        nombre: 'Huésped WhatsApp',
        phone: from.replace('whatsapp:', ''),
        fechaEntrada: startDate,
        fechaSalida: endDate,
        roomId,
        personas: 1,
        origen: 'WhatsApp',
        estado: 'confirmada',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      const ref = await db.collection('reservas').add(reserva);

      const qrData = `Reserva ID: ${ref.id}\nCheck-in: ${startDate} - ${endDate}\nRoom: ${roomId}`;
      const qrBuffer = await QRCode.toBuffer(qrData);
      const qrFilename = `reserva-${ref.id}.png`;
      await uploadQRtoFTP(qrBuffer, qrFilename);

      const pdfBuffer = await generarPDFReserva({
        id: ref.id,
        nombre: reserva.nombre,
        fechaEntrada: startDate,
        fechaSalida: endDate,
        personas: reserva.personas
      }, qrBuffer);

      const pdfFilename = `reserva-${ref.id}.pdf`;
      const pdfUrl = await uploadPDFtoFTP(pdfBuffer, pdfFilename);

      await twilioClient.messages.create({
        from: `whatsapp:${TWILIO_WHATSAPP_NUMBER}`,
        to: from,
        body: `✅ Reserva confirmada\nID: ${ref.id}\nFechas: ${startDate} a ${endDate}\nAquí tienes tu confirmación en PDF:`,
        mediaUrl: [pdfUrl]
      });
    }
    delete sessions[from];
    return res.sendStatus(200);
  }

  if (msg === '1') {
    sessions[from] = { step: 'waiting_dates' };
    await sendMessage(from, 'Por favor indícame tus fechas en el formato DD/MM/YYYY - DD/MM/YYYY');
  } else if (msg === 'hola' || msg === 'menu') {
    await sendMessage(from, 'Hola 👋 Opciones:\n1️⃣ Consultar disponibilidad\n2️⃣ Info check-in\n3️⃣ WiFi y cocina\n4️⃣ Hablar con humano');
  } else {
    await sendMessage(from, 'No entendí 🙏 escribe *hola* para ver el menú.');
  }

  res.sendStatus(200);
});

async function sendMessage(to, body, mediaUrl) {
  const opts = { from: `whatsapp:${TWILIO_WHATSAPP_NUMBER}`, to, body };
  if (mediaUrl) opts.mediaUrl = [mediaUrl];
  return twilioClient.messages.create(opts);
}

// Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
