import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

// Init Firebase Admin (singleton)
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const adminAuth = getAuth();
const adminDb   = getFirestore();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { uid } = req.body;

  if (!uid) {
    return res.status(400).json({ error: 'uid wajib diisi' });
  }

  // Verifikasi caller adalah super admin
  const SUPER_ADMINS = ['bersamacerdas1@gmail.com'];
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header tidak valid' });
  }
  const idToken = authHeader.slice(7).trim();
  let callerEmail;
  try {
    const decoded = await adminAuth.verifyIdToken(idToken);
    if (!decoded.email) {
      return res.status(401).json({ error: 'Email tidak ditemukan dalam token' });
    }
    callerEmail = decoded.email;
  } catch {
    return res.status(401).json({ error: 'Token tidak valid atau expired' });
  }
  if (!SUPER_ADMINS.includes(callerEmail)) {
    return res.status(403).json({ error: 'Hanya super admin yang bisa hapus user' });
  }

  try {
    // 1. Hapus dari Firebase Auth
    await adminAuth.deleteUser(uid);

    // 2. Hapus dokumen Firestore users/{uid}
    await adminDb.collection('users').doc(uid).delete();

    return res.status(200).json({ success: true, message: `User ${uid} berhasil dihapus` });
  } catch (err) {
    console.error('delete-user error:', err);
    return res.status(500).json({ error: err.message });
  }
}
