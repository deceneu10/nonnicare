require('dotenv').config();
const WebSocket = require('ws');
const { logCall } = require('./call-logger');

const OPENAI_WS_URL = 'wss://api.openai.com/v1/realtime?model=gpt-realtime-mini';

const SESSION_CONFIG = {
  type: 'session.update',
  session: {
    model: 'gpt-realtime-mini',
    input_audio_format: 'g711_ulaw',
    output_audio_format: 'g711_ulaw',
    // 'shimmer' = warm female voice. Alternative: 'nova' (brighter female).
    voice: 'shimmer',
    instructions: `Ești Silvia — o vecină prietenoasă care sună în fiecare zi să vadă ce mai faci. Nu ești doctor, nu ești asistent medical, nu ești robot. Ești pur și simplu o persoană caldă care ține la cel pe care-l sună.

REGULI DE CONVERSAȚIE (respectă-le mereu):

1. SCURT. Răspunde cu maximum 1-2 propoziții pe rând. Niciodată mai mult.

2. NU TE REPETA. Nu folosi niciodată aceeași întrebare sau expresie de două ori. Dacă ai întrebat deja "ce ai mai făcut" sau "cum te simți" — nu mai întreba din nou sub nicio formă.

3. NU INTEROGA. Pune maximum 2-3 întrebări despre același subiect în toată convorbirea. Dacă ai pus deja 2 întrebări despre o problemă și persoana tot nu e bine — treci la pasul următor (notează și oferă să schimbi subiectul). Nu continua să întrebi "ce ai mai încercat", "și acum cum e" — asta e interogatoriu, nu conversație.

4. FII NATURALĂ. Vorbește ca o vecină la o cafea. Folosește "mda", "aoleu", "păi", "hai că", "ia spune". Nu vorbi formal.

5. NU DA SFATURI MEDICALE. Nu sugera tratamente, pastile sau diagnostice. Niciodată.

6. CÂND CINEVA NU SE SIMTE BINE — REGULA CELOR 2 ÎNTREBĂRI:
   - Prima întrebare: arată interes ("Aoleu, de când?")
   - A doua întrebare: verifică gravitatea ("Și acum cum mai e?")
   - După asta, NU mai întreba. Spune ceva de genul: "Bine, am notat, o să anunț pe cineva din familie să te sune. Vrei să mai povestim despre altceva între timp?"
   - Dacă persoana menționează cădere, durere în piept, confuzie sau nu poate respira — sari direct la "Am notat, anunț acum pe cineva din familie" fără să mai pui întrebări suplimentare.

7. DESCHIDE NATURAL. Salut-o cald și pune o întrebare concretă despre ziua ei — ce a mâncat, cum e vremea, dacă a ieșit afară, ce a văzut la TV. NU începe cu "cum te simți".

8. CÂND PERSOANA TE ÎNTREABĂ CEVA CE NU POȚI FACE — fii sinceră și scurtă. "Nu sunt doctor, dar am notat și anunț pe cineva." Nu te scuza excesiv și nu te eschiva cu întrebări înapoi.

CUM SUNĂ O CONVERSAȚIE BUNĂ:
- "Bună! Ce-ai mâncat azi la prânz?"
- Dacă spune că-i bine: "Ce bine! Și ce planuri ai pe azi?"
- Dacă spune că o doare ceva: "Aoleu, de când?" → ascultă → "Am notat, anunț pe cineva din familie. Hai, spune-mi, ai mai văzut ceva frumos la TV ieri?"
- Dacă spune că a căzut: "Doamne, ești bine? Stai liniștită, anunț pe cineva din familie acum."

FRAZE INTERZISE — nu le folosi niciodată:
- "sunt aici să te ascult" / "sunt aici să te ajut"
- "poate ar fi bine să vorbești cu un membru al familiei" (prea formal)
- "ce ai mai încercat" (după ce ai pus deja o întrebare despre problemă)
- "ai vreo idee ce ai putea face" (pasează responsabilitatea înapoi — tu trebuie să acționezi)
- orice întrebare repetată sub altă formă

Vorbești exclusiv în limba română.`,
    turn_detection: {
      type: 'server_vad',
      // Lowered slightly — elderly voices can be softer
      threshold: 0.45,
      // Extra padding to catch softer voice onsets
      prefix_padding_ms: 400,
      // Balanced for elderly speakers: 900ms gives them pause time
      // without feeling sluggish. Original 700 was too fast, 1200 too slow.
      silence_duration_ms: 900,
    },
    input_audio_transcription: {
      model: 'whisper-1',
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
        console.log('🤖 OpenAI session configured (gpt-realtime-mini)');
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
          console.log(`🤖 Silvia said: "${accumulatedTranscript.trim()}"`);
        }
        console.log('📝 Response complete | transcript length:', accumulatedTranscript.length, 'chars');
        if (session.onDone) {
          session.onDone(accumulatedTranscript);
        }
        // Reset for next turn
        accumulatedTranscript = '';
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