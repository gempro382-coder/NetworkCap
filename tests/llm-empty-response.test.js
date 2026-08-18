'use strict';

/**
 * Regression tests for "the AI does not respond" on simple questions
 * (e.g. "Can you tell me what is Python?").
 *
 * Root cause: Tier 1 routes to openai/gpt-oss-20b, a REASONING model. Groq
 * bills hidden reasoning against the same completion budget, so with the old
 * 256-token cap the model spent everything thinking, the stream ended with
 * finish_reason="length" and content EMPTY. groqChat returned { text: '' },
 * the router treated it as success (no failover), and the UI drew an empty
 * bubble labelled "Complete".
 *
 *   node tests/llm-empty-response.test.js
 */

const assert = require('assert');
const Module = require('module');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { config } = require(path.join(ROOT, 'src/core/config-store'));

// Pretend a Groq key is configured, without touching the user's config file.
const realGet = config.get.bind(config);
config.get = (key) => (key === 'groqApiKey' ? 'test-key' : (key === 'resume' ? '' : realGet(key)));

const groq = require(path.join(ROOT, 'src/services/groq-llm.service'));
const { classifyFast, parseTierLabel } = require(path.join(ROOT, 'src/services/llm-router.service'));

let passed = 0;
const check = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`); };

// ---------------------------------------------------------------------------
// fetch stub — returns a scripted SSE stream or JSON body
// ---------------------------------------------------------------------------
const calls = [];
function sse(lines) {
  return {
    ok: true,
    body: (async function* () {
      for (const line of lines) yield Buffer.from(line);
    })(),
    json: async () => ({})
  };
}
function jsonBody(payload) {
  return { ok: true, body: null, json: async () => payload };
}
function stubFetch(handler) {
  calls.length = 0;
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return handler(body, calls.length);
  };
}
const chunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const delta = (d, finish = null) => chunk({ choices: [{ delta: d, finish_reason: finish }] });

(async () => {
  console.log('groq request shape');

  await check('reasoning models get headroom, hidden thinking and the modern token field', async () => {
    stubFetch(() => sse([delta({ content: 'ok' }), delta({}, 'stop'), 'data: [DONE]\n\n']));
    // Tier 1 used to ask for 256 — the floor must override it.
    await groq.groqChat({ model: 'openai/gpt-oss-20b', messages: [{ role: 'user', content: 'hi' }], maxTokens: 256 });
    const body = calls[0];
    assert.strictEqual(body.max_completion_tokens, 1024, 'reasoning budget floor not applied');
    assert.ok(!('max_tokens' in body), 'deprecated max_tokens still sent');
    assert.strictEqual(body.reasoning_effort, 'low');
    assert.strictEqual(body.include_reasoning, false);
    assert.ok(body.temperature >= 0.5, 'reasoning models need temp >= 0.5 per Groq docs');
  });

  await check('qwen uses reasoning_format (it does not support include_reasoning)', async () => {
    stubFetch(() => sse([delta({ content: 'ok' }), delta({}, 'stop')]));
    await groq.groqChat({ model: 'qwen/qwen3.6-27b', messages: [{ role: 'user', content: 'hi' }], maxTokens: 512 });
    assert.strictEqual(calls[0].reasoning_format, 'hidden');
    assert.ok(!('include_reasoning' in calls[0]), 'mutually exclusive field sent alongside reasoning_format');
  });

  await check('non-reasoning models keep the caller settings untouched', async () => {
    stubFetch(() => sse([delta({ content: 'ok' }), delta({}, 'stop')]));
    await groq.groqChat({ model: 'meta-llama/llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }], maxTokens: 300, temperature: 0.2 });
    assert.strictEqual(calls[0].max_completion_tokens, 300);
    assert.strictEqual(calls[0].temperature, 0.2);
    assert.ok(!('reasoning_effort' in calls[0]));
  });

  console.log('the actual bug');

  await check('reasoning-only stream (the bug) no longer returns silence', async () => {
    // Exactly what Groq sent for "Can you tell me what is Python?" at 256 tokens:
    // reasoning deltas only, then finish_reason=length, no content at all.
    let served = 0;
    stubFetch((body, n) => {
      served = n;
      if (n === 1) {
        return sse([
          delta({ reasoning: 'The user asks what Python is. I should explain...' }),
          delta({ reasoning: ' ...tersely, as a candidate would.' }),
          delta({}, 'length'),
          'data: [DONE]\n\n'
        ]);
      }
      // Rescue retry: non-streaming, bigger budget → real answer.
      return jsonBody({ choices: [{ finish_reason: 'stop', message: { content: '**Python is an interpreted, dynamically typed language.**' } }] });
    });

    const out = [];
    const res = await groq.groqChat({
      model: 'openai/gpt-oss-20b',
      messages: [{ role: 'user', content: 'Can you tell me what is Python?' }],
      maxTokens: 256,
      onChunk: (t) => out.push(t)
    });

    assert.strictEqual(served, 2, 'no rescue retry was attempted');
    assert.ok(res.text.includes('Python is an interpreted'), 'answer not recovered');
    assert.ok(res.recovered, 'recovery not flagged');
    assert.ok(out.join('').includes('Python is an interpreted'), 'recovered text never reached the UI');
    assert.strictEqual(calls[1].stream, false, 'retry should be non-streaming');
    assert.ok(calls[1].max_completion_tokens >= 2048, 'retry budget not raised');
  });

  await check('a truly empty completion throws so the router can fail over', async () => {
    stubFetch(() => sse([delta({ reasoning: 'thinking' }), delta({}, 'length')]));
    await assert.rejects(
      () => groq.groqChat({ model: 'openai/gpt-oss-20b', messages: [{ role: 'user', content: 'hi' }], maxTokens: 256 }),
      (err) => {
        assert.strictEqual(err.emptyCompletion, true, 'error is not tagged for failover');
        assert.ok(/finish_reason=length/.test(err.message), 'diagnostics missing from the error');
        return true;
      }
    );
  });

  await check('HTTP errors still carry .status for rate-limit failover', async () => {
    global.fetch = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
    await assert.rejects(
      () => groq.groqChat({ model: 'openai/gpt-oss-20b', messages: [{ role: 'user', content: 'hi' }] }),
      (err) => err.status === 429
    );
  });

  console.log('stream hygiene');

  await check('harmony control tokens split across chunks are stripped', async () => {
    stubFetch(() => sse([
      delta({ content: '<|start|>assistant<|chan' }),
      delta({ content: 'nel|>final<|message|>**Python** is a language.' }),
      delta({ content: '<|ret' }),
      delta({ content: 'urn|>' }),
      delta({}, 'stop')
    ]));
    const res = await groq.groqChat({ model: 'openai/gpt-oss-20b', messages: [{ role: 'user', content: 'hi' }] });
    assert.ok(!/<\|/.test(res.text), `control tokens leaked: ${JSON.stringify(res.text)}`);
    assert.ok(res.text.includes('**Python** is a language.'));
  });

  await check('<think> blocks never reach the user', async () => {
    stubFetch(() => sse([
      delta({ content: '<think>internal notes' }),
      delta({ content: ' more notes</think>Visible answer.' }),
      delta({}, 'stop')
    ]));
    const res = await groq.groqChat({ model: 'qwen/qwen3.6-27b', messages: [{ role: 'user', content: 'hi' }] });
    assert.strictEqual(res.text.trim(), 'Visible answer.');
  });

  await check('normal streaming still streams incrementally', async () => {
    stubFetch(() => sse([delta({ content: 'Hello' }), delta({ content: ' world' }), delta({}, 'stop')]));
    const seen = [];
    const res = await groq.groqChat({
      model: 'openai/gpt-oss-120b',
      messages: [{ role: 'user', content: 'hi' }],
      onChunk: (t) => seen.push(t)
    });
    assert.deepStrictEqual(seen, ['Hello', ' world']);
    assert.strictEqual(res.text, 'Hello world');
    assert.strictEqual(res.finishReason, 'stop');
  });

  await check('multiple SSE events arriving in one TCP chunk are all parsed', async () => {
    stubFetch(() => sse([delta({ content: 'a' }) + delta({ content: 'b' }) + delta({ content: 'c' }), delta({}, 'stop')]));
    const res = await groq.groqChat({ model: 'openai/gpt-oss-20b', messages: [{ role: 'user', content: 'hi' }] });
    assert.strictEqual(res.text, 'abc');
  });

  console.log('routing');

  await check('"Can you tell me what is Python?" routes to Tier 1', () => {
    const route = classifyFast('Can you tell me what is Python?');
    assert.strictEqual(route.tier, 1);
    assert.ok(route.confidence >= 0.8);
  });

  await check('classifier label survives a chatty reasoning reply', () => {
    assert.strictEqual(parseTierLabel('The question is a lookup, so: simple'), 'simple');
    assert.strictEqual(parseTierLabel('  HARD\n'), 'hard');
    assert.strictEqual(parseTierLabel('no idea'), '');
  });

  console.log('router failover');

  await check('an empty model reply fails over to the next model in the tier', async () => {
    // Stub the two providers BEFORE the router module is loaded fresh.
    const groqPath = require.resolve(path.join(ROOT, 'src/services/groq-llm.service'));
    const geminiPath = require.resolve(path.join(ROOT, 'src/services/gemini.service'));
    const routerPath = require.resolve(path.join(ROOT, 'src/services/llm-router.service'));
    const saved = { groq: require.cache[groqPath], gemini: require.cache[geminiPath], router: require.cache[routerPath] };

    const attempted = [];
    const fakeModule = (id, exports) => {
      const m = new Module(id, null);
      m.filename = id; m.loaded = true; m.exports = exports;
      require.cache[id] = m;
    };
    fakeModule(groqPath, {
      groqChat: async ({ model }) => {
        attempted.push(model);
        return { text: '', model }; // the pathological case
      },
      cancelActive: () => {}
    });
    fakeModule(geminiPath, {
      geminiService: {
        chat: async ({ model, onChunk }) => {
          attempted.push(model);
          onChunk('**Python is an interpreted language.**');
          return { text: '**Python is an interpreted language.**', model };
        },
        cancel: () => {}
      },
      ACCURACY_POLICY: 'x'
    });
    delete require.cache[routerPath];

    try {
      const { LlmRouter } = require(routerPath);
      const router = new LlmRouter();
      const out = [];
      const res = await router.dispatch({
        query: 'Can you tell me what is Python?',
        skill: 'interview',
        forceTier: 1,
        onChunk: (t) => out.push(t)
      });
      assert.deepStrictEqual(attempted, ['openai/gpt-oss-20b', 'gemini-3.1-flash-lite'], `failover chain wrong: ${attempted}`);
      assert.ok(res.text.includes('Python is an interpreted'), 'user got no answer');
      assert.ok(out.join('').length > 0, 'nothing streamed to the UI');
    } finally {
      for (const [p, m] of [[groqPath, saved.groq], [geminiPath, saved.gemini], [routerPath, saved.router]]) {
        if (m) require.cache[p] = m; else delete require.cache[p];
      }
    }
  });

  console.log(`\n${passed} checks passed.`);
  process.exit(0);
})().catch((err) => { console.error('\n✗ FAILED:', err && err.stack || err); process.exit(1); });
