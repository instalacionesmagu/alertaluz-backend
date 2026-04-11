const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_EMAIL = 'instalacionesmagu@gmail.com';

app.use(cors());
app.use(express.json());

function formatearFecha(isoString) {
  if (!isoString) return 'desconocida';
  const fecha = new Date(isoString);
  return fecha.toLocaleString('es-ES', {
    timeZone: 'Europe/Madrid',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function formatearFechaSolo(dateString) {
  if (!dateString) return 'sin fecha';
  const [y, m, d] = dateString.split('-');
  return `${d}/${m}/${y}`;
}

function verificarAdmin(req, res) {
  const clave = req.query.clave || req.body?.clave;
  if (clave !== process.env.ADMIN_KEY) {
    res.status(401).json({ ok: false, error: 'No autorizado' });
    return false;
  }
  return true;
}

function mesActual() {
  return new Date().toISOString().slice(0, 7);
}

async function enviarTelegram(chatId, mensaje) {
  if (!chatId || !TELEGRAM_TOKEN) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = JSON.stringify({ chat_id: chatId, text: mensaje, parse_mode: 'HTML' });
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      res.on('data', () => {});
      res.on('end', resolve);
    });
    req.on('error', (e) => console.error('Error Telegram:', e.message));
    req.write(body);
    req.end();
  });
}

