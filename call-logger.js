/**
 * call-logger.js — lightweight call log writer
 *
 * Logs call data to the console. Each entry is self-contained
 * so it can be piped to Dozzle or Docker log aggregators.
 *
 * Future: replace the TODO block below with a real DB insert.
 */

/**
 * Log a completed call.
 *
 * @param {object} callData
 * @param {string} callData.callSid       - Twilio Call SID
 * @param {string} callData.to            - Called number (E.164)
 * @param {string} callData.from          - Caller number (E.164)
 * @param {number} callData.durationSeconds
 * @param {string} callData.transcript    - Full conversation transcript
 * @param {string} callData.status        - 'completed' | 'error' | etc.
 * @param {string} callData.timestamp     - ISO 8601 timestamp
 */
function logCall(callData) {
  const { callSid, to, from, durationSeconds, transcript, status, timestamp } = callData;

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋 Call Log');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('   SID:       ', callSid || 'N/A');
  console.log('   To:        ', to || 'N/A');
  console.log('   From:      ', from || 'N/A');
  console.log('   Duration:  ', `${durationSeconds}s`);
  console.log('   Status:    ', status);
  console.log('   Timestamp: ', timestamp);
  console.log('   Transcript:', transcript ? `\n${formatTranscript(transcript)}` : '(none)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // TODO: INSERT INTO call_logs (PostgreSQL)
  // Schema reference:
  //   CREATE TABLE call_logs (
  //     id               SERIAL PRIMARY KEY,
  //     call_sid         TEXT,
  //     to_number        TEXT,
  //     from_number      TEXT,
  //     duration_seconds INTEGER,
  //     transcript       TEXT,
  //     status           TEXT,
  //     created_at       TIMESTAMPTZ DEFAULT now()
  //   );
  //
  // Example insert (pg / Drizzle / Prisma):
  //   await db.query(
  //     `INSERT INTO call_logs
  //      (call_sid, to_number, from_number, duration_seconds, transcript, status, created_at)
  //      VALUES ($1, $2, $3, $4, $5, $6, $7)`,
  //     [callSid, to, from, durationSeconds, transcript, status, timestamp]
  //   );
}

/**
 * Format a raw transcript string for console display.
 * Indents each line for readability.
 */
function formatTranscript(transcript) {
  return transcript
    .split('\n')
    .map((line) => `     ${line}`)
    .join('\n');
}

/**
 * Return the transcript formatted as a plain-text string
 * suitable for email dispatch.
 */
function formatTranscriptForEmail(callData) {
  const { callSid, to, durationSeconds, transcript, timestamp } = callData;
  return [
    `Nonnicare — Call Summary`,
    `========================`,
    `SID:       ${callSid}`,
    `To:        ${to}`,
    `Duration:  ${durationSeconds}s`,
    `Timestamp: ${timestamp}`,
    ``,
    `Transcript:`,
    `-----------`,
    transcript || '(no transcript recorded)',
  ].join('\n');
}

module.exports = { logCall, formatTranscriptForEmail };
