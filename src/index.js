const express = require('express');
const axios = require('axios');
const https = require('https');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(cors({
  origin: '*'
}))

// Configurar axios para ignorar certificados SSL auto-assinados
const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

app.get('/extensions/free', async (req, res) => {
  try {
    const response = await axios.get(
      'https://srv762442.hstgr.cloud:8089/ari/endpoints?api_key=node_ami:senha123',
      { httpsAgent }
    );

    const endpoints = response.data;
    
    // Filtrar endpoints offline
    const ramaisOffline = endpoints
      .filter(endpoint => endpoint.state === 'offline')
      .map(endpoint => endpoint.resource);

    res.json({
      success: true,
      ramaisOffline: ramaisOffline,
      total: ramaisOffline.length
    });

  } catch (error) {
    console.error('Erro ao buscar endpoints:', error.message);
    res.status(500).json({
      success: false,
      error: 'Erro ao buscar ramais offline',
      details: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});