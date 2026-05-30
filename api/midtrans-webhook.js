import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { credential } from 'firebase-admin';
import crypto from 'crypto';

// ─────────────────────────────────────────
// Firebase Admin init
// ─────────────────────────────────────────
if (!getApps().length) {
  initializeApp({
    credential: credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

// ─────────────────────────────────────────
// calculateCommissions()
//
// Pure function — no DB calls.
// Implements Cases A–E from frozen spec.
//
// Params:
//   paidAmount        number  — order.total (post-discount)
//   commissionPoolPct number  — from promoCodes.komisi
//   referrerUid       string|null
//   promoOwnerUid     string|null
//
// Returns array of:
//   { type: 'referral'|'promo', beneficiaryUid: string, amount: number, pct: number }
// ─────────────────────────────────────────
function calculateCommissions({ paidAmount, commissionPoolPct, referrerUid, promoOwnerUid }) {
  // Guard: no money to split
  if (!paidAmount || paidAmount <= 0) return [];

  const hasReferrer  = !!referrerUid;
  const hasPromo     = !!promoOwnerUid;
  const pool         = commissionPoolPct || 0;

  // Case E — no referrer, no promo
  if (!hasReferrer && !hasPromo) return [];

  // Case A — referrer only, no promo
  if (hasReferrer && !hasPromo) {
    return [{
      type:            'referral',
      beneficiaryUid:  referrerUid,
      amount:          Math.round(paidAmount * 15 / 100),
      pct:             15,
    }];
  }

  // Case D — promo only, no referrer
  if (!hasReferrer && hasPromo) {
    return [{
      type:            'promo',
      beneficiaryUid:  promoOwnerUid,
      amount:          Math.round(paidAmount * pool / 100),
      pct:             pool,
    }];
  }

  // Both referrer and promo exist — Cases B and C
  if (hasReferrer && hasPromo) {

    // Case C — referrer === promo owner, avoid double count
    if (referrerUid === promoOwnerUid) {
      return [{
        type:            'promo',
        beneficiaryUid:  promoOwnerUid,
        amount:          Math.round(paidAmount * pool / 100),
        pct:             pool,
      }];
    }

    // Case B — referrer !== promo owner, split
    const referrerAmount  = Math.round(paidAmount * 15 / 100);
    const promoSharePct   = pool - 15;
    const promoAmount     = Math.round(paidAmount * promoSharePct / 100);

    const entries = [{
      type:            'referral',
      beneficiaryUid:  referrerUid,
      amount:          referrerAmount,
      pct:             15,
    }];

    // Per frozen spec: if promoSharePct === 0, do NOT create promo record
    if (promoSharePct > 0 && promoAmount > 0) {
      entries.push({
        type:           'promo',
        beneficiaryUid: promoOwnerUid,
        amount:         promoAmount,
        pct:            promoSharePct,
      });
    }

    return entries;
  }

  return [];
}

// ─────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────
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
    fraud_status,
  } = req.body;

  // ── 1. Verify Midtrans signature ──────────────────────────────────
  const serverKey = process.env.MIDTRANS_SERVER_KEY;
  const hash = crypto.createHash('sha512')
    .update(order_id + status_code + gross_amount + serverKey)
    .digest('hex');

  if (hash !== signature_key) {
    return res.status(403).json({ error: 'Invalid signature' });
  }

  // ── 2. Check transaction status ───────────────────────────────────
  const isSuccess =
    transaction_status === 'settlement' ||
    (transaction_status === 'capture' && fraud_status === 'accept');

  if (!isSuccess) {
    return res.status(200).json({ status: 'ok' });
  }

  try {
    const db = getFirestore();

    // ── 3. Load order ───────────────────────────────────────────────
    const ordersRef = db.collection('orders');
    const snap      = await ordersRef.where('midtransOrderId', '==', order_id).get();

    if (snap.empty) {
      console.error(`[webhook] Order tidak ditemukan: ${order_id}`);
      return res.status(200).json({ status: 'ok' });
    }

    const orderDoc  = snap.docs[0];
    const orderData = orderDoc.data();

    // ── 4. Idempotency — primary gate ───────────────────────────────
    // order.status === 'paid' is the source of truth.
    // commissionCalculated is diagnostic only.
    if (orderData.status === 'paid') {
      console.log(`[webhook] Order ${order_id} sudah paid, diabaikan.`);
      return res.status(200).json({ status: 'ok' });
    }

    // ── 5. Mark order as paid immediately ───────────────────────────
    // Done before any other writes so duplicate webhooks are blocked
    // even if subsequent steps are still running.
    await orderDoc.ref.update({ status: 'paid' });

    // ── 6. Extract order fields ──────────────────────────────────────
    const uid          = orderData.uid;
    const tipe         = orderData.tipe || 'alacarte';
    const subBabDibeli = orderData.subBabDibeli  || [];
    const tryOutSegmen = orderData.tryOutSegmen  || [];
    const paidAmount   = orderData.total         || 0;   // post-discount basis
    const promoDocId   = orderData.promoDocId    || null;
    const refCode      = orderData.refCode       || null;

    const userRef = db.collection('users').doc(uid);

    // ── 7. Grant product access ──────────────────────────────────────
    // Unchanged from Step 3 — access grant is independent of commission.
    if (tipe === 'tryout') {
      await userRef.update({
        tryOutAkses: FieldValue.arrayUnion(...tryOutSegmen),
      });

    } else if (tipe === 'bulanan') {
      const expiredAt = new Date();
      expiredAt.setMonth(expiredAt.getMonth() + 1);
      await userRef.update({
        plan:        'premium',
        subBabAkses: ['__premium__'],
        expiredAt,
      });

    } else {
      await userRef.update({
        plan:        'alacarte',
        subBabAkses: FieldValue.arrayUnion(...subBabDibeli),
      });
    }

    // ── 8. Set hasUsedReferral + referredBy (first-time only) ────────
    if (orderData.shouldSetReferral === true) {
      await userRef.update({
        hasUsedReferral: true,
        referredBy:      refCode,
      });
    }

    // ── 9. Increment promo usedCount ─────────────────────────────────
    if (orderData.isPromoCode === true && promoDocId) {
      await db.collection('promoCodes').doc(promoDocId).update({
        usedCount: FieldValue.increment(1),
      });
    }

    // ── 10. Commission engine ────────────────────────────────────────

    // 10a. Load buyer to get referredBy (source of truth for referral)
    const buyerSnap = await userRef.get();
    const buyerData = buyerSnap.exists ? buyerSnap.data() : {};
    const referredBy = buyerData.referredBy || null;  // lifetime referral

    // 10b. Resolve referrerUid from referralCode
    let referrerUid = null;
    if (referredBy) {
      const referrerSnap = await db.collection('users')
        .where('referralCode', '==', referredBy)
        .get();
      if (!referrerSnap.empty) {
        referrerUid = referrerSnap.docs[0].id;
      } else {
        console.warn(`[webhook] referralCode "${referredBy}" tidak ditemukan di users.`);
      }
    }

    // 10c. Load promo doc to get ownerUid and commissionPoolPct
    let promoOwnerUid     = null;
    let commissionPoolPct = 0;
    let promoCodeSnapshot = null;

    if (promoDocId) {
      const promoSnap = await db.collection('promoCodes').doc(promoDocId).get();
      if (promoSnap.exists) {
        const promoData   = promoSnap.data();
        promoOwnerUid     = promoData.ownerUid   || null;
        commissionPoolPct = promoData.komisi      || 0;
        promoCodeSnapshot = promoData.code        || promoDocId;
      } else {
        console.warn(`[webhook] promoDocId "${promoDocId}" tidak ditemukan di promoCodes.`);
      }
    }

    // 10d. Guard: invalid commissionPoolPct
    // Only relevant when there IS a promo. Referral-only (Case A) always uses 15%.
    if (promoOwnerUid && commissionPoolPct < 15) {
      console.error(
        `[webhook] CRITICAL: commissionPoolPct=${commissionPoolPct} < 15 ` +
        `untuk promoDocId=${promoDocId}, orderId=${order_id}. ` +
        `Commission dilewati. Akses user sudah diberikan.`
      );
      // Skip commission — do not proceed to transaction
      console.log(`✅ Order ${order_id} selesai (tanpa komisi — invalid pool config).`);
      return res.status(200).json({ status: 'ok' });
    }

    // 10e. Calculate commission entries (pure, no DB)
    const commissionEntries = calculateCommissions({
      paidAmount,
      commissionPoolPct,
      referrerUid,
      promoOwnerUid,
    });

    // 10f. If no commission to distribute, just update diagnostic flag and exit
    if (commissionEntries.length === 0) {
      await orderDoc.ref.update({
        commissionCalculated:   true,
        referredBySnapshot:     referredBy     || null,
        promoSnapshot:          promoCodeSnapshot || null,
        commissionPoolPctSnapshot: commissionPoolPct || null,
      });
      console.log(`✅ Order ${order_id} selesai (tidak ada komisi — Case E).`);
      return res.status(200).json({ status: 'ok' });
    }

    // 10g. Firestore Transaction — atomic commission writes
    // Covers: commission ledger + user balance updates + order snapshot
    await db.runTransaction(async (tx) => {

      for (const entry of commissionEntries) {
        // Doc ID format: {orderId}_{beneficiaryUid}_{type}
        // Provides idempotency + auditability per frozen spec
        const commissionDocId  = `${orderDoc.id}_${entry.beneficiaryUid}_${entry.type}`;
        const commissionRef    = db.collection('commissions').doc(commissionDocId);
        const beneficiaryRef   = db.collection('users').doc(entry.beneficiaryUid);

        // Write commission ledger record (append-only)
        tx.set(commissionRef, {
          orderId:               orderDoc.id,
          beneficiaryUid:        entry.beneficiaryUid,
          type:                  entry.type,           // 'referral' | 'promo'
          amount:                entry.amount,
          pct:                   entry.pct,
          paidAmount:            paidAmount,
          commissionPoolPct:     commissionPoolPct,
          buyerUid:              uid,
          status:                'earned',             // per frozen spec: payment success = earned
          referralCodeSnapshot:  referredBy     || null,
          promoCodeSnapshot:     promoCodeSnapshot || null,
          createdAt:             FieldValue.serverTimestamp(),
        });

        // Update beneficiary's cached balance fields
        tx.update(beneficiaryRef, {
          komisiEarned:    FieldValue.increment(entry.amount),
          komisiAvailable: FieldValue.increment(entry.amount),
        });
      }

      // Update order with commission snapshots and diagnostic flag
      tx.update(orderDoc.ref, {
        commissionCalculated:      true,
        referredBySnapshot:        referredBy        || null,
        promoSnapshot:             promoCodeSnapshot || null,
        commissionPoolPctSnapshot: commissionPoolPct || null,
      });
    });

    console.log(
      `✅ Order ${order_id} selesai. Komisi: ` +
      commissionEntries.map(e => `${e.type} → ${e.beneficiaryUid} Rp${e.amount}`).join(', ')
    );

  } catch (e) {
    console.error(`[webhook] Error pada order ${order_id}:`, e);
    // Always return 200 to Midtrans — prevents unnecessary retries
    // for errors that are not signature/validation failures
  }

  return res.status(200).json({ status: 'ok' });
}
