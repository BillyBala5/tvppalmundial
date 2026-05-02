// functions/api/yappy-callback.js
// Cloudflare Pages Function — GET /api/yappy-callback

async function hmacSha256Hex(key, message) {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function validateYappyHash(env, { orderId, status, domain, hash }) {
  if (!orderId || !status || !domain || !hash || !env.YAPPY_SECRET) return false;
  let decoded;
  try {
    decoded = atob(env.YAPPY_SECRET);
  } catch {
    return false;
  }
  const [secret] = decoded.split('.');
  if (!secret) return false;
  const expected = await hmacSha256Hex(secret, `${orderId}${status}${domain}`);
  return timingSafeEqual(expected, hash.toLowerCase());
}

function buildOrderMessage(order) {
  return [
    "🎉 *PAGO CONFIRMADO* — TVs pa'l Mundial",
    '',
    `*Orden:* ${order.orderId}`,
    `*Confirmación Yappy:* ${order.confirmationNumber || 'N/A'}`,
    '',
    `📺 *Modelo:* ${order.modelLabel}`,
    `💰 *Total cobrado:* $${order.total.toFixed(2)}`,
    `   • Tele: $${order.productPrice.toFixed(2)}`,
    `   • Envío: $${order.shipCost.toFixed(2)}`,
    '',
    `👤 *Cliente:* ${order.nombre}`,
    `📞 ${order.telefono}`,
    '',
    '🏠 *Entrega:*',
    `Provincia: ${order.provincia}`,
    `Barrio: ${order.barrio}`,
    `Dirección: ${order.direccion}`,
    '',
    order.sameDay ? '⚡ *ENTREGA EL MISMO DÍA*' : '📦 Entrega siguiente día hábil',
  ].join('\n');
}

function buildOrderHTML(order) {
  const esc = s => String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  return `<div style="font-family: -apple-system, system-ui, sans-serif; max-width: 540px; margin: 0 auto; color: #0a1530;">
  <div style="background: #0a2a5e; color: #fff; padding: 20px; border-radius: 12px 12px 0 0;">
    <h1 style="margin: 0 0 6px; font-size: 22px;">🎉 Pago confirmado</h1>
    <p style="margin: 0; opacity: 0.85;">Orden #${esc(order.orderId)}</p>
  </div>
  <div style="background: #f6f1e3; padding: 22px; border: 1px solid #ddd; border-top: 0; border-radius: 0 0 12px 12px;">
    <h2 style="margin: 0 0 8px; font-size: 18px; color: #d8262a;">${esc(order.modelLabel)}</h2>
    <table style="width: 100%; border-collapse: collapse; margin: 12px 0;">
      <tr><td style="padding: 6px 0;">Tele</td><td style="padding: 6px 0; text-align: right;">$${order.productPrice.toFixed(2)}</td></tr>
      <tr><td style="padding: 6px 0;">Envío</td><td style="padding: 6px 0; text-align: right;">$${order.shipCost.toFixed(2)}</td></tr>
      <tr style="border-top: 2px solid #0a2a5e;"><td style="padding: 8px 0; font-weight: 700;">Total</td><td style="padding: 8px 0; text-align: right; font-weight: 700; color: #d8262a;">$${order.total.toFixed(2)}</td></tr>
    </table>
    <h3 style="margin: 16px 0 6px; font-size: 14px; color: #4a5573; text-transform: uppercase; letter-spacing: 0.05em;">Cliente</h3>
    <p style="margin: 0 0 4px;"><strong>${esc(order.nombre)}</strong></p>
    <p style="margin: 0;">📞 ${esc(order.telefono)}</p>
    <h3 style="margin: 16px 0 6px; font-size: 14px; color: #4a5573; text-transform: uppercase; letter-spacing: 0.05em;">Entrega</h3>
    <p style="margin: 0 0 4px;">${esc(order.provincia)} — ${esc(order.barrio)}</p>
    <p style="margin: 0; line-height: 1.5;">${esc(order.direccion)}</p>
    <div style="margin-top: 18px; padding: 12px; background: ${order.sameDay ? '#d8262a' : '#0a2a5e'}; color: #fff; border-radius: 8px; text-align: center; font-weight: 700;">
      ${order.sameDay ? '⚡ ENTREGA EL MISMO DÍA' : '📦 Entrega siguiente día hábil'}
    </div>
    ${order.confirmationNumber ? `<p style="margin: 14px 0 0; font-size: 12px; color: #4a5573;">Confirmación Yappy: ${esc(order.confirmationNumber)}</p>` : ''}
  </div>
</div>`;
}

async function sendWhatsApp(env, message) {
  if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_ID || !env.MERCHANT_WHATSAPP) {
    return { skipped: true, reason: 'WhatsApp no configurado' };
  }
  const res = await fetch(
    `https://graph.facebook.com/v18.0/${env.WHATSAPP_PHONE_ID}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: env.MERCHANT_WHATSAPP,
        type: 'text',
        text: { preview_url: false, body: message },
      }),
    }
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function sendEmail(env, subject, html) {
  if (!env.RESEND_API_KEY || !env.ALERT_EMAIL) {
    return { skipped: true, reason: 'Resend no configurado' };
  }
  const from = env.FROM_EMAIL || `TVs pa'l Mundial <onboarding@resend.dev>`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: [env.ALERT_EMAIL], subject, html }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Resend ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function notifyMerchant(env, order) {
  const msg = buildOrderMessage(order);
  const html = buildOrderHTML(order);
  const subject = `🎉 Pedido #${order.orderId} pagado · ${order.modelLabel}`;

  const results = await Promise.all([
    sendWhatsApp(env, msg)
      .then(r => ({ channel: 'whatsapp', ok: !r.skipped, result: r }))
      .catch(e => ({ channel: 'whatsapp', ok: false, error: e.message })),
    sendEmail(env, subject, html)
      .then(r => ({ channel: 'email', ok: !r.skipped, result: r }))
      .catch(e => ({ channel: 'email', ok: false, error: e.message })),
  ]);

  results.forEach(r => {
    if (!r.ok && r.error) console.error(`[notify:${r.channel}]`, r.error);
    else if (r.ok) console.log(`[notify:${r.channel}] ok`);
  });
  return results;
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    if (!env.ORDERS) throw new Error('Falta binding KV "ORDERS"');
    if (!env.YAPPY_SECRET) throw new Error('Falta YAPPY_SECRET');

    const url = new URL(request.url);
    const orderId = url.searchParams.get('orderId');
    const status = url.searchParams.get('status');
    const hash = url.searchParams.get('hash');
    const domain = url.searchParams.get('domain');
    const confirmationNumber = url.searchParams.get('confirmationNumber');

    if (!orderId || !status || !hash || !domain) {
      return Response.json({ success: false, error: 'Missing params' }, { status: 400 });
    }

    const valid = await validateYappyHash(env, { orderId, status, domain, hash });
    if (!valid) {
      console.warn('[yappy-callback] Invalid hash', orderId);
      return Response.json({ success: false });
    }

    console.log(`[yappy-callback] Valid IPN: order=${orderId} status=${status}`);

    if (status === 'E') {
      const stored = await env.ORDERS.get(`order:${orderId}`);
      if (!stored) {
        console.warn(`[yappy-callback] Order ${orderId} not found in KV`);
      } else {
        const order = JSON.parse(stored);
        await notifyMerchant(env, { ...order, confirmationNumber });
        await env.ORDERS.delete(`order:${orderId}`);
      }
    } else {
      await env.ORDERS.delete(`order:${orderId}`).catch(() => {});
    }

    return Response.json({ success: true });
  } catch (err) {
    console.error('[yappy-callback]', err);
    return Response.json({ success: false });
  }
}

export async function onRequest(context) {
  return new Response('Method Not Allowed', {
    status: 405,
    headers: { Allow: 'GET' },
  });
}
