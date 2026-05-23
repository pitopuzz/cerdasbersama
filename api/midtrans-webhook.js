import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { credential } from 'firebase-admin';
import crypto from 'crypto';

// Init Firebase Admin
if (!getApps().length) {
  initializeApp({
    credential: credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
    })
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { order_id, status_code, gross_amount, signature_key, transaction_status, fraud_status } = req.body;

  // Verifikasi signature dari Midtrans
  const serverKey = process.env.MIDTRANS_SERVER_KEY;
  const hash = crypto.createHash('sha512')
    .update(order_id + status_code + gross_amount + serverKey)
    .digest('hex');

  if (hash !== signature_key) {
    return res.status(403).json({ error: 'Invalid signature' });
  }

  // Cek status transaksi
  const isSuccess = transaction_status === 'settlement' ||
    (transaction_status === 'capture' && fraud_status === 'accept');

  if (isSuccess) {
    try {
      const db = getFirestore();
      // Update order di Firestore berdasarkan order_id
      const ordersRef = db.collection('orders');
      const snap = await ordersRef.where('midtransOrderId', '==', order_id).get();

      if (!snap.empty) {
        const orderDoc = snap.docs[0];
        await orderDoc.ref.update({ status: 'paid' });
      }
    } catch (e) {
      console.error('Firestore error:', e);
    }
  }

  return res.status(200).json({ status: 'ok' });
}
