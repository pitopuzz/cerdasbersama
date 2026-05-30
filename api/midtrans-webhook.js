import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
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

  const {
    order_id,
    status_code,
    gross_amount,
    signature_key,
    transaction_status,
    fraud_status
  } = req.body;

  // Verifikasi signature dari Midtrans
  const serverKey = process.env.MIDTRANS_SERVER_KEY;
  const hash = crypto.createHash('sha512')
    .update(order_id + status_code + gross_amount + serverKey)
    .digest('hex');

  if (hash !== signature_key) {
    return res.status(403).json({ error: 'Invalid signature' });
  }

  // Cek status transaksi
  const isSuccess =
    transaction_status === 'settlement' ||
    (transaction_status === 'capture' && fraud_status === 'accept');

  if (isSuccess) {
    try {
      const db = getFirestore();

      // 1. Ambil order dari Firestore
      const ordersRef = db.collection('orders');
      const snap = await ordersRef.where('midtransOrderId', '==', order_id).get();

      if (snap.empty) {
        console.error('Order tidak ditemukan:', order_id);
        return res.status(200).json({ status: 'ok' });
      }

      const orderDoc = snap.docs[0];
      const orderData = orderDoc.data();

      // 2. Idempotency check — jangan proses ulang jika sudah paid
      if (orderData.status === 'paid') {
        console.log(`Order ${order_id} sudah diproses sebelumnya, diabaikan.`);
        return res.status(200).json({ status: 'ok' });
      }

      // 3. Update status order → paid
      await orderDoc.ref.update({ status: 'paid' });

      // 4. Update akses user berdasarkan tipe paket
      const uid = orderData.uid;
      const tipe = orderData.tipe || 'alacarte';
      const subBabDibeli = orderData.subBabDibeli || [];
      const tryOutSegmen = orderData.tryOutSegmen || [];
      const komisi = orderData.komisi || 0;
      const refCode = orderData.refCode || null;

      const userRef = db.collection('users').doc(uid);

      if (tipe === 'tryout') {
        // Try out → tambah segmen ke tryOutAkses
        await userRef.update({
          tryOutAkses: FieldValue.arrayUnion(...tryOutSegmen),
        });

      } else if (tipe === 'bulanan') {
        // Premium bulanan → buka semua akses
        const expiredAt = new Date();
        expiredAt.setMonth(expiredAt.getMonth() + 1);

        await userRef.update({
          plan: 'premium',
          subBabAkses: ['__premium__'],
          expiredAt,
        });

      } else {
        // À la carte atau bundling → tambah sub-bab ke akses yang sudah ada
        await userRef.update({
          plan: 'alacarte',
          subBabAkses: FieldValue.arrayUnion(...subBabDibeli),
        });
      }

      // 4. Update komisi referrer (kalau ada kode referral)
      if (refCode && komisi > 0) {
        const refSnap = await db.collection('users')
          .where('referralCode', '==', refCode)
          .get();

        if (!refSnap.empty) {
          await refSnap.docs[0].ref.update({
            komisiTotal: FieldValue.increment(komisi)
          });
        }
      }

      console.log(`✅ Order ${order_id} berhasil diproses. Akses: ${tipe} → ${subBabDibeli.join(', ')}`);

    } catch (e) {
      console.error('Firestore error:', e);
    }
  }

  return res.status(200).json({ status: 'ok' });
}
