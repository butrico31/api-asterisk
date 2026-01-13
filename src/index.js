// =========================================
//  Micro-serviço AMI Listener + State Machine
//  Tech Lead → Dev Júnior
// =========================================

const AmiClient = require("asterisk-ami-client");
const express = require("express");
const cors = require("cors");

// ========================
// CONFIGURAÇÕES
// ========================
const AMI_USER = process.env.AMI_USER || "node_ami";
const AMI_PASS = process.env.AMI_PASS || "senha123";
const AMI_HOST = process.env.AMI_HOST || "srv762442.hstgr.cloud";
const AMI_PORT = Number(process.env.AMI_PORT || 5038);

const WSS_URL = process.env.WSS_URL || "wss://srv762442.hstgr.cloud:8089/ws";
const EXT_PASSWORD = process.env.EXT_PASSWORD || "senha123";

const BUSY_TTL_MS = Number(process.env.BUSY_TTL_MS || 120_000); // fallback p/ liberar busy preso

function parseExtensions(raw) {
  if (!raw) return null;
  const parts = String(raw)
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  return parts.length ? parts : null;
}

// Defina seus ramais que o front pode usar (env EXTENSIONS="3000,3001")
const EXTENSIONS = parseExtensions(process.env.EXTENSIONS) || ["3000", "3001"];

// State Machine inicial
const extensionState = {};

// Fallback: se o cliente some sem mandar Unregistered/Removed,
// a extensão pode ficar presa em BUSY indefinidamente.
const busyFallbackTimeouts = {};

// Reserva temporária: evita entregar o mesmo ramal para dois clientes
// caso os eventos do AMI atrasem/não cheguem.
const extensionReservations = {};
const RESERVATION_TTL_MS = 10_000;

EXTENSIONS.forEach(ext => {
  extensionState[ext] = "free"; // free | busy | in_call
});

function clearBusyFallback(ext) {
  const t = busyFallbackTimeouts[ext];
  if (t) {
    clearTimeout(t);
    delete busyFallbackTimeouts[ext];
  }
}

function scheduleBusyFallback(ext) {
  clearBusyFallback(ext);
  if (!BUSY_TTL_MS || BUSY_TTL_MS <= 0) return;
  busyFallbackTimeouts[ext] = setTimeout(() => {
    delete busyFallbackTimeouts[ext];
    if (extensionState[ext] === "busy") {
      extensionState[ext] = "free";
      console.log(`[STATE] Fallback BUSY TTL expirou para ${ext} → FREE`);
    }
  }, BUSY_TTL_MS);
}

function extractKnownExtension(value) {
  if (!value) return null;
  const text = String(value);
  const found = EXTENSIONS.find(ext => text.includes(ext));
  return found || null;
}

function clearReservation(ext) {
  const existing = extensionReservations[ext];
  if (existing) {
    clearTimeout(existing);
    delete extensionReservations[ext];
  }
}

function reserveExtension(ext) {
  clearReservation(ext);
  clearBusyFallback(ext);
  extensionState[ext] = "reserved";
  extensionReservations[ext] = setTimeout(() => {
    delete extensionReservations[ext];
    if (extensionState[ext] === "reserved") {
      extensionState[ext] = "free";
      console.log(`[STATE] Reserva expirou para ${ext} → FREE`);
    }
  }, RESERVATION_TTL_MS);
}

// ========================
// EXPRESS SERVER
// ========================
const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => res.send("AMI Microservice Running"));

// API para o React pegar um ramal livre
app.get("/extensions/free", (req, res) => {
  const freeExt = EXTENSIONS.find(ext => extensionState[ext] === "free");

  if (!freeExt) {
    return res.status(404).json({ error: "No free extensions available" });
  }

  // Marca como reservado imediatamente para garantir fallback (3000 -> 3001)
  // mesmo se o AMI não emitir Registered/Unregistered a tempo.
  reserveExtension(freeExt);
  console.log(`[STATE] Extensão ${freeExt} reservada e disponibilizada ao front`);

  res.json({
    extension: freeExt,
    password: EXT_PASSWORD,
    wss: WSS_URL
  });
});

