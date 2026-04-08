const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

app.use(cors());
app.use(express.json());

function formatearFecha(isoString) {
  if (!isoString) return 'desconocida';
  const fecha = new Date(isoString);
  return fecha.toLocaleString('es-ES', {
    timeZone: 'Europe/Madrid',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
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
    ? `
      <h2 style="color:#c0392b">⚠️ Dispositivo sin señal</h2>
      <p>Tu dispositivo <b>${nombre}</b> ha dejado de enviar señal.</p>
      <p>Puede ser un corte de luz o de internet.</p>
      <br>
      <table style="border-collapse:collapse">
        <tr><td style="padding:4px 12px 4px 0"><b>Último ping recibido:</b></td><td>${horaEvento}</td></tr>
        <tr><td style="padding:4px 12px 4px 0"><b>Alerta generada a las:</b></td><td>${horaAhora}</td></tr>
      </table>
    `
    : `
      <h2 style="color:#27ae60">✅ Servicio restablecido</h2>
      <p>Tu dispositivo <b>${nombre}</b> ha vuelto a conectarse.</p>
      <br>
      <table style="border-collapse:collapse">
        <tr><td style="padding:4px 12px 4px 0"><b>Motivo del corte:</b></td><td>${dispositivo.motivo_corte || 'desconocido'}</td></tr>
        <tr><td style="padding:4px 12px 4px 0"><b>Última señal antes del corte:</b></td><td>${horaEvento}</td></tr>
        <tr><td style="padding:4px 12px 4px 0"><b>Reconexión a las:</b></td><td>${horaAhora}</td></tr>
      </table>
    `;

  await resend.emails.send({
    from: 'AlertaLuz <onboarding@resend.dev>',
    to: dispositivo.email_cliente,
    subject: asunto,
    html: mensajeHTML
  });

  console.log(`Email enviado a ${dispositivo.email_cliente}`);
}

async function enviarEmailRenovacion(dispositivo, diasRestantes) {
  if (!dispositivo.email_cliente) return;
  const nombre = dispositivo.nombre || dispositivo.chip_id;
  const fechaExp = formatearFechaSolo(dispositivo.fecha_expiracion);

  await resend.emails.send({
    from: 'AlertaLuz <onboarding@resend.dev>',
    to: dispositivo.email_cliente,
    subject: `⏰ Tu servicio AlertaLuz caduca en ${diasRestantes} días`,
    html: `
      <h2 style="color:#e67e22">⏰ Renovación de servicio AlertaLuz</h2>
      <p>Hola, te informamos que el servicio de monitoreo para tu dispositivo <b>${nombre}</b> caduca el <b>${fechaExp}</b>.</p>
      <p>Quedan <b>${diasRestantes} días</b> para que el servicio deje de funcionar.</p>
      <br>
      <p>Para renovar el servicio por otro año, contacta con nosotros:</p>
      <br>
      <table style="border-collapse:collapse">
        <tr><td style="padding:4px 12px 4px 0"><b>Empresa:</b></td><td>MaGu Multiservicios</td></tr>
        <tr><td style="padding:4px 12px 4px 0"><b>Email:</b></td><td>instalacionesmagu@gmail.com</td></tr>
      </table>
      <br>
      <p style="color:#888;font-size:12px">Si ya has realizado el pago, ignora este mensaje.</p>
    `
  });

  console.log(`Email renovación enviado a ${dispositivo.email_cliente} (${diasRestantes} días)`);
}

// Ping desde el ESP
app.get('/ping', async (req, res) => {
  const { id, estado, motivo } = req.query;
  const ahora = new Date().toISOString();

  console.log(`Ping recibido - ID: ${id} | Estado: ${estado} | Motivo: ${motivo || 'ninguno'}`);

  const { data: actual } = await supabase
    .from('dispositivos')
    .select('*')
    .eq('chip_id', id)
    .single();

  // Comprobar si está activo y no ha caducado
  if (actual) {
    if (actual.activo === false) {
      return res.json({ ok: false, mensaje: 'Dispositivo desactivado' });
    }
    if (actual.fecha_expiracion) {
      const hoy = new Date().toISOString().split('T')[0];
      if (actual.fecha_expiracion < hoy) {
        return res.json({ ok: false, mensaje: 'Servicio caducado. Contacta con MaGu Multiservicios.' });
      }
    }
    if (actual.estado === 'offline') {
      await enviarEmailAlerta({ ...actual, motivo_corte: motivo || 'luz' }, 'online');
    }
  }

  const { error } = await supabase
    .from('dispositivos')
    .upsert({
      chip_id: id,
      ultimo_ping: ahora,
      estado: estado || 'online',
      motivo_corte: motivo || null
    }, { onConflict: 'chip_id' });

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, id, timestamp: ahora });
});

