const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.use(cors());
app.use(express.json());

// Ping desde el ESP
app.get('/ping', async (req, res) => {
  const { id, estado, motivo } = req.query;
  const ahora = new Date().toISOString();
  console.log(`Ping recibido - ID: ${id} | Estado: ${estado} | Motivo: ${motivo || 'ninguno'}`);

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
  const limite = new Date(ahora.getTime() - 3 * 60 * 1000); // 3 minutos sin ping = offline

  const { data: dispositivos, error } = await supabase
    .from('dispositivos')
    .select('*')
    .eq('estado', 'online')
    .lt('ultimo_ping', limite.toISOString());

  if (error) return console.error('Error vigilante:', error.message);

  for (const d of dispositivos) {
    console.log(`ALERTA: ${d.chip_id} sin ping desde ${d.ultimo_ping}`);

    // Marcar como offline
    await supabase
      .from('dispositivos')
      .update({ estado: 'offline' })
      .eq('chip_id', d.chip_id);

    // Guardar en historial
    await supabase
      .from('alertas')
      .insert({
        chip_id: d.chip_id,
        tipo: 'offline',
        mensaje: `Dispositivo ${d.nombre || d.chip_id} sin señal desde ${d.ultimo_ping}`
      });

    console.log(`Dispositivo ${d.chip_id} marcado como OFFLINE`);
  }
}, 2 * 60 * 1000);

// Test
app.get('/', (req, res) => {
  res.json({ status: 'AlertaLuz backend funcionando' });
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});