async function enviarPush(externalId, titulo, mensaje) {
  if (!process.env.ONESIGNAL_APP_ID || !process.env.ONESIGNAL_API_KEY) return;
  try {
    const body = JSON.stringify({
      app_id: process.env.ONESIGNAL_APP_ID,
      include_aliases: { external_id: [externalId] },
      target_channel: 'push',
      headings: { es: titulo, en: titulo },
      contents: { es: mensaje, en: mensaje }
    });
    const options = {
      hostname: 'api.onesignal.com',
      path: '/notifications',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Key ${process.env.ONESIGNAL_API_KEY}`
      }
    };
    return new Promise((resolve) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          console.log(`Push enviado a ${externalId}: ${data}`);
          resolve();
        });
      });
      req.on('error', e => console.error('Error push:', e.message));
      req.write(body);
      req.end();
    });
  } catch(e) {
    console.error('Error push:', e.message);
  }
}

async function enviarEmailAlerta(dispositivo, tipo) {
  if (!dispositivo.email_cliente) return;
  const esOffline = tipo === 'offline';
  const nombre = dispositivo.nombre || dispositivo.chip_id;
  const horaEvento = formatearFecha(dispositivo.ultimo_ping);
  const horaAhora = formatearFecha(new Date().toISOString());

  const asunto = esOffline
    ? `⚠️ Alerta: ${nombre} sin señal desde las ${horaEvento}`
    : `✅ Restablecido: ${nombre} vuelve a estar online`;

  const mensajeHTML = esOffline
    ? `<h2 style="color:#c0392b">⚠️ Dispositivo sin señal</h2>
       <p>Tu dispositivo <b>${nombre}</b> ha dejado de enviar señal.</p>
       <p>Puede ser un corte de luz o de internet.</p><br>
       <table style="border-collapse:collapse">
         <tr><td style="padding:4px 12px 4px 0"><b>Último ping recibido:</b></td><td>${horaEvento}</td></tr>
         <tr><td style="padding:4px 12px 4px 0"><b>Alerta generada a las:</b></td><td>${horaAhora}</td></tr>
       </table>`
    : `<h2 style="color:#27ae60">✅ Servicio restablecido</h2>
       <p>Tu dispositivo <b>${nombre}</b> ha vuelto a conectarse.</p><br>
       <table style="border-collapse:collapse">
         <tr><td style="padding:4px 12px 4px 0"><b>Motivo del corte:</b></td><td>${dispositivo.motivo_corte || 'desconocido'}</td></tr>
         <tr><td style="padding:4px 12px 4px 0"><b>Última señal antes del corte:</b></td><td>${horaEvento}</td></tr>
         <tr><td style="padding:4px 12px 4px 0"><b>Reconexión a las:</b></td><td>${horaAhora}</td></tr>
       </table>`;

  // Destinatarios: email principal + emails extra si están activos
  const destinatarios = [dispositivo.email_cliente];
  if (dispositivo.extra_email_multiple && dispositivo.extra_emails) {
    dispositivo.extra_emails.split(',').forEach(e => {
      const em = e.trim();
      if (em && !destinatarios.includes(em)) destinatarios.push(em);
    });
  }
  if (dispositivo.admin_email_copia && !destinatarios.includes(ADMIN_EMAIL)) {
    destinatarios.push(ADMIN_EMAIL);
  }

  await resend.emails.send({
    from: 'AlertaLuz <alertas@alertaluz.es>',
    to: destinatarios,
    subject: asunto,
    html: mensajeHTML
  });
  console.log(`Email enviado a ${destinatarios.join(', ')}`);
}

async function enviarAlertaCompleta(dispositivo, tipo) {
  const nombre = dispositivo.nombre || dispositivo.chip_id;
  const horaEvento = formatearFecha(dispositivo.ultimo_ping);
  const horaAhora = formatearFecha(new Date().toISOString());

  await enviarEmailAlerta(dispositivo, tipo);

  // Telegram principal
  if (dispositivo.telegram_activo && dispositivo.telegram_chat_id) {
    const msg = tipo === 'offline'
      ? `⚠️ <b>Sin señal</b>\n\nDispositivo: <b>${nombre}</b>\nÚltimo ping: ${horaEvento}\nAlerta generada: ${horaAhora}`
      : `✅ <b>Servicio restablecido</b>\n\nDispositivo: <b>${nombre}</b>\nMotivo: ${dispositivo.motivo_corte || 'desconocido'}\nReconexión: ${horaAhora}`;
    await enviarTelegram(dispositivo.telegram_chat_id, msg);
  }

  // Telegram múltiple
  if (dispositivo.extra_telegram_multiple && dispositivo.extra_telegram_ids) {
    const ids = dispositivo.extra_telegram_ids.split(',').map(id => id.trim()).filter(Boolean);
    for (const chatId of ids) {
      if (chatId !== dispositivo.telegram_chat_id) {
        const msg = tipo === 'offline'
          ? `⚠️ <b>Sin señal</b>\n\nDispositivo: <b>${nombre}</b>\nÚltimo ping: ${horaEvento}\nAlerta generada: ${horaAhora}`
          : `✅ <b>Servicio restablecido</b>\n\nDispositivo: <b>${nombre}</b>\nMotivo: ${dispositivo.motivo_corte || 'desconocido'}\nReconexión: ${horaAhora}`;
        await enviarTelegram(chatId, msg);
      }
    }
  }

  // Push notifications
  if (dispositivo.extra_push && dispositivo.email_cliente) {
    const pushTitulo = tipo === 'offline' ? `⚠️ ${nombre} sin señal` : `✅ ${nombre} restablecido`;
    const pushMsg = tipo === 'offline'
      ? `Último ping: ${horaEvento}`
      : `Motivo: ${dispositivo.motivo_corte || 'desconocido'} · Reconexión: ${horaAhora}`;
    await enviarPush(dispositivo.email_cliente, pushTitulo, pushMsg);
  }
}

async function enviarEmailBienvenida(email, nombre, nombreDispositivo, password, expiracion) {
  const fechaExp = formatearFechaSolo(expiracion);
  await resend.emails.send({
    from: 'AlertaLuz <alertas@alertaluz.es>',
    to: email,
    subject: `✅ ¡Bienvenido a AlertaLuz! Tu dispositivo está activo`,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto">
        <div style="background:linear-gradient(135deg,#1565C0,#1976D2);padding:24px;border-radius:12px 12px 0 0;text-align:center">
          <h1 style="color:white;margin:0;font-size:24px">⚡ AlertaLuz</h1>
          <p style="color:#FFD600;margin:6px 0 0;font-size:13px">MaGu Multiservicios</p>
        </div>
        <div style="background:white;padding:28px;border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px">
          <h2 style="color:#1a1a2e;margin-top:0">✅ ¡Tu dispositivo está activo!</h2>
          <p>Hola <b>${nombre}</b>, tu dispositivo AlertaLuz ha sido configurado correctamente.</p>
          <br>
          <div style="background:#e3f2fd;border-radius:10px;padding:20px;margin:16px 0">
            <p style="margin:0 0 8px;font-weight:600;color:#1565C0">📱 Datos de tu dispositivo</p>
            <table style="border-collapse:collapse;width:100%">
              <tr><td style="padding:4px 12px 4px 0;color:#666">Nombre:</td><td style="font-weight:600">${nombreDispositivo}</td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#666">Estado:</td><td style="color:#27ae60;font-weight:600">Online ✓</td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#666">Servicio activo hasta:</td><td style="font-weight:600">${fechaExp}</td></tr>
            </table>
          </div>
          <div style="background:#f8f9fa;border-radius:10px;padding:20px;margin:16px 0">
            <p style="margin:0 0 8px;font-weight:600;color:#1a1a2e">🔐 Acceso a tu panel</p>
            <table style="border-collapse:collapse;width:100%">
              <tr><td style="padding:4px 12px 4px 0;color:#666">Web:</td><td><a href="https://alertaluz.es" style="color:#1565C0;font-weight:600">alertaluz.es</a></td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#666">Email:</td><td>${email}</td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#666">Contraseña:</td><td style="font-weight:600">${password}</td></tr>
            </table>
          </div>
          <div style="text-align:center;margin-top:24px">
            <a href="https://alertaluz.es" style="display:inline-block;background:linear-gradient(135deg,#1565C0,#1976D2);color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">
              Acceder a mi panel
            </a>
          </div>
          <br>
          <p style="color:#888;font-size:12px;text-align:center">¿Tienes alguna duda? <a href="mailto:instalacionesmagu@gmail.com" style="color:#1565C0">instalacionesmagu@gmail.com</a></p>
        </div>
      </div>
    `
  });
  console.log(`Email bienvenida enviado a ${email}`);
}

