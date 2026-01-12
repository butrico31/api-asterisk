# API Asterisk - Gerenciamento de Extensões

## 🚀 Como Usar

```powershell
node src/index.js
```

## 📡 Endpoints

### GET /extensions/free
Retorna uma extensão livre para uso
```json
{
  "extension": "3000",
  "password": "senha123",
  "wss": "wss://srv762442.hstgr.cloud:8089/ws"
}
```

### POST /extensions/release
Libera uma extensão manualmente
```json
{
  "extension": "3000"
}
```

### GET /extensions/status
Mostra status de todas as extensões
```json
{
  "extensions": {
    "3000": "free"
  },
  "amiConnected": true,
  "reconnectAttempts": 0
}
```

### POST /extensions/reset
Reseta todas as extensões para "free" (útil para debug)

## 🔄 Estados das Extensões

- **free**: Disponível para uso
- **busy**: Cliente conectado ao SIP (usando a extensão)
- **in_call**: Em chamada ativa

## ⚙️ Funcionamento Automático via AMI

1. **Cliente pega extensão** → GET /extensions/free (ainda `free`)
2. **Cliente conecta no SIP** → Evento `Registered` → marca como `busy`
3. **Cliente faz reload/fecha** → Evento `Unregistered` → marca como `free`
4. **Cliente inicia chamada** → Evento `Newchannel` → marca como `in_call`
5. **Cliente termina chamada** → Evento `Hangup` → volta para `busy`
6. **Cliente desconecta SIP** → Evento `Unregistered` → marca como `free`

## 🔧 Configuração AMI

Edite `src/index.js`:
```javascript
const AMI_USER = "node_ami";
const AMI_PASS = "senha123";
const AMI_HOST = "srv762442.hstgr.cloud";
const AMI_PORT = 5038;
```

## 📋 Debug

Se uma extensão ficar travada em "busy":
- Use POST /extensions/release com o número da extensão
- O estado será automaticamente atualizado quando o cliente desconectar do SIP

## 🔍 Monitoramento

A API envia ping ao AMI a cada 30 segundos para manter conexão ativa.
Logs importantes:
- `[AMI] Ping OK` - Conexão saudável
- `[AMI] 3000 → REGISTERED` - Extensão disponível
- `[AMI] 3000 → IN CALL` - Chamada iniciada
- `[AMI] 3000 → CALL ENDED → FREE` - Chamada finalizada