// Registrar dispositivo
app.get('/registrar', async (req, res) => {
  const { id, email, nombre, password } = req.query;
  if (!id || !email) return res.json({ ok: false, error: 'Faltan datos' });

  console.log(`Registrando dispositivo: ${id} | ${email} | ${nombre}`);

  // Fecha de expiración = 1 año desde hoy
  const hoy = new Date();
  const expiracion = new Date(hoy.setFullYear(hoy.getFullYear() + 1)).toISOString().split('T')[0];

  const { error } = await supabase
    .from('dispositivos')
    .upsert({
      chip_id: id,
      email_cliente: email,
      nombre: nombre || 'Mi dispositivo',
      estado: 'online',
      activo: true,
      fecha_expiracion: expiracion,
      ultimo_ping: new Date().toISOString()
    }, { onConflict: 'chip_id' });

  if (error) return res.status(500).json({ ok: false, error: error.message });

  const { data: clienteExiste } = await supabase
    .from('clientes')
    .select('email')
    .eq('email', email)
    .single();

  if (!clienteExiste) {
    await supabase
      .from('clientes')
      .insert({
        email: email,
        password: password || id.slice(-4),
        nombre: nombre || 'Cliente',
        fecha_expiracion: expiracion
      });
    console.log(`Cliente nuevo: ${email} | expira: ${expiracion}`);
  } else {
    if (password) {
      await supabase
        .from('clientes')
        .update({ password: password })
        .eq('email', email);
    }
  }

  res.json({ ok: true, expiracion });
});

// Login
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase
    .from('clientes')
    .select('*')
    .eq('email', email)
    .eq('password', password)
    .single();

  if (error || !data) return res.json({ ok: false });
  res.json({ ok: true, nombre: data.nombre });
});

// Dispositivos del cliente
app.get('/dispositivos', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.json({ dispositivos: [] });

  const { data, error } = await supabase
    .from('dispositivos')
    .select('*')
    .eq('email_cliente', email)
    .order('ultimo_ping', { ascending: false });

  if (error) return res.status(500).json({ ok: false });
  res.json({ dispositivos: data || [] });
});

// Alertas del cliente
app.get('/alertas', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.json({ alertas: [] });

  const { data: dispositivos } = await supabase
    .from('dispositivos')
    .select('chip_id')
    .eq('email_cliente', email);

  if (!dispositivos || dispositivos.length === 0) return res.json({ alertas: [] });

  const chipIds = dispositivos.map(d => d.chip_id);

  const { data, error } = await supabase
    .from('alertas')
    .select('*')
    .in('chip_id', chipIds)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) return res.status(500).json({ ok: false });
  res.json({ alertas: data || [] });
});

// ADMIN — ver dispositivos
app.get('/admin/dispositivos', async (req, res) => {
  if (!verificarAdmin(req, res)) return;

  const { data, error } = await supabase
    .from('dispositivos')
    .select('*')
    .order('estado', { ascending: true })
    .order('ultimo_ping', { ascending: false });

  if (error) return res.status(500).json({ ok: false });
  res.json({ dispositivos: data || [] });
});