async function enviarEmailInstruccionesTelegram(dispositivo) {
  if (!dispositivo.email_cliente) return;
  const nombre = dispositivo.nombre || dispositivo.chip_id;
  await resend.emails.send({
    from: 'AlertaLuz <alertas@alertaluz.es>',
    to: dispositivo.email_cliente,
    subject: `📱 Activa tus alertas de Telegram — AlertaLuz`,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto">
        <div style="background:linear-gradient(135deg,#1565C0,#1976D2);padding:24px;border-radius:12px 12px 0 0;text-align:center">
          <h1 style="color:white;margin:0;font-size:22px">⚡ AlertaLuz</h1>
          <p style="color:#FFD600;margin:4px 0 0;font-size:13px">MaGu Multiservicios</p>
        </div>
        <div style="background:white;padding:28px;border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px">
          <h2 style="color:#1a1a2e;margin-top:0">📱 Alertas por Telegram activadas</h2>
          <p>Se ha activado Telegram para <b>${nombre}</b>.</p>
          <div style="background:#f8f9fa;border-radius:10px;padding:20px;margin:16px 0">
            <p style="margin:0 0 12px"><b>Paso 1</b> — Abre Telegram y busca:</p>
            <a href="https://t.me/alertaluz_magu_bot" style="display:inline-block;background:#1976D2;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600">Abrir @alertaluz_magu_bot</a>
          </div>
          <div style="background:#f8f9fa;border-radius:10px;padding:20px;margin:16px 0">
            <p style="margin:0 0 8px"><b>Paso 2</b> — Escribe:</p>
            <code style="background:#e3f2fd;padding:8px 14px;border-radius:6px;display:inline-block;font-size:14px;color:#1565C0">/vincular ${dispositivo.email_cliente}</code>
          </div>
          <p style="color:#888;font-size:12px">¿Problemas? <a href="mailto:instalacionesmagu@gmail.com">instalacionesmagu@gmail.com</a></p>
        </div>
      </div>
    `
  });
  console.log(`Email instrucciones Telegram enviado a ${dispositivo.email_cliente}`);
}

async function enviarEmailRenovacion(dispositivo, diasRestantes) {
  if (!dispositivo.email_cliente) return;
  const nombre = dispositivo.nombre || dispositivo.chip_id;
  const fechaExp = formatearFechaSolo(dispositivo.fecha_expiracion);
  await resend.emails.send({
    from: 'AlertaLuz <alertas@alertaluz.es>',
    to: dispositivo.email_cliente,
    subject: `⏰ Tu servicio AlertaLuz caduca en ${diasRestantes} días`,
    html: `<h2 style="color:#e67e22">⏰ Renovación de servicio AlertaLuz</h2>
      <p>Tu servicio para <b>${nombre}</b> caduca el <b>${fechaExp}</b>.</p>
      <p>Quedan <b>${diasRestantes} días</b>.</p><br>
      <table style="border-collapse:collapse">
        <tr><td style="padding:4px 12px 4px 0"><b>Empresa:</b></td><td>MaGu Multiservicios</td></tr>
        <tr><td style="padding:4px 12px 4px 0"><b>Email:</b></td><td>instalacionesmagu@gmail.com</td></tr>
      </table>`
  });
  if (dispositivo.telegram_activo && dispositivo.telegram_chat_id) {
    await enviarTelegram(dispositivo.telegram_chat_id,
      `⏰ <b>Renovación AlertaLuz</b>\n\nTu servicio para <b>${nombre}</b> caduca en <b>${diasRestantes} días</b> (${fechaExp}).\n\nContacta con MaGu Multiservicios.\n📧 instalacionesmagu@gmail.com`
    );
  }
  console.log(`Email renovación enviado a ${dispositivo.email_cliente} (${diasRestantes} días)`);
}

// Webhook Telegram
app.post('/telegram/webhook', async (req, res) => {
  const msg = req.body?.message;
  if (!msg) return res.json({ ok: true });
  const chatId = msg.chat.id;
  const texto = msg.text || '';
  console.log(`Telegram mensaje: "${texto}" de ${chatId}`);

  if (texto.startsWith('/vincular ')) {
    const email = texto.replace('/vincular ', '').trim().toLowerCase();
    const { data: cliente } = await supabase.from('clientes').select('*').eq('email', email).single();
    if (!cliente) {
      await enviarTelegram(chatId, `❌ No encontré ninguna cuenta con el email <b>${email}</b>.`);
      return res.json({ ok: true });
    }
    const { data: disps } = await supabase.from('dispositivos').select('*').eq('email_cliente', email);
    if (!disps || disps.length === 0 || !disps[0].telegram_activo) {
      await enviarTelegram(chatId, `❌ El servicio de Telegram no está activado.\n\nContacta con MaGu Multiservicios.`);
      return res.json({ ok: true });
    }
    await supabase.from('dispositivos').update({ telegram_chat_id: String(chatId) }).eq('email_cliente', email);
    await enviarTelegram(chatId, `✅ <b>¡Cuenta vinculada!</b>\n\nHola <b>${cliente.nombre}</b>, recibirás las alertas aquí.\n\n⚡ AlertaLuz by MaGu Multiservicios`);
    console.log(`Telegram vinculado: ${email} → ${chatId}`);
  } else if (texto === '/start') {
    await enviarTelegram(chatId, `👋 <b>Bienvenido a AlertaLuz</b>\n\nPara vincular tu cuenta escribe:\n\n<code>/vincular tuemail@ejemplo.com</code>\n\n⚡ MaGu Multiservicios`);
  } else {
    await enviarTelegram(chatId, `Para vincular tu cuenta escribe:\n\n<code>/vincular tuemail@ejemplo.com</code>`);
  }
  res.json({ ok: true });
});

// Ping desde el ESP
app.get('/ping', async (req, res) => {
  const { id, estado, motivo } = req.query;
  const ahora = new Date().toISOString();
  console.log(`Ping recibido - ID: ${id} | Estado: ${estado} | Motivo: ${motivo || 'ninguno'}`);

  const { data: actual } = await supabase.from('dispositivos').select('*').eq('chip_id', id).single();

  if (actual) {
    if (actual.activo === false) return res.json({ ok: false, mensaje: 'Dispositivo desactivado' });
    if (actual.fecha_expiracion) {
      const hoy = new Date().toISOString().split('T')[0];
      if (actual.fecha_expiracion < hoy) return res.json({ ok: false, mensaje: 'Servicio caducado.' });
    }
    if (actual.estado === 'offline') {
      await enviarAlertaCompleta({ ...actual, motivo_corte: motivo || 'luz' }, 'online');
    }
  }

  const { error } = await supabase.from('dispositivos').upsert({
    chip_id: id, ultimo_ping: ahora, estado: estado || 'online', motivo_corte: motivo || null
  }, { onConflict: 'chip_id' });

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, id, timestamp: ahora });
});

// Registrar dispositivo
app.get('/registrar', async (req, res) => {
  const { id, email, nombre, password } = req.query;
  if (!id || !email) return res.json({ ok: false, error: 'Faltan datos' });

  const hoy = new Date();
  const expiracion = new Date(hoy.setFullYear(hoy.getFullYear() + 1)).toISOString().split('T')[0];
  const nombreLimpio = decodeURIComponent(nombre || 'Mi dispositivo');
  const emailLimpio = decodeURIComponent(email).toLowerCase();
  const passLimpia = password || id.slice(-4);

  const { error } = await supabase.from('dispositivos').upsert({
    chip_id: id, email_cliente: emailLimpio, nombre: nombreLimpio,
    estado: 'online', activo: true, fecha_expiracion: expiracion,
    ultimo_ping: new Date().toISOString()
  }, { onConflict: 'chip_id' });

  if (error) return res.status(500).json({ ok: false, error: error.message });

  const { data: clienteExiste } = await supabase.from('clientes').select('email').eq('email', emailLimpio).single();

  if (!clienteExiste) {
    await supabase.from('clientes').insert({
      email: emailLimpio, password: passLimpia, nombre: nombreLimpio, fecha_expiracion: expiracion
    });
  } else if (password) {
    await supabase.from('clientes').update({ password: passLimpia }).eq('email', emailLimpio);
  }

  try { await enviarEmailBienvenida(emailLimpio, nombreLimpio, nombreLimpio, passLimpia, expiracion); }
  catch(e) { console.error('Error email bienvenida:', e.message); }

  res.json({ ok: true, expiracion });
});

// Login
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.from('clientes').select('*').eq('email', email).eq('password', password).single();
  if (error || !data) return res.json({ ok: false });
  res.json({ ok: true, nombre: data.nombre });
});

// Dispositivos del cliente
app.get('/dispositivos', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.json({ dispositivos: [] });
  const { data, error } = await supabase.from('dispositivos').select('*').eq('email_cliente', email).order('ultimo_ping', { ascending: false });
  if (error) return res.status(500).json({ ok: false });
  res.json({ dispositivos: data || [] });
});

// Alertas del cliente
app.get('/alertas', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.json({ alertas: [] });
  const { data: dispositivos } = await supabase.from('dispositivos').select('chip_id').eq('email_cliente', email);
  if (!dispositivos || dispositivos.length === 0) return res.json({ alertas: [] });
  const chipIds = dispositivos.map(d => d.chip_id);
  const { data, error } = await supabase.from('alertas').select('*').in('chip_id', chipIds).order('created_at', { ascending: false }).limit(20);
  if (error) return res.status(500).json({ ok: false });
  res.json({ alertas: data || [] });
});

// Solicitar extras — el cliente envía su petición
app.post('/solicitar-extras', async (req, res) => {
  const { email, chip_id, extras, periodicidad, precio_total, mensaje } = req.body;
  if (!email || !chip_id || !extras) return res.status(400).json({ ok: false });

  const { data: cliente } = await supabase.from('clientes').select('nombre').eq('email', email).single();
  const nombreCliente = cliente?.nombre || email;

  const { error } = await supabase.from('solicitudes_extras').insert({
    chip_id, email_cliente: email, nombre_cliente: nombreCliente,
    extras_solicitados: extras, periodicidad: periodicidad || 'anual',
    precio_total, mensaje: mensaje || null, estado: 'pendiente'
  });

  if (error) return res.status(500).json({ ok: false });

  // Notificar al admin por email
  const extrasTexto = JSON.parse(extras).map(e => `• ${e}`).join('<br>');
  await resend.emails.send({
    from: 'AlertaLuz <alertas@alertaluz.es>',
    to: ADMIN_EMAIL,
    subject: `🛒 Nueva solicitud de extras — ${nombreCliente}`,
    html: `
      <h2 style="color:#1565C0">🛒 Nueva solicitud de extras</h2>
      <table style="border-collapse:collapse">
        <tr><td style="padding:4px 12px 4px 0"><b>Cliente:</b></td><td>${nombreCliente}</td></tr>
        <tr><td style="padding:4px 12px 4px 0"><b>Email:</b></td><td>${email}</td></tr>
        <tr><td style="padding:4px 12px 4px 0"><b>Dispositivo:</b></td><td>${chip_id}</td></tr>
        <tr><td style="padding:4px 12px 4px 0"><b>Periodicidad:</b></td><td>${periodicidad}</td></tr>
        <tr><td style="padding:4px 12px 4px 0"><b>Precio total:</b></td><td><b>${precio_total}€</b></td></tr>
      </table>
      <br>
      <p><b>Extras solicitados:</b></p>
      <p>${extrasTexto}</p>
      ${mensaje ? `<br><p><b>Mensaje del cliente:</b> ${mensaje}</p>` : ''}
      <br>
      <p><a href="https://alertaluz.es/admin.html" style="background:#1565C0;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600">Ver en panel admin</a></p>
    `
  });

  // Confirmar al cliente
  await resend.emails.send({
    from: 'AlertaLuz <alertas@alertaluz.es>',
    to: email,
    subject: `📋 Solicitud recibida — AlertaLuz`,
    html: `
      <h2 style="color:#1565C0">📋 Hemos recibido tu solicitud</h2>
      <p>Hola <b>${nombreCliente}</b>, hemos recibido tu solicitud de extras para AlertaLuz.</p>
      <p>Nos pondremos en contacto contigo en breve para gestionar el pago y activar los servicios.</p>
      <br>
      <p><b>Extras solicitados:</b></p>
      <p>${extrasTexto}</p>
      <p><b>Total: ${precio_total}€ / ${periodicidad}</b></p>
      <br>
      <p style="color:#888;font-size:12px">¿Tienes dudas? <a href="mailto:instalacionesmagu@gmail.com">instalacionesmagu@gmail.com</a></p>
    `
  });

  console.log(`Solicitud extras recibida de ${email}`);
  res.json({ ok: true });
});

// ADMIN — ver solicitudes pendientes
app.get('/admin/solicitudes', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const { data, error } = await supabase.from('solicitudes_extras').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ ok: false });
  res.json({ solicitudes: data || [] });
});

// ADMIN — gestionar solicitud (aprobar/rechazar)
app.post('/admin/solicitud/gestionar', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const { id, estado, chip_id, email_cliente, extras_solicitados } = req.body;

  await supabase.from('solicitudes_extras').update({ estado, gestionado_at: new Date().toISOString() }).eq('id', id);

  if (estado === 'aprobada') {
    // Calcular fecha de expiración según periodicidad
    const { data: solicitud } = await supabase.from('solicitudes_extras').select('periodicidad').eq('id', id).single();
    const periodicidad = solicitud?.periodicidad || 'anual';
    const fechaExpiracion = new Date();
    if (periodicidad === 'mensual') {
      fechaExpiracion.setMonth(fechaExpiracion.getMonth() + 1);
    } else {
      fechaExpiracion.setFullYear(fechaExpiracion.getFullYear() + 1);
    }
    const fechaExpStr = fechaExpiracion.toISOString().split('T')[0];

    // Mapear extras por nombre al campo de Supabase
    const updates = {};
    let extrasArray = [];
    try { extrasArray = JSON.parse(extras_solicitados || '[]'); } catch(e) { extrasArray = []; }

    for (const extra of extrasArray) {
      const e = extra.toLowerCase();
      if (e.includes('email')) {
        updates.extra_email_multiple = true;
        updates.extra_email_expira = fechaExpStr;
      }
      if (e.includes('telegram')) {
        updates.extra_telegram_multiple = true;
        updates.extra_telegram_expira = fechaExpStr;
      }
      if (e.includes('push')) {
        updates.extra_push = true;
        updates.extra_push_expira = fechaExpStr;
      }
      if (e.includes('sms')) {
        updates.extra_sms = true;
        updates.extra_sms_expira = fechaExpStr;
      }
      if (e.includes('llamada')) {
        updates.extra_llamada = true;
        updates.extra_llamada_expira = fechaExpStr;
      }
    }

    if (Object.keys(updates).length > 0) {
      await supabase.from('dispositivos').update(updates).eq('chip_id', chip_id);
      console.log(`Extras activados para ${chip_id} hasta ${fechaExpStr}:`, updates);
    }

    await resend.emails.send({
      from: 'AlertaLuz <alertas@alertaluz.es>',
      to: email_cliente,
      subject: `✅ Tus extras AlertaLuz están activos`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto">
          <div style="background:linear-gradient(135deg,#1565C0,#1976D2);padding:24px;border-radius:12px 12px 0 0;text-align:center">
            <h1 style="color:white;margin:0;font-size:22px">⚡ AlertaLuz</h1>
            <p style="color:#FFD600;margin:4px 0 0;font-size:13px">MaGu Multiservicios</p>
          </div>
          <div style="background:white;padding:28px;border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px">
            <h2 style="color:#27ae60;margin-top:0">✅ ¡Extras activados!</h2>
            <p>Hemos activado los extras que solicitaste. Ya puedes configurarlos desde tu panel en la sección <b>Mi configuración</b>.</p>
            <br>
            <div style="text-align:center">
              <a href="https://alertaluz.es/panel.html" style="display:inline-block;background:#1565C0;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600">Ir a Mi configuración</a>
            </div>
            <br>
            <p style="color:#888;font-size:12px;text-align:center">¿Tienes dudas? <a href="mailto:instalacionesmagu@gmail.com">instalacionesmagu@gmail.com</a></p>
          </div>
        </div>
      `
    });
    console.log(`Solicitud aprobada y extras activados para ${email_cliente}`);
  } else if (estado === 'rechazada') {
    await resend.emails.send({
      from: 'AlertaLuz <alertas@alertaluz.es>',
      to: email_cliente,
      subject: `ℹ️ Información sobre tu solicitud — AlertaLuz`,
      html: `<p>Hemos recibido tu solicitud de extras. Nos pondremos en contacto contigo para darte más información.</p>
             <p>¿Tienes dudas? <a href="mailto:instalacionesmagu@gmail.com">instalacionesmagu@gmail.com</a></p>`
    });
  }

  res.json({ ok: true });
});

