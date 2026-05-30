import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

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

const SUPER_ADMINS = ['bersamacerdas1@gmail.com'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'email dan password wajib diisi' });
  }

  // Hanya admin yang bisa buat user manual
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
    return res.status(403).json({ error: 'Hanya super admin yang bisa buat user manual' });
  }

  try {
    const userRecord = await adminAuth.createUser({ email, password });
    return res.status(200).json({ uid: userRecord.uid });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
