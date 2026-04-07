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

  if (actual && actual.estado === 'offline') {
    await enviarEmailAlerta({ ...actual, motivo_corte: motivo || 'luz' }, 'online');
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

// Login del cliente
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
// Registrar dispositivo nuevo desde el portal WiFi
app.get('/registrar', async (req, res) => {
  const { id, email, nombre } = req.query;

  if (!id || !email) return res.json({ ok: false, error: 'Faltan datos' });

  console.log(`Registrando dispositivo: ${id} | ${email} | ${nombre}`);

  const { error } = await supabase
    .from('dispositivos')
    .upsert({
      chip_id: id,
      email_cliente: email,
      nombre: nombre || 'Mi dispositivo',
      estado: 'online',
      ultimo_ping: new Date().toISOString()
    }, { onConflict: 'chip_id' });

  if (error) return res.status(500).json({ ok: false, error: error.message });

  // Crear cliente si no existe
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
        password: id.slice(-4),
        nombre: nombre || 'Cliente'
      });
    console.log(`Cliente nuevo creado: ${email} | contraseña: ${id.slice(-4)}`);
  }

  res.json({ ok: true });
});
// Vigilante — se ejecuta cada minuto
setInterval(async () => {
  console.log('Vigilante: comprobando dispositivos...');
  const ahora = new Date();
  const limite = new Date(ahora.getTime() - 2 * 60 * 1000);

  const { data: dispositivos, error } = await supabase
    .from('dispositivos')
    .select('*')
    .eq('estado', 'online')
    .lt('ultimo_ping', limite.toISOString());

  if (error) return console.error('Error vigilante:', error.message);

  for (const d of dispositivos) {
    console.log(`ALERTA: ${d.chip_id} sin ping desde ${d.ultimo_ping}`);

    await supabase
      .from('dispositivos')
      .update({ estado: 'offline' })
      .eq('chip_id', d.chip_id);

    await supabase
      .from('alertas')
      .insert({
        chip_id: d.chip_id,
        tipo: 'offline',
        mensaje: `Dispositivo ${d.nombre || d.chip_id} sin señal desde ${formatearFecha(d.ultimo_ping)}`
      });

    await enviarEmailAlerta(d, 'offline');

    console.log(`Dispositivo ${d.chip_id} marcado como OFFLINE`);
  }
}, 1 * 60 * 1000);

// Test
app.get('/', (req, res) => {
  res.json({ status: 'AlertaLuz backend funcionando' });
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