// ADMIN — ver dispositivos
app.get('/admin/dispositivos', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const { data, error } = await supabase.from('dispositivos').select('*').order('estado', { ascending: true }).order('ultimo_ping', { ascending: false });
  if (error) return res.status(500).json({ ok: false });
  res.json({ dispositivos: data || [] });
});

// ADMIN — ver clientes
app.get('/admin/clientes', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const { data, error } = await supabase.from('clientes').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ ok: false });
  res.json({ clientes: data || [] });
});

// ADMIN — activar/desactivar dispositivo
app.post('/admin/dispositivo/activar', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const { chip_id, activo } = req.body;
  const { error } = await supabase.from('dispositivos').update({ activo }).eq('chip_id', chip_id);
  if (error) return res.status(500).json({ ok: false });
  res.json({ ok: true });
});

// ADMIN — activar/desactivar Telegram
app.post('/admin/dispositivo/telegram', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const { chip_id, telegram_activo } = req.body;
  const { data: disp } = await supabase.from('dispositivos').select('*').eq('chip_id', chip_id).single();
  if (!disp) return res.status(404).json({ ok: false });
  const { error } = await supabase.from('dispositivos').update({ telegram_activo }).eq('chip_id', chip_id);
  if (error) return res.status(500).json({ ok: false });

  if (telegram_activo) {
    await enviarEmailInstruccionesTelegram(disp);
  } else {
    await supabase.from('dispositivos').update({ telegram_chat_id: null }).eq('chip_id', chip_id);
    if (disp.email_cliente) {
      await resend.emails.send({
        from: 'AlertaLuz <alertas@alertaluz.es>',
        to: disp.email_cliente,
        subject: `📵 Alertas Telegram desactivadas — AlertaLuz`,
        html: `<p>Las alertas por Telegram para <b>${disp.nombre || chip_id}</b> han sido desactivadas.</p>
               <p>Seguirás recibiendo alertas por email.</p>`
      });
    }
  }
  res.json({ ok: true });
});

