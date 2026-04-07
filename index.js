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

// Función para enviar email de alerta
async function enviarEmailAlerta(dispositivo, tipo) {
  const esOffline = tipo === 'offline';
  const asunto = esOffline
    ? `⚠️ Alerta: ${dispositivo.nombre || dispositivo.chip_id} sin señal`
    : `✅ Restablecido: ${dispositivo.nombre || dispositivo.chip_id} vuelve a estar online`;

  const mensaje = esOffline
    ? `Tu dispositivo <b>${dispositivo.nombre || dispositivo.chip_id}</b> ha dejado de enviar señal.<br><br>Puede ser un corte de luz o de internet.<br><br>Último ping recibido: ${dispositivo.ultimo_ping}`
    : `Tu dispositivo <b>${dispositivo.nombre || dispositivo.chip_id}</b> ha vuelto a conectarse.<br><br>Motivo del corte: ${dispositivo.motivo_corte || 'desconocido'}`;

  if (!dispositivo.email_cliente) return;

  await resend.emails.send({
    from: 'AlertaLuz <onboarding@resend.dev>',
    to: dispositivo.email_cliente,
    subject: asunto,
    html: `<p>${mensaje}</p>`
  });

  console.log(`Email enviado a ${dispositivo.email_cliente}`);
}

// Ping desde el ESP
app.get('/ping', async (req, res) => {
  const { id, estado, motivo } = req.query;
  const ahora = new Date().toISOString();
  console.log(`Ping recibido - ID: ${id} | Estado: ${estado} | Motivo: ${motivo || 'ninguno'}`);

  // Si vuelve online después de estar offline, enviar email de restablecimiento
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

// Vigilante — se ejecuta cada 2 minutos
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
        mensaje: `Dispositivo ${d.nombre || d.chip_id} sin señal desde ${d.ultimo_ping}`
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