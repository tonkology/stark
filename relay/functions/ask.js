// Ask STARK relay core: turns a student's photo + question into a safe, structured answer.
// No Firebase code here, so it can be tested on its own (see test.js).
const MODEL = process.env.STARK_MODEL || 'claude-sonnet-5-5';
const MAX_IMAGE_B64 = 3_500_000; // about 2.6 MB of JPEG

const SYSTEM = `You are "Ask STARK", the lab assistant for the industrial automation and robotics labs at King Abdulaziz University (FESTO training stations, Siemens PLCs and drives, pneumatics, sensors, robots, 3D printers, CNC).
A student sends a photo of equipment and a question. Help them the way a careful senior lab engineer would.

Rules:
1. Use the VERIFIED KNOWLEDGE block first. If it answers the question, follow it and do not contradict it. Use the photo to locate things.
2. Only describe what you can actually see or what the verified knowledge states. Never invent part numbers, voltages, addresses or port names. If you cannot tell, say so and set confidence to "low".
3. Safety comes first. If any step involves mains voltage (230 V), compressed air, moving axes, robots or opening a cabinet, put the safety items in "safety" before the steps.
4. If CLEARED is false, do NOT give steps that energise, start or move the equipment. Explain what the parts are, tell the student to get a supervisor, and set "needs_supervisor" to true.
5. Set "needs_supervisor" to true whenever the task involves mains wiring, bypassing an interlock or emergency stop, or anything you are unsure about.
6. Keep it short: at most 8 steps, each one plain sentence a second-year engineering student can follow.
7. For each step that points at something visible in the photo, give "x" and "y": the position of that thing as fractions of the image width and height (0 to 1, origin at the top-left). Leave x and y out when the step is not about a visible spot, or when there is no photo.
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
    `CLEARED: ${body.cleared ? 'true' : 'false'}`,
    st ? `STATION: ${clip(st.id, 40)} | ${clip(st.name, 120)} | ${clip(st.category, 60)} | ${clip(st.location, 120)}` : 'STATION: not specified',
    st && st.notes ? `STATION NOTES: ${clip(st.notes, 800)}` : '',
    kb.length ? 'VERIFIED KNOWLEDGE:\n' + kb.map((d, i) => `[${i + 1}] ${clip(d.title, 160)}\n${clip(d.body, 1800)}`).join('\n\n') : 'VERIFIED KNOWLEDGE: none for this station',
    `QUESTION: ${clip(body.question, 600)}`,
  ].filter(Boolean).join('\n\n');
  const content = [];
  if (body.image) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: body.image } });
  content.push({ type: 'text', text });
  const history = cleanHistory(body.history);
  return { model: MODEL, max_tokens: 1500, system: SYSTEM, messages: [...history, { role: 'user', content }] };
}

function sanitize(raw, cleared) {
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
    needs_supervisor: !cleared || !!raw.needs_supervisor,
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
  const a = txt.indexOf('{'), b = txt.lastIndexOf('}');
  let raw;
  try { raw = JSON.parse(txt.slice(a, b + 1)); } catch (e) { raw = { summary: txt, steps: [], safety: [], confidence: 'low' }; }
  return { status: 200, answer: sanitize(raw, !!body.cleared) };
}

module.exports = { handleAsk, buildRequest, sanitize, cleanHistory, MODEL };
