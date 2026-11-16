// Ask STARK relay core: turns a student's photo + question into a safe, structured answer.
// No Firebase code here, so it can be tested on its own (see test.js).
const MODEL = process.env.STARK_MODEL || 'claude-sonnet-5-5';
const MAX_IMAGE_B64 = 3_500_000; // about 2.6 MB of JPEG

const SYSTEM = `You are "Ask STARK", the lab assistant for the industrial automation and robotics labs at King Abdulaziz University (FESTO training stations, Siemens PLCs and drives, pneumatics, sensors, robots, 3D printers, CNC).
A student sends a photo of equipment and a question. Help them the way a careful senior lab engineer would.

Rules:
1. Use the VERIFIED KNOWLEDGE block first. If it answers the question, follow it and do not contradict it.
2. If there is no verified knowledge, still answer from what you see in the photo and your general knowledge of FESTO MPS stations, Siemens S7-300/S7-1200 PLCs, MICROMASTER/SINAMICS drives, pneumatics and sensors. That is expected, not a reason to refuse. Set confidence to "medium" or "low" and say briefly what you could not confirm. Never invent part numbers, voltages, addresses or port names you cannot read.
3. Safety first, but short and specific to THIS task: at most 3 safety items, no generic warnings.
4. ROLE "director" is the lab director, an experienced engineer and the supervisor. Answer him directly and technically, with concrete steps, including how to power up and run the equipment. Never tell him to ask a supervisor, and set "needs_supervisor" to false.
5. For ROLE "member" (a student): if CLEARED is false, do NOT give steps that energise, start or move the equipment; explain what the parts are and set "needs_supervisor" to true. If CLEARED is true, give the steps. Set "needs_supervisor" to true only for rewiring mains, bypassing an interlock or emergency stop, or when you really cannot tell what is safe.
6. Keep it short: summary at most 2 sentences, at most 8 steps, each step one plain sentence of at most 25 words.
7. When a photo is attached, give "x" and "y" for EVERY step that refers to something visible in it: the centre of that thing as fractions of the image width and height (0 to 1, origin top-left). Look carefully so the point lands on the part. Leave x and y out only for steps about nothing visible.
8. This can be a conversation. Earlier assistant turns are your own previous replies; answer the LATEST question in that context and do not repeat earlier steps unless asked. A short follow-up may need only a "summary" and no steps. The photo attached to the latest message is the current photo; x/y always refer to it.
9. Reply in the language given in LANG ("ar" = Arabic in a clear, simple register; "en" = English). Keep technical labels as printed on the equipment.

Reply with ONE JSON object and nothing else:
{"summary": "one or two sentences answering the question",
 "safety": ["short safety item", "..."],
 "steps": [{"text": "what to do", "x": 0.42, "y": 0.31}],
 "confidence": "high" | "medium" | "low",
 "needs_supervisor": true | false}`;

function clip(s, n) { return String(s == null ? '' : s).slice(0, n); }

function cleanHistory(h) {
  const out = [];
  (Array.isArray(h) ? h : []).slice(-12).forEach(m => {
    const role = m && m.role === 'assistant' ? 'assistant' : m && m.role === 'user' ? 'user' : null;
    const text = clip(m && m.content, 2000).trim();
    if (!role || !text) return;
    if (!out.length && role !== 'user') return;          // must start with the student
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += '\n\n' + text;
    else out.push({ role, content: text });
  });
  if (out.length && out[out.length - 1].role === 'user') out.pop(); // the current question is added separately
  return out;
}

function buildRequest(body) {
  const st = body.station || null;
  const kb = Array.isArray(body.knowledge) ? body.knowledge.slice(0, 3) : [];
  const text = [
    `LANG: ${body.lang === 'ar' ? 'ar' : 'en'}`,
    `ROLE: ${body.role === 'director' ? 'director' : 'member'}`,
    `CLEARED: ${body.cleared || body.role === 'director' ? 'true' : 'false'}`,
    st ? `STATION: ${clip(st.id, 40)} | ${clip(st.name, 120)} | ${clip(st.category, 60)} | ${clip(st.location, 120)}` : 'STATION: not specified',
    st && st.notes ? `STATION NOTES: ${clip(st.notes, 800)}` : '',
    kb.length ? 'VERIFIED KNOWLEDGE:\n' + kb.map((d, i) => `[${i + 1}] ${clip(d.title, 160)}\n${clip(d.body, 1800)}`).join('\n\n') : 'VERIFIED KNOWLEDGE: none for this station',
    `QUESTION: ${clip(body.question, 600)}`,
  ].filter(Boolean).join('\n\n');
  const content = [];
  if (body.image) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: body.image } });
  content.push({ type: 'text', text });
  const history = cleanHistory(body.history);
  return { model: MODEL, max_tokens: 4096, system: SYSTEM, messages: [...history, { role: 'user', content }] };
}

// Parse the model's JSON; if the reply was cut off, close open strings/brackets and try again.
function parseReply(txt) {
  const a = txt.indexOf('{');
  if (a < 0) return null;
  const b = txt.lastIndexOf('}');
  if (b > a) { try { return JSON.parse(txt.slice(a, b + 1)); } catch (e) { /* repair below */ } }
  let src = txt.slice(a), out = '', stack = [], inStr = false, esc = false;
  for (const ch of src) {
    out += ch;
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true; else if (ch === '{' || ch === '[') stack.push(ch); else if (ch === '}' || ch === ']') stack.pop();
  }
  if (inStr) out += '"';
  out = out.replace(/,\s*$/, '').replace(/,\s*"[^"]*"\s*:?\s*$/, '').replace(/:\s*$/, ': null');
  while (stack.length) out += stack.pop() === '{' ? '}' : ']';
  try { return JSON.parse(out); } catch (e) { return null; }
}

function sanitize(raw, cleared, role) {
  const num = v => (typeof v === 'number' && isFinite(v) ? Math.min(1, Math.max(0, v)) : undefined);
  const steps = (Array.isArray(raw.steps) ? raw.steps : []).slice(0, 8).map(s => {
    const o = { text: clip(s && s.text, 400) };
    const x = num(s && s.x), y = num(s && s.y);
    if (x !== undefined && y !== undefined) { o.x = x; o.y = y; }
    return o;
  }).filter(s => s.text);
  const conf = ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'medium';
  return {
    summary: clip(raw.summary, 900),
    safety: (Array.isArray(raw.safety) ? raw.safety : []).slice(0, 6).map(s => clip(s, 300)).filter(Boolean),
    steps,
    confidence: conf,
    needs_supervisor: role === 'director' ? false : (!cleared || !!raw.needs_supervisor),
  };
}

async function handleAsk(body, { apiKey, fetchImpl = fetch }) {
  if (!body || !clip(body.question, 600).trim()) return { status: 400, error: 'Missing question' };
  if (body.image && (typeof body.image !== 'string' || body.image.length > MAX_IMAGE_B64)) return { status: 413, error: 'Photo is too large' };
  const r = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(buildRequest(body)),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { status: 502, error: 'Assistant error: ' + clip(data && data.error && data.error.message, 200) };
  const txt = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const raw = parseReply(txt) || { summary: txt.replace(/[{}\[\]"]/g, ' ').slice(0, 900), steps: [], safety: [], confidence: 'low' };
  if (data.stop_reason === 'max_tokens') console.warn('askStark: reply hit max_tokens and was repaired');
  return { status: 200, answer: sanitize(raw, !!body.cleared || body.role === 'director', body.role) };
}

module.exports = { handleAsk, buildRequest, sanitize, cleanHistory, parseReply, MODEL };
