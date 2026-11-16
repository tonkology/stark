// Local check of the relay logic with a fake Claude reply. Run: node test.js
const assert = require('assert');
const { handleAsk, buildRequest } = require('./ask');
const fake = reply => async (url, opt) => {
  fake.last = JSON.parse(opt.body); fake.headers = opt.headers;
  return { ok: true, json: async () => ({ content: [{ type: 'text', text: reply }] }) };
};
(async () => {
  const good = 'Here you go:\n{"summary":"Switch on the 24 V supply.","safety":["L1/N carry 230 V"],"steps":[{"text":"Rocker switch on","x":0.25,"y":1.4},{"text":"No spot"},{"text":""}],"confidence":"high","needs_supervisor":false}';
  let out = await handleAsk({ question: 'How do I turn it on?', image: 'AAAA', lang: 'en', cleared: true, station: { id: 'SML-0258', name: 'MT AC transfer line' }, knowledge: [{ title: 'Guide', body: 'Step one' }] }, { apiKey: 'k', fetchImpl: fake(good) });
  assert.equal(out.status, 200); assert.equal(out.answer.steps.length, 2);
  assert.equal(out.answer.steps[0].y, 1); assert.equal(out.answer.steps[1].x, undefined);
  assert.equal(out.answer.needs_supervisor, false); assert.equal(fake.headers['x-api-key'], 'k');
  assert.equal(fake.last.messages[0].content[0].type, 'image'); assert.ok(fake.last.messages[0].content[1].text.includes('VERIFIED KNOWLEDGE'));
  out = await handleAsk({ question: 'How?', cleared: false }, { apiKey: 'k', fetchImpl: fake(good) });
  assert.equal(out.answer.needs_supervisor, true, 'not cleared must force supervisor');
  assert.equal(fake.last.messages[0].content.length, 1, 'no image block without a photo');
  out = await handleAsk({ question: 'How?', cleared: true }, { apiKey: 'k', fetchImpl: fake('not json at all') });
  assert.equal(out.answer.confidence, 'low');
  out = await handleAsk({ question: '  ' }, { apiKey: 'k', fetchImpl: fake(good) }); assert.equal(out.status, 400);
  out = await handleAsk({ question: 'q', image: 'A'.repeat(4_000_000) }, { apiKey: 'k', fetchImpl: fake(good) }); assert.equal(out.status, 413);
  out = await handleAsk({ question: 'q' }, { apiKey: 'k', fetchImpl: async () => ({ ok: false, json: async () => ({ error: { message: 'bad key' } }) }) }); assert.equal(out.status, 502);
  assert.equal(buildRequest({ question: 'q', lang: 'ar' }).messages[0].content[0].text.split('\n')[0], 'LANG: ar');
  const hr = buildRequest({ question: 'and then?', image: 'BBBB', history: [
    { role: 'assistant', content: 'orphan' }, { role: 'user', content: 'How do I start it?' },
    { role: 'assistant', content: '{"summary":"Switch on the rack"}' }, { role: 'user', content: 'dangling' } ] });
  assert.deepEqual(hr.messages.map(m => m.role), ['user', 'assistant', 'user'], 'history alternates and ends before the new question');
  assert.equal(hr.messages[2].content[0].type, 'image');
  assert.ok(hr.messages[2].content[1].text.includes('QUESTION: and then?'));
  // a reply cut off by max_tokens is repaired, keeping the steps that arrived
  const cut = '{"summary":"هذه محطة FESTO","safety":["افصل الكهرباء"],"steps":[{"text":"شغّل القاطع","x":0.09,"y":0.4},{"text":"اطلب من المشرف مراجعة أسلاك التوصيل الحمراء والزرقاء بين القاطع وال';
  out = await handleAsk({ question: 'q', cleared: true }, { apiKey: 'k', fetchImpl: fake(cut) });
  assert.equal(out.answer.summary, 'هذه محطة FESTO'); assert.equal(out.answer.steps[0].x, 0.09); assert.equal(out.answer.steps.length, 2);
  // the director is never sent to a supervisor, even if the client says not cleared
  const sup = '{"summary":"s","steps":[{"text":"a"}],"confidence":"medium","needs_supervisor":true}';
  out = await handleAsk({ question: 'q', cleared: false, role: 'director' }, { apiKey: 'k', fetchImpl: fake(sup) });
  assert.equal(out.answer.needs_supervisor, false);
  assert.ok(fake.last.messages[0].content[0].text.includes('ROLE: director') && fake.last.messages[0].content[0].text.includes('CLEARED: true'));
  out = await handleAsk({ question: 'q', cleared: false }, { apiKey: 'k', fetchImpl: fake(sup) });
  assert.ok(fake.last.messages[0].content[0].text.includes('ROLE: member'));
  assert.equal(fake.last.max_tokens, 4096);
  console.log('relay logic: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
