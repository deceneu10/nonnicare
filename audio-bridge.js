const { createOpenAIRealtimeSession } = require('./openai-realtime');
const { logCall } = require('./call-logger');

/**
 * Handle a Twilio Media Stream WebSocket connection.
 *
 * Twilio sends messages in this format:
 *   { event: 'start',  start: { streamSid, callSid, ... } }
 *   { event: 'media',  media: { payload: BASE64_MULAW } }
 *   { event: 'stop' }
 *
 * To send audio back to Twilio:
 *   { event: 'media', streamSid, media: { payload: BASE64_MULAW } }
 */
function handleTwilioMediaStream(twilioWs) {
  let streamSid = null;
  let callSid = null;
  let openAISession = null;
  let callStartTime = null;
  let fullTranscript = '';

  // ── Helper: forward audio from OpenAI → Twilio ──────────────────────────
  function sendAudioToTwilio(base64MulawChunk) {
    if (twilioWs.readyState !== twilioWs.OPEN) return;
    if (!streamSid) return;

    twilioWs.send(JSON.stringify({
      event: 'media',
      streamSid,
      media: { payload: base64MulawChunk },
    }));
  }

  // ── Helper: clean up on call end ─────────────────────────────────────────
  function teardown(reason) {
    console.log(`📴 Stream ended | reason: ${reason}`);

    if (openAISession) {
      openAISession.close();
      openAISession = null;
    }

    const durationSeconds = callStartTime
      ? Math.round((Date.now() - callStartTime) / 1000)
      : 0;

    logCall({
      callSid,
      to: process.env.TARGET_PHONE_NUMBER,
      from: process.env.TWILIO_PHONE_NUMBER,
      durationSeconds,
      transcript: fullTranscript,
      status: 'completed',
      timestamp: new Date().toISOString(),
    });
  }

  // ── Twilio message handler ───────────────────────────────────────────────
  twilioWs.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      console.error('❌ Audio bridge: failed to parse Twilio message', err.message);
      return;
    }

    switch (msg.event) {
      case 'start': {
        streamSid = msg.start.streamSid;
        callSid   = msg.start.callSid;
        callStartTime = Date.now();

        console.log(`🔊 Media stream started | SID: ${streamSid}`);

        // Create OpenAI Realtime session and wire up callbacks
        openAISession = createOpenAIRealtimeSession();
        openAISession.setCallSid(callSid);

        openAISession.onAudio = (base64Chunk) => {
          sendAudioToTwilio(base64Chunk);
        };

        openAISession.onTranscriptDelta = (delta) => {
          fullTranscript += delta;
        };

        openAISession.onDone = (_transcript) => {
          // transcript already accumulated in fullTranscript via onTranscriptDelta
        };

        openAISession.onError = (err) => {
          console.error('❌ OpenAI session error in audio bridge:', err.message);
        };

        openAISession.onClose = () => {
          // OpenAI closed for a reason other than us calling teardown — close Twilio side too
          if (twilioWs.readyState === twilioWs.OPEN) {
            twilioWs.close();
          }
        };

        break;
      }

      case 'media': {
        if (openAISession && msg.media?.payload) {
          openAISession.sendAudio(msg.media.payload);
        }
        break;
      }

      case 'stop': {
        teardown('twilio-stop');
        break;
      }

      default:
        break;
    }
  });

  // ── Twilio connection lifecycle ──────────────────────────────────────────
  twilioWs.on('error', (err) => {
    console.error('❌ Twilio WebSocket error:', err.message);
    teardown('twilio-error');
  });

  twilioWs.on('close', () => {
    teardown('twilio-close');
  });
}

module.exports = { handleTwilioMediaStream };