// API para liberar manualmente (caso necessário)
app.post("/extensions/release", (req, res) => {
  const ext = String(req.body?.extension ?? "").trim();

  if (!EXTENSIONS.includes(ext)) {
    return res.status(400).json({ error: "Invalid extension" });
  }

  clearReservation(ext);
  clearBusyFallback(ext);
  extensionState[ext] = "free";
  console.log(`[STATE] Extensão ${ext} liberada manualmente (POST)`);

  res.json({ ok: true });
});

// Mostrar estado atual
app.get("/extensions/status", (req, res) => {
  res.json({
    extensions: extensionState,
    amiConnected: isConnected,
    reconnectAttempts: reconnectAttempts
  });
});

// ========================
// AMI CONNECTION
// ========================
const client = new AmiClient();

// Evita que erros/rejeições não tratadas derrubem o processo.
process.on("unhandledRejection", (reason) => {
  console.error("[PROCESS] UnhandledRejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[PROCESS] UncaughtException:", err);
});

// Variáveis de controle de conexão
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY = 5000; // 5 segundos
let isConnected = false;
let reconnectTimeout = null;
let pingInterval = null;
const PING_INTERVAL = 30000; // Ping a cada 30 segundos

// Função para enviar ping e manter conexão viva
function startPingInterval() {
  if (pingInterval) clearInterval(pingInterval);
  
  pingInterval = setInterval(() => {
    if (isConnected) {
      try {
        client.action({
          Action: 'Ping'
        }).then(() => {
          console.log('[AMI] Ping OK - Conexão ativa');
        }).catch(err => {
          console.error('[AMI] Ping falhou:', err.message);
          isConnected = false;
          scheduleReconnect();
        });
      } catch (err) {
        console.error('[AMI] Erro ao enviar ping:', err.message);
        isConnected = false;
        scheduleReconnect();
      }
    }
  }, PING_INTERVAL);
}

// Agendar reconexão
function scheduleReconnect() {
  if (reconnectTimeout) return; // Já está agendada
  
  if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
    reconnectAttempts++;
    console.log(`[AMI] Agendando reconexão (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}) em ${RECONNECT_DELAY/1000}s...`);
    reconnectTimeout = setTimeout(() => {
      reconnectTimeout = null;
      connectToAMI();
    }, RECONNECT_DELAY);
  } else {
    console.error("✗ [AMI] Número máximo de tentativas atingido.");
  }
}

function connectToAMI() {
  // Limpar timeout de reconexão se existir
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  
  console.log(`[AMI] Tentando conectar ao ${AMI_HOST}:${AMI_PORT}...`);
  
  client.connect(AMI_USER, AMI_PASS, {
    host: AMI_HOST,
    port: AMI_PORT,
    family: 4,
    timeout: 15000,
    keepAlive: true,
    keepAliveInitialDelay: 5000
  })
  .then(() => {
    console.log(`✓ Conectado ao AMI em ${AMI_HOST}:${AMI_PORT}`);
    isConnected = true;
    reconnectAttempts = 0;
    
    // Iniciar ping periódico
    startPingInterval();
  })
  .catch(err => {
    console.error("✗ Erro ao conectar ao AMI:", err.message);
    isConnected = false;
    scheduleReconnect();
  });
}

// Iniciar conexão
connectToAMI();

// ========================
// TRATAMENTO DE EVENTOS DE CONEXÃO
// ========================
client.on("disconnect", () => {
  console.log("⚠ [AMI] Desconectado do servidor");
  isConnected = false;
  
  // Limpar interval de ping
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
  
  // Agendar reconexão
  scheduleReconnect();
});

client.on("error", (err) => {
  console.error("✗ [AMI] Erro na conexão:", err.message);
  isConnected = false;
});

