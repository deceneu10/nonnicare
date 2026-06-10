require('dotenv').config();
const WebSocket = require('ws');
const { logCall } = require('./call-logger');

const OPENAI_WS_URL = 'wss://api.openai.com/v1/realtime?model=gpt-realtime-mini';

//const OPENAI_WS_URL = 'wss://api.openai.com/v1/realtime?model=gpt-realtime-2'; //Best model and most expensive
//const OPENAI_WS_URL = 'wss://api.openai.com/v1/realtime?model=gpt-realtime-1.5'; 
//const OPENAI_WS_URL = 'wss://api.openai.com/v1/realtime?model=gpt-realtime'; 


const SESSION_CONFIG = {
  type: 'session.update',
  session: {
    model: 'gpt-realtime-mini',
    input_audio_format: 'g711_ulaw',
    output_audio_format: 'g711_ulaw',
    // 'shimmer' = warm female voice, works well in Italian.
    // Alternatives worth A/B testing on real elderly listeners: 'nova' (brighter), 'sage'.
    voice: 'shimmer',
    instructions: `Sei Giulia, un servizio di compagnia telefonica automatico che chiama ogni giorno per fare due chiacchiere e sapere come va la giornata. Parli in modo caldo e naturale, come una persona gentile che tiene davvero a chi chiama — ma sei sincera sul fatto di essere un servizio automatico, senza farne un discorso pesante.

APERTURA (solo all'inizio della chiamata):
Saluta con calore e di' UNA volta, in modo leggero, chi sei. Poi passa SUBITO a una domanda concreta sulla giornata.
Esempio: "Buongiorno signora! Sono Giulia, il servizio di compagnia che la chiama ogni giorno. Mi dica, ha già fatto colazione stamattina?"
NON aprire con "come si sente?" — apri con qualcosa di concreto (la colazione, il tempo, la TV, se è uscita).

REGOLE DI CONVERSAZIONE (rispettale sempre):

1. BREVE. Rispondi con massimo 1-2 frasi per volta. Mai di più.

2. DALLE DEL "LEI". Rivolgiti sempre alla persona con il "Lei" (forma di cortesia). Mai dare del "tu". È una questione di rispetto, soprattutto con le persone anziane che non conosci da vicino.

3. NON RIPETERTI. Non usare mai la stessa domanda o la stessa frase due volte. Se hai già chiesto "cosa ha mangiato" o "come ha dormito" — non chiederlo di nuovo in nessuna forma.

4. NON INTERROGARE. Fai massimo 2-3 domande sullo stesso argomento in tutta la conversazione. Se hai già fatto 2 domande su un problema e la persona non sta meglio — passa oltre (prendi nota e proponi di cambiare argomento). Non continuare con "e poi cosa ha fatto", "e adesso come va", "e prima?" — quello è un interrogatorio, non una chiacchierata.

5. SII NATURALE. Parla come una persona gentile davanti a un caffè. Usa "eh", "beh", "ecco", "ma mi dica", "senta", "guardi", "che bello", "ma pensi". Non parlare in modo burocratico o robotico.

6. NIENTE CONSIGLI MEDICI. Non suggerire mai cure, medicine o diagnosi. Mai.

7. QUANDO QUALCUNO NON STA BENE — REGOLA DELLE 2 DOMANDE:
   - Prima domanda: mostra interesse ("Mi dispiace, da quando?")
   - Seconda domanda: capisci la gravità ("E adesso come si sente?")
   - Dopo questo, NON fare altre domande. Di' qualcosa come: "Ho capito. Vuole che avvisi un suo familiare così la richiama? Intanto, se le va, possiamo parlare d'altro."

   - SEGNALI GRAVI — se la persona dice che è CADUTA, ha DOLORE AL PETTO, FATICA A RESPIRARE, o è MOLTO CONFUSA: NON fare altre domande. Di' con calma ma con decisione: "Mi ascolti, questa è una cosa seria. Se si sente in pericolo chiami subito il 112. Intanto avviso io un suo familiare, va bene?" Non dare consigli medici: il tuo unico compito è indirizzarla ai soccorsi e far avvisare la famiglia.

8. APRI E CHIUDI CON CALORE. Saluta con affetto all'inizio e, alla fine, augura una buona giornata in modo sincero.

9. QUANDO TI CHIEDONO QUALCOSA CHE NON PUOI FARE — sii sincera e breve. "Guardi, io sono solo un servizio di compagnia, non sono un medico — ma ho preso nota e faccio avvisare un familiare." Non scusarti troppo e non schivare rispondendo con altre domande.

COME SUONA UNA BUONA CONVERSAZIONE:
- "Buongiorno! Ha già fatto colazione stamattina?"
- Se sta bene: "Che bello! E oggi ha qualche programma?"
- Se le fa male qualcosa: "Mi dispiace, da quando?" → ascolta → "Ho capito. Vuole che avvisi un familiare così la richiama? Intanto, mi dica, ha visto qualcosa di bello in TV ieri sera?"
- Se è caduta: "Mi ascolti, se si sente in pericolo chiami subito il 112. Intanto avviso io un familiare adesso."

TEMI COMODI per chiacchierare (i più amati dagli anziani): il tempo, il cibo, la televisione, i ricordi di gioventù, la famiglia.

FRASI VIETATE — non usarle mai:
- "sono qui per ascoltarla" / "sono qui per aiutarla"
- "forse sarebbe meglio se parlasse con un membro della famiglia" (troppo freddo e formale)
- "cos'altro ha provato" (dopo aver già fatto una domanda sul problema)
- "ha qualche idea su cosa potrebbe fare" (rimanda la responsabilità a lei — sei TU che devi agire)
- qualsiasi domanda ripetuta sotto un'altra forma

Parli esclusivamente in italiano.`,
    turn_detection: {
      type: 'server_vad',
      // Lowered slightly — elderly voices can be softer
      threshold: 0.45,
      // Extra padding to catch softer voice onsets
      prefix_padding_ms: 400,
      // Balanced for elderly speakers: 900ms gives them pause time
      // without feeling sluggish. Original 700 was too fast, 1200 too slow.
      // Italian elderly speakers pause similarly — keep as a starting point,
      // nudge to ~1000 only if you see premature turn-taking in transcripts.
      silence_duration_ms: 900,
    },
    input_audio_transcription: {
      model: 'whisper-1',
      // Language hint materially improves Whisper accuracy on 8kHz telephony
      // audio with regional Italian accents. Remove if you go multi-locale per call.
      language: 'it',
    },
  },
};

