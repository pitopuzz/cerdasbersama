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

  const { email, password, callerEmail } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'email dan password wajib diisi' });
  }

  // Hanya admin yang bisa buat user manual
  if (!callerEmail || !SUPER_ADMINS.includes(callerEmail)) {
    return res.status(403).json({ error: 'Hanya super admin yang bisa buat user manual' });
  }

  try {
    const userRecord = await adminAuth.createUser({ email, password });
    return res.status(200).json({ uid: userRecord.uid });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
