require('dotenv').config();
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const { initiateOutboundCall, generateTwiML } = require('./twilio-handler');
const { handleTwilioMediaStream }             = require('./audio-bridge');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ noServer: true });

app.use(express.json());

// ── Request logger ────────────────────────────────────────────────────────
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HEALTH CHECKS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get('/', (req, res) => {
  res.json({
    status: 'Nonnicare AI Calling System Running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    version: '2.0.0',
    telephony: 'TWILIO',
    ai_model: 'gpt-realtime-mini',
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString(),
    telephony: {
      provider: 'twilio',
      from: process.env.TWILIO_PHONE_NUMBER,
      account_sid_configured: !!process.env.TWILIO_ACCOUNT_SID,
      auth_token_configured: !!process.env.TWILIO_AUTH_TOKEN,
    },
    openai: {
      api_key_configured: !!process.env.OPENAI_API_KEY,
      model: 'gpt-realtime-mini',
    },
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TWILIO ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Twilio fetches this URL when the called party answers.
 * Returns TwiML that opens the Media Stream WebSocket.
 */
app.post('/twilio/twiml', (req, res) => {
  console.log('🔗 Twilio fetching TwiML...');
  const twiml = generateTwiML(req.query.to);
  res.setHeader('Content-Type', 'application/xml');
  res.status(200).send(twiml);
  console.log('📡 TwiML delivered (XML)');
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API ENDPOINTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * POST /api/calls/initiate
 * Body: { phone_number: "+40..." }  (optional — falls back to TARGET_PHONE_NUMBER)
 */
app.post('/api/calls/initiate', async (req, res) => {
  const phone_number = req.body?.phone_number || process.env.TARGET_PHONE_NUMBER;

  if (!phone_number) {
    return res.status(400).json({
      error: 'phone_number is required (or set TARGET_PHONE_NUMBER in env)',
      example: { phone_number: '+40723456789' },
    });
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📞 Initiating Outbound Call');
  console.log('Time:', new Date().toISOString());
  console.log('To:', phone_number);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  try {
    const result = await initiateOutboundCall(phone_number);
    console.log('✅ Call successfully initiated | SID:', result.callSid);
    res.json(result);
  } catch (error) {
    console.error('❌ Error initiating call:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to initiate call',
      message: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /api/calls/test
 * Quick-fire test — calls TARGET_PHONE_NUMBER without needing a request body.
 */
app.get('/api/calls/test', async (req, res) => {
  const phone_number = process.env.TARGET_PHONE_NUMBER;

  if (!phone_number || phone_number.startsWith('REPLACE')) {
    return res.status(503).json({
      success: false,
      error: 'TARGET_PHONE_NUMBER not configured in .env',
    });
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🧪 Test Call');
  console.log('To:', phone_number);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  try {
    const result = await initiateOutboundCall(phone_number);
    console.log('✅ Test call initiated | SID:', result.callSid);
    res.json({ ...result, message: 'Test call initiated' });
  } catch (error) {
    console.error('❌ Test call failed:', error.message);
    res.status(500).json({
      success: false,
      error: 'Test call failed',
      message: error.message,
    });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 404 + ERROR HANDLERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', path: req.path });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'An error occurred',
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WEBSOCKET UPGRADE — Twilio Media Stream
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

server.on('upgrade', (request, socket, head) => {
  if (request.url === '/twilio/stream') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      console.log('🔌 Twilio Media Stream WebSocket connected');
      handleTwilioMediaStream(ws);
    });
  } else {
    socket.destroy();
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STARTUP
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🚀 Nonnicare AI Calling System v2.0.0');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Port:         ', PORT);
  console.log('Telephony:    TWILIO (' + process.env.TWILIO_PHONE_NUMBER + ')');
  console.log('AI Model:     gpt-realtime-mini');
  console.log('Audio format: g711_ulaw (no transcoding)');
  console.log('Target:       ', process.env.TARGET_PHONE_NUMBER);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});

// ── Safety net ────────────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled promise rejection:', reason);
});
