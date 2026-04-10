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

  await resend.emails.send({
    from: 'AlertaLuz <alertas@alertaluz.es>',
    to: dispositivo.email_cliente,
    subject: asunto,
    html: mensajeHTML
  });
  console.log(`Email enviado a ${dispositivo.email_cliente}`);
}

async function enviarAlertaCompleta(dispositivo, tipo) {
  const nombre = dispositivo.nombre || dispositivo.chip_id;
  const horaEvento = formatearFecha(dispositivo.ultimo_ping);
  const horaAhora = formatearFecha(new Date().toISOString());

  await enviarEmailAlerta(dispositivo, tipo);

  if (dispositivo.telegram_activo && dispositivo.telegram_chat_id) {
    const msg = tipo === 'offline'
      ? `⚠️ <b>Sin señal</b>\n\nDispositivo: <b>${nombre}</b>\nÚltimo ping: ${horaEvento}\nAlerta generada: ${horaAhora}`
      : `✅ <b>Servicio restablecido</b>\n\nDispositivo: <b>${nombre}</b>\nMotivo: ${dispositivo.motivo_corte || 'desconocido'}\nReconexión: ${horaAhora}`;
    await enviarTelegram(dispositivo.telegram_chat_id, msg);
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
          <p>Hola <b>${nombre}</b>, tu dispositivo AlertaLuz ha sido configurado correctamente y ya está monitorizando tu suministro eléctrico.</p>
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
          <div style="background:#e8faf0;border-radius:10px;padding:20px;margin:16px 0">
            <p style="margin:0 0 8px;font-weight:600;color:#27ae60">📋 ¿Cómo funciona?</p>
            <p style="margin:0;color:#555;font-size:13px;line-height:1.6">Tu dispositivo envía una señal cada minuto. Si detectamos que ha dejado de responder durante más de 2 minutos, recibirás un email de alerta inmediatamente. También te avisaremos cuando el servicio se restablezca y el motivo del corte.</p>
          </div>
          <div style="text-align:center;margin-top:24px">
            <a href="https://alertaluz.es" style="display:inline-block;background:linear-gradient(135deg,#1565C0,#1976D2);color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">
              Acceder a mi panel
            </a>
          </div>
          <br>
          <p style="color:#888;font-size:12px;text-align:center">¿Tienes alguna duda? Contacta con nosotros en <a href="mailto:instalacionesmagu@gmail.com" style="color:#1565C0">instalacionesmagu@gmail.com</a></p>
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
          <p>Hola, se ha activado el servicio de alertas por Telegram para tu dispositivo <b>${nombre}</b>.</p>
          <br>
          <div style="background:#f8f9fa;border-radius:10px;padding:20px;margin:16px 0">
            <p style="margin:0 0 12px"><b>Paso 1</b> — Abre Telegram y busca nuestro bot:</p>
            <a href="https://t.me/alertaluz_magu_bot" style="display:inline-block;background:#1976D2;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600">
              Abrir @alertaluz_magu_bot
            </a>
          </div>
          <div style="background:#f8f9fa;border-radius:10px;padding:20px;margin:16px 0">
            <p style="margin:0 0 8px"><b>Paso 2</b> — Pulsa Iniciar y luego escribe:</p>
            <code style="background:#e3f2fd;padding:8px 14px;border-radius:6px;display:inline-block;font-size:14px;color:#1565C0">/vincular ${dispositivo.email_cliente}</code>
          </div>
          <div style="background:#f8f9fa;border-radius:10px;padding:20px;margin:16px 0">
            <p style="margin:0"><b>Paso 3</b> — Listo. El bot te confirmará la vinculación.</p>
          </div>
          <p style="color:#888;font-size:12px">¿Problemas? Contacta en <a href="mailto:instalacionesmagu@gmail.com">instalacionesmagu@gmail.com</a></p>
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
      <p>Hola, tu servicio para <b>${nombre}</b> caduca el <b>${fechaExp}</b>.</p>
      <p>Quedan <b>${diasRestantes} días</b> para que el servicio deje de funcionar.</p><br>
      <p>Para renovar contacta con nosotros:</p><br>
      <table style="border-collapse:collapse">
        <tr><td style="padding:4px 12px 4px 0"><b>Empresa:</b></td><td>MaGu Multiservicios</td></tr>
        <tr><td style="padding:4px 12px 4px 0"><b>Email:</b></td><td>instalacionesmagu@gmail.com</td></tr>
      </table>
      <p style="color:#888;font-size:12px;margin-top:16px">Si ya has realizado el pago, ignora este mensaje.</p>`
  });

  if (dispositivo.telegram_activo && dispositivo.telegram_chat_id) {
    await enviarTelegram(dispositivo.telegram_chat_id,
      `⏰ <b>Renovación AlertaLuz</b>\n\nTu servicio para <b>${nombre}</b> caduca en <b>${diasRestantes} días</b> (${fechaExp}).\n\nContacta con MaGu Multiservicios para renovar.\n📧 instalacionesmagu@gmail.com`
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
      await enviarTelegram(chatId, `❌ No encontré ninguna cuenta con el email <b>${email}</b>.\n\nComprueba que el email es correcto.`);
      return res.json({ ok: true });
    }

    const { data: disps } = await supabase.from('dispositivos').select('*').eq('email_cliente', email);

    if (!disps || disps.length === 0 || !disps[0].telegram_activo) {
      await enviarTelegram(chatId, `❌ El servicio de Telegram no está activado para tu cuenta.\n\nContacta con MaGu Multiservicios para activarlo.`);
      return res.json({ ok: true });
    }

    await supabase.from('dispositivos').update({ telegram_chat_id: String(chatId) }).eq('email_cliente', email);
    await enviarTelegram(chatId, `✅ <b>¡Cuenta vinculada!</b>\n\nHola <b>${cliente.nombre}</b>, a partir de ahora recibirás las alertas de tus dispositivos por aquí.\n\n⚡ AlertaLuz by MaGu Multiservicios`);
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

  const { error } = await supabase.from('dispositivos').upsert({
    chip_id: id, email_cliente: emailLimpio, nombre: nombreLimpio,
    estado: 'online', activo: true, fecha_expiracion: expiracion,
    ultimo_ping: new Date().toISOString()
  }, { onConflict: 'chip_id' });

  if (error) return res.status(500).json({ ok: false, error: error.message });

  const { data: clienteExiste } = await supabase.from('clientes').select('email').eq('email', emailLimpio).single();
  const passLimpia = password || id.slice(-4);

  if (!clienteExiste) {
    await supabase.from('clientes').insert({
      email: emailLimpio, password: passLimpia, nombre: nombreLimpio, fecha_expiracion: expiracion
    });
  } else if (password) {
    await supabase.from('clientes').update({ password: passLimpia }).eq('email', emailLimpio);
  }

  // Enviar email de bienvenida
  try {
    await enviarEmailBienvenida(emailLimpio, nombreLimpio, nombreLimpio, passLimpia, expiracion);
  } catch(e) {
    console.error('Error email bienvenida:', e.message);
  }

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
    console.log(`Telegram activado para ${disp.email_cliente}`);
  } else {
    await supabase.from('dispositivos').update({ telegram_chat_id: null }).eq('chip_id', chip_id);
    if (disp.email_cliente) {
      await resend.emails.send({
        from: 'AlertaLuz <alertas@alertaluz.es>',
        to: disp.email_cliente,
        subject: `📵 Alertas Telegram desactivadas — AlertaLuz`,
        html: `<p>Las alertas por Telegram para tu dispositivo <b>${disp.nombre || chip_id}</b> han sido desactivadas.</p>
               <p>Seguirás recibiendo las alertas por email.</p>
               <p style="color:#888;font-size:12px">Si crees que es un error contacta con instalacionesmagu@gmail.com</p>`
      });
    }
    console.log(`Telegram desactivado para ${disp.email_cliente}`);
  }

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

  const hora = ahora.getHours();
  if (hora === 9) {
    const { data: todos } = await supabase.from('dispositivos').select('*').eq('activo', true).not('fecha_expiracion', 'is', null);
    if (todos) {
      for (const d of todos) {
        const exp = new Date(d.fecha_expiracion);
        const diffDias = Math.ceil((exp - ahora) / (1000 * 60 * 60 * 24));
        if (diffDias === 15 || diffDias === 7 || diffDias === 1) await enviarEmailRenovacion(d, diffDias);
        if (diffDias <= 0) {
          await supabase.from('dispositivos').update({ activo: false }).eq('chip_id', d.chip_id);
          console.log(`Dispositivo ${d.chip_id} desactivado por caducidad`);
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