// ADMIN — activar copia email admin
app.post('/admin/dispositivo/email-copia', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const { chip_id, activo } = req.body;
  const { error } = await supabase.from('dispositivos').update({ admin_email_copia: activo }).eq('chip_id', chip_id);
  if (error) return res.status(500).json({ ok: false });
  res.json({ ok: true });
});

// ADMIN — renovar fecha expiración
app.post('/admin/dispositivo/renovar', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const { chip_id, fecha_expiracion } = req.body;
  const { error } = await supabase.from('dispositivos').update({ activo: true, fecha_expiracion }).eq('chip_id', chip_id);
  if (error) return res.status(500).json({ ok: false });
  res.json({ ok: true });
});

// ADMIN — eliminar dispositivo
app.delete('/admin/dispositivo/:chip_id', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const { chip_id } = req.params;
  await supabase.from('alertas').delete().eq('chip_id', chip_id);
  const { error } = await supabase.from('dispositivos').delete().eq('chip_id', chip_id);
  if (error) return res.status(500).json({ ok: false });
  res.json({ ok: true });
});

// ADMIN — eliminar cliente
app.delete('/admin/cliente/:email', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const { email } = req.params;
  const { error } = await supabase.from('clientes').delete().eq('email', email);
  if (error) return res.status(500).json({ ok: false });
  res.json({ ok: true });
});


