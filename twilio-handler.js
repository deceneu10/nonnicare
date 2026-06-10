require('dotenv').config();
const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/**
 * Initiate an outbound call via Twilio REST API.
 * Twilio will call the target, and when answered it will
 * fetch TwiML from PUBLIC_URL/twilio/twiml to open the media stream.
 */
async function initiateOutboundCall(targetPhoneNumber) {
  const from = process.env.TWILIO_PHONE_NUMBER;
  const twimlUrl = `${process.env.PUBLIC_URL}/twilio/twiml?to=${encodeURIComponent(targetPhoneNumber)}`;

  const call = await client.calls.create({
    to: targetPhoneNumber,
    from,
    url: twimlUrl,
  });

  console.log(`📞 Outbound call initiated | to: ${targetPhoneNumber} | SID: ${call.sid}`);

  return {
    success: true,
    callSid: call.sid,
    to: call.to,
    from: call.from,
    status: call.status,
  };
}

/**
 * Generate TwiML that opens a Twilio Media Stream WebSocket
 * back to our server when the called party answers.
 * @param {string} [toPhoneNumber] - The number being called; embedded as a custom
 *   Stream parameter so audio-bridge can log it accurately.
 */
function generateTwiML(toPhoneNumber) {
  const streamUrl = `wss://${process.env.PUBLIC_URL.replace('https://', '')}/twilio/stream`;
  const toParam = toPhoneNumber
    ? `\n    <Parameter name="to" value="${toPhoneNumber}" />`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}">${toParam}
    </Stream>
  </Connect>
</Response>`;
}

module.exports = { initiateOutboundCall, generateTwiML };