client.on("close", () => {
  console.log("⚠ [AMI] Conexão fechada");
  isConnected = false;
  
  // Limpar interval de ping
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
  
  // Agendar reconexão
  scheduleReconnect();
});

client.on("connect", () => {
  console.log("✓ [AMI] Evento de conexão recebido");
  isConnected = true;
});

// ========================
// LISTEN TO AMI EVENTS
// ========================
client.on("event", event => {
  // -----------------------------
  // PeerStatus → Registered/Unregistered
  // -----------------------------
  if (event.Event === "PeerStatus") {
    const peer = event.Peer;            // Ex: PJSIP/3000
    const status = event.PeerStatus;    // Registered / Unregistered

    const ext = extractKnownExtension(peer);
    if (!ext) return;

    // Quando cliente se registra no SIP = está usando a extensão
    if (status === "Registered") {
      clearReservation(ext);
      // Só marca BUSY se antes a API reservou/entregou esse ramal.
      // Assim um ramal que fica permanentemente registrado (hardphone) não trava o pool.
      if (extensionState[ext] === "reserved") {
        extensionState[ext] = "busy";
        scheduleBusyFallback(ext);
      }
      console.log(`[AMI] ${ext} → REGISTERED (cliente conectado - BUSY)`);
    }

    // Quando desregistra (fechou página/reload) = libera extensão
    if (status === "Unregistered") {
      clearReservation(ext);
      clearBusyFallback(ext);
      extensionState[ext] = "free";
      console.log(`[AMI] ${ext} → UNREGISTERED (cliente desconectou - FREE)`);
    }
  }

  // -----------------------------
  // PJSIP ContactStatus → Created/Removed (registro do ramal)
  // -----------------------------
  if (event.Event === "ContactStatus") {
    // Normalmente o AOR/EndpointName tem o ramal (ex: "3000")
    const ext =
      extractKnownExtension(event.AOR) ||
      extractKnownExtension(event.EndpointName) ||
      extractKnownExtension(event.URI) ||
      extractKnownExtension(event.Contact);

    if (!ext) return;

    // ContactStatus: Created (registrou), Removed (desregistrou)
    if (event.ContactStatus === "Created") {
      clearReservation(ext);
      if (extensionState[ext] === "reserved") {
        extensionState[ext] = "busy";
        scheduleBusyFallback(ext);
      }
      console.log(`[AMI] ${ext} → CONTACT CREATED (REGISTERED - BUSY)`);
    }

    if (event.ContactStatus === "Removed") {
      clearReservation(ext);
      clearBusyFallback(ext);
      extensionState[ext] = "free";
      console.log(`[AMI] ${ext} → CONTACT REMOVED (UNREGISTERED - FREE)`);
    }
  }

  // -----------------------------
  // Newchannel → canal criado, pode significar início de chamada
  // -----------------------------
  if (event.Event === "Newchannel") {
    const channel = event.Channel; // PJSIP/3000-00000046
    const ext = extractKnownExtension(channel);
    if (!ext) return;

    clearReservation(ext);
    clearBusyFallback(ext);
    extensionState[ext] = "in_call";
    console.log(`[AMI] ${ext} → IN CALL`);
  }

  // -----------------------------
  // Hangup → chamada terminou, canal livre
  // -----------------------------
  if (event.Event === "Hangup") {
    const channel = event.Channel; // PJSIP/3000-00000046
    if (!channel) return;

    const ext = extractKnownExtension(channel);
    if (!ext) return;

    clearReservation(ext);
    clearBusyFallback(ext);
    extensionState[ext] = "free";
    console.log(`[AMI] ${ext} → CALL ENDED → FREE`);
  }
});

// ========================
// START SERVER
// ========================
const PORT = Number(process.env.PORT || process.env.API_PORT || 3001);
app.listen(PORT, () => console.log(`API rodando em http://localhost:${PORT}`));