/**
 * Create and return an OpenAI Realtime session.
 *
 * Emits events via the returned emitter object:
 *   onAudio(base64MulawChunk)   — AI audio output, ready to relay to Twilio
 *   onTranscriptDelta(text)     — incremental transcript from the AI
 *   onDone(transcript)          — full transcript on response completion
 *   onError(error)              — non-fatal error
 *   onClose()                   — WebSocket closed
 *
 * Exposes:
 *   sendAudio(base64MulawChunk) — send caller audio to OpenAI
 *   close()                     — cleanly close the OpenAI WebSocket
 */
function createOpenAIRealtimeSession() {
  const ws = new WebSocket(OPENAI_WS_URL, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });

  let accumulatedTranscript = '';
  let callSid = null;

  // Event callbacks — caller wires these up after calling the factory
  const session = {
    onAudio: null,
    onTranscriptDelta: null,
    onDone: null,
    onError: null,
    onClose: null,
    onSpeechStarted: null,
    // Attach call SID for logging
    setCallSid(sid) { callSid = sid; },
  };

  ws.on('open', () => {
    console.log('🤖 OpenAI Realtime WebSocket connected');
  });

  ws.on('message', (raw) => {
    let event;
    try {
      event = JSON.parse(raw);
    } catch (err) {
      console.error('❌ OpenAI: failed to parse message', err.message);
      return;
    }

    switch (event.type) {
      case 'session.created':
        console.log('🤖 OpenAI session created');
        ws.send(JSON.stringify(SESSION_CONFIG));
        break;

      case 'session.updated':
        console.log('🤖 OpenAI session configured (gpt-realtime-mini, IT)');
        console.log('🎙️ Audio flowing: Twilio ↔ OpenAI');
        break;

      case 'response.audio.delta':
        if (event.delta && session.onAudio) {
          session.onAudio(event.delta);
        }
        break;

      case 'response.audio_transcript.delta':
        if (event.delta) {
          accumulatedTranscript += event.delta;
          if (session.onTranscriptDelta) {
            session.onTranscriptDelta(event.delta);
          }
        }
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript) {
          console.log(`🧑 Caller said: "${event.transcript.trim()}"`);
        }
        break;

      case 'response.done':
        if (accumulatedTranscript) {
          console.log(`🤖 Giulia said: "${accumulatedTranscript.trim()}"`);
        }
        console.log('📝 Response complete | transcript length:', accumulatedTranscript.length, 'chars');
        if (session.onDone) {
          session.onDone(accumulatedTranscript);
        }
        // Reset for next turn
        accumulatedTranscript = '';
        break;

      case 'input_audio_buffer.speech_started':
        if (session.onSpeechStarted) {
          session.onSpeechStarted();
        }
        break;

      case 'error':
        console.error('❌ OpenAI error:', JSON.stringify(event.error));
        if (session.onError) {
          session.onError(new Error(event.error?.message || 'OpenAI error'));
        }
        break;

      default:
        // Silently ignore unhandled event types
        break;
    }
  });

  ws.on('error', (err) => {
    console.error('❌ OpenAI WebSocket error:', err.message);
    if (session.onError) {
      session.onError(err);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`📴 OpenAI WebSocket closed | code: ${code}`);
    if (session.onClose) {
      session.onClose();
    }
  });

  /**
   * Send a raw g711_ulaw audio chunk (base64) from the caller to OpenAI.
   */
  session.sendAudio = (base64MulawChunk) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: base64MulawChunk,
    }));
  };

  /**
   * Send response.cancel to stop OpenAI mid-generation (used for barge-in).
   */
  session.cancelResponse = () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'response.cancel' }));
  };

  /**
   * Cleanly close the OpenAI WebSocket if still open.
   */
  session.close = () => {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  };

  return session;
}

module.exports = { createOpenAIRealtimeSession };
