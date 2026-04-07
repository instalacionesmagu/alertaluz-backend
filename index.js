const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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

  if (error) {
    console.error('Error Supabase:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }

  res.json({ ok: true, id, timestamp: ahora });
});

// Test
app.get('/', (req, res) => {
  res.json({ status: 'AlertaLuz backend funcionando' });
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});