// ADMIN — ver clientes
app.get('/admin/clientes', async (req, res) => {
  if (!verificarAdmin(req, res)) return;

  const { data, error } = await supabase
    .from('clientes')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ ok: false });
  res.json({ clientes: data || [] });
});

// ADMIN — activar/desactivar dispositivo
app.post('/admin/dispositivo/activar', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const { chip_id, activo } = req.body;

  const { error } = await supabase
    .from('dispositivos')
    .update({ activo: activo })
    .eq('chip_id', chip_id);

  if (error) return res.status(500).json({ ok: false });
  console.log(`Dispositivo ${chip_id} ${activo ? 'activado' : 'desactivado'}`);
  res.json({ ok: true });
});

// ADMIN — cambiar fecha de expiración
app.post('/admin/dispositivo/renovar', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const { chip_id, fecha_expiracion } = req.body;

  const { error } = await supabase
    .from('dispositivos')
    .update({ activo: true, fecha_expiracion: fecha_expiracion })
    .eq('chip_id', chip_id);

  if (error) return res.status(500).json({ ok: false });
  console.log(`Dispositivo ${chip_id} renovado hasta ${fecha_expiracion}`);
  res.json({ ok: true });
});

// ADMIN — eliminar dispositivo
app.delete('/admin/dispositivo/:chip_id', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const { chip_id } = req.params;

  await supabase.from('alertas').delete().eq('chip_id', chip_id);
  const { error } = await supabase.from('dispositivos').delete().eq('chip_id', chip_id);

  if (error) return res.status(500).json({ ok: false });
  console.log(`Dispositivo ${chip_id} eliminado`);
  res.json({ ok: true });
});

// ADMIN — eliminar cliente
app.delete('/admin/cliente/:email', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const { email } = req.params;

  const { error } = await supabase.from('clientes').delete().eq('email', email);

  if (error) return res.status(500).json({ ok: false });
  console.log(`Cliente ${email} eliminado`);
  res.json({ ok: true });
});

// Vigilante — comprueba pings y fechas de expiración
setInterval(async () => {
  console.log('Vigilante: comprobando dispositivos...');
  const ahora = new Date();
  const limite = new Date(ahora.getTime() - 2 * 60 * 1000);
  const hoy = ahora.toISOString().split('T')[0];

  // Detectar offline
  const { data: dispositivos, error } = await supabase
    .from('dispositivos')
    .select('*')
    .eq('estado', 'online')
    .eq('activo', true)
    .lt('ultimo_ping', limite.toISOString());

  if (!error) {
    for (const d of dispositivos) {
      console.log(`ALERTA: ${d.chip_id} sin ping desde ${d.ultimo_ping}`);
      await supabase.from('dispositivos').update({ estado: 'offline' }).eq('chip_id', d.chip_id);
      await supabase.from('alertas').insert({
        chip_id: d.chip_id,
        tipo: 'offline',
        mensaje: `Dispositivo ${d.nombre || d.chip_id} sin señal desde ${formatearFecha(d.ultimo_ping)}`
      });
      await enviarEmailAlerta(d, 'offline');
      console.log(`Dispositivo ${d.chip_id} marcado como OFFLINE`);
    }
  }

  // Comprobar renovaciones (solo una vez al día — a las 9:00)
  const hora = ahora.getHours();
  if (hora === 9) {
    const { data: todos } = await supabase
      .from('dispositivos')
      .select('*')
      .eq('activo', true)
      .not('fecha_expiracion', 'is', null);

    if (todos) {
      for (const d of todos) {
        const exp = new Date(d.fecha_expiracion);
        const diffMs = exp - ahora;
        const diffDias = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

        if (diffDias === 15 || diffDias === 7 || diffDias === 1) {
          await enviarEmailRenovacion(d, diffDias);
        }

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