// ADMIN — configurar extras de dispositivo
app.post('/admin/dispositivo/configurar', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const { chip_id, updates } = req.body;
  const { error } = await supabase.from('dispositivos').update(updates).eq('chip_id', chip_id);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  console.log(`Configuración actualizada para ${chip_id}`);
  res.json({ ok: true });
});

// Registrar player OneSignal
app.post('/onesignal/registrar', async (req, res) => {
  const { email, player_id } = req.body;
  if (!email || !player_id) return res.status(400).json({ ok: false });

  // Asociar player_id como external_user_id en OneSignal
  if (!process.env.ONESIGNAL_APP_ID || !process.env.ONESIGNAL_API_KEY) {
    return res.json({ ok: false, error: 'OneSignal no configurado' });
  }

  try {
    // API v2: asignar external_id al subscription
    const body = JSON.stringify({
      identity: { external_id: email }
    });
    const options = {
      hostname: 'api.onesignal.com',
      path: `/apps/${process.env.ONESIGNAL_APP_ID}/users/by/onesignal_id/${player_id}/identity`,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Key ${process.env.ONESIGNAL_API_KEY}`
      }
    };
    await new Promise((resolve) => {
      const req2 = https.request(options, (r) => {
        let data = '';
        r.on('data', chunk => data += chunk);
        r.on('end', () => {
          console.log(`OneSignal identity asignada: ${email} → ${player_id}: ${data}`);
          resolve();
        });
      });
      req2.on('error', e => console.error('Error OS register:', e.message));
      req2.write(body);
      req2.end();
    });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// CLIENTE — actualizar su propia configuración
app.post('/configurar-dispositivo', async (req, res) => {
  const { email, chip_id, extra_emails, extra_telegram_ids, extra_sms_telefono, extra_llamada_telefono, extra_sms_tiempo, extra_llamada_tiempo } = req.body;
  if (!email || !chip_id) return res.status(400).json({ ok: false });

  // Verificar que el dispositivo pertenece al cliente
  const { data: disp } = await supabase.from('dispositivos').select('email_cliente').eq('chip_id', chip_id).single();
  if (!disp || disp.email_cliente !== email) return res.status(403).json({ ok: false, error: 'No autorizado' });

  const updates = {};
  if (extra_emails !== undefined) updates.extra_emails = extra_emails;
  if (extra_telegram_ids !== undefined) updates.extra_telegram_ids = extra_telegram_ids;
  if (extra_sms_telefono !== undefined) updates.extra_sms_telefono = extra_sms_telefono;
  if (extra_llamada_telefono !== undefined) updates.extra_llamada_telefono = extra_llamada_telefono;
  if (extra_sms_tiempo !== undefined) updates.extra_sms_tiempo = extra_sms_tiempo;
  if (extra_llamada_tiempo !== undefined) updates.extra_llamada_tiempo = extra_llamada_tiempo;

  const { error } = await supabase.from('dispositivos').update(updates).eq('chip_id', chip_id);
  if (error) return res.status(500).json({ ok: false });
  console.log(`Cliente ${email} actualizó configuración de ${chip_id}`);
  res.json({ ok: true });
});

// Vigilante
setInterval(async () => {
  console.log('Vigilante: comprobando dispositivos...');
  const ahora = new Date();
  const limite = new Date(ahora.getTime() - 2 * 60 * 1000);

  const { data: dispositivos, error } = await supabase.from('dispositivos').select('*').eq('estado', 'online').eq('activo', true).lt('ultimo_ping', limite.toISOString());

  if (!error) {
    for (const d of dispositivos) {
      await supabase.from('dispositivos').update({ estado: 'offline' }).eq('chip_id', d.chip_id);
      await supabase.from('alertas').insert({ chip_id: d.chip_id, tipo: 'offline', mensaje: `Dispositivo ${d.nombre || d.chip_id} sin señal desde ${formatearFecha(d.ultimo_ping)}` });
      await enviarAlertaCompleta(d, 'offline');
      console.log(`Dispositivo ${d.chip_id} marcado como OFFLINE`);
    }
  }

  // Reset contadores SMS y llamadas cada mes
  const { data: todos } = await supabase.from('dispositivos').select('*').eq('activo', true);
  if (todos) {
    const mes = mesActual();
    for (const d of todos) {
      const updates = {};
      if (d.extra_sms_reset !== mes) { updates.extra_sms_usados = 0; updates.extra_sms_reset = mes; }
      if (d.extra_llamada_reset !== mes) { updates.extra_llamada_usadas = 0; updates.extra_llamada_reset = mes; }
      if (Object.keys(updates).length > 0) {
        await supabase.from('dispositivos').update(updates).eq('chip_id', d.chip_id);
      }
    }
  }

  const hora = ahora.getHours();
  if (hora === 9) {
    const { data: todosExp } = await supabase.from('dispositivos').select('*').eq('activo', true).not('fecha_expiracion', 'is', null);
    if (todosExp) {
      const hoyStr = ahora.toISOString().split('T')[0];
      for (const d of todosExp) {
        const exp = new Date(d.fecha_expiracion);
        const diffDias = Math.ceil((exp - ahora) / (1000 * 60 * 60 * 24));
        if (diffDias === 15 || diffDias === 7 || diffDias === 1) await enviarEmailRenovacion(d, diffDias);
        if (diffDias <= 0) {
          await supabase.from('dispositivos').update({ activo: false }).eq('chip_id', d.chip_id);
          console.log(`Dispositivo ${d.chip_id} desactivado por caducidad`);
        }

        // Verificar expiración de extras individuales
        const extrasUpdates = {};
        if (d.extra_email_expira && d.extra_email_expira <= hoyStr) {
          extrasUpdates.extra_email_multiple = false;
          console.log(`Email múltiple caducado para ${d.chip_id}`);
        }
        if (d.extra_telegram_expira && d.extra_telegram_expira <= hoyStr) {
          extrasUpdates.extra_telegram_multiple = false;
          console.log(`Telegram múltiple caducado para ${d.chip_id}`);
        }
        if (d.extra_push_expira && d.extra_push_expira <= hoyStr) {
          extrasUpdates.extra_push = false;
          console.log(`Push caducado para ${d.chip_id}`);
        }
        if (d.extra_sms_expira && d.extra_sms_expira <= hoyStr) {
          extrasUpdates.extra_sms = false;
          console.log(`SMS caducado para ${d.chip_id}`);
        }
        if (d.extra_llamada_expira && d.extra_llamada_expira <= hoyStr) {
          extrasUpdates.extra_llamada = false;
          console.log(`Llamada caducada para ${d.chip_id}`);
        }
        if (Object.keys(extrasUpdates).length > 0) {
          await supabase.from('dispositivos').update(extrasUpdates).eq('chip_id', d.chip_id);
        }
      }
    }
  }
}, 1 * 60 * 1000);

app.get('/', (req, res) => {
  res.json({ status: 'AlertaLuz backend funcionando' });
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});