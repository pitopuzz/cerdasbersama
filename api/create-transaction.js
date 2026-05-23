const https = require('https');

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { orderId, amount, customerEmail, customerName, itemName } = req.body;

  const serverKey = process.env.MIDTRANS_SERVER_KEY;
  const auth = Buffer.from(serverKey + ':').toString('base64');

  const payload = JSON.stringify({
    transaction_details: {
      order_id: orderId,
      gross_amount: amount
    },
    item_details: [{
      id: orderId,
      price: amount,
      quantity: 1,
      name: itemName || 'Paket Belajar CerdasBersama'
    }],
    customer_details: {
      email: customerEmail,
      first_name: customerName || 'User'
    },
    callbacks: {
      finish: 'https://cerdasbersama.vercel.app/dashboard-referral.html'
    }
  });

  try {
    const response = await fetch('https://app.sandbox.midtrans.com/snap/v1/transactions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`
      },
      body: payload
    });

    const data = await response.json();

    if (data.token) {
      return res.status(200).json({ token: data.token });
    } else {
      return res.status(400).json({ error: data });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
