'use strict';

/**
 * Contract tests for the shared answer persona (src/shared/answer-style.js)
 * and the shortcut map (src/shared/constants.js).
 *
 *   node tests/answer-style.test.js
 */

const assert = require('assert');
const { SKILL_PROMPTS, ACCURACY_POLICY, COMPACT_POLICY, buildSystemPrompt } = require('../src/shared/answer-style');
const { SHORTCUTS, RENDERER_ONLY_SHORTCUTS, prettyAccel } = require('../src/shared/constants');

let passed = 0;
const check = (name, fn) => { fn(); passed += 1; console.log(`  ✓ ${name}`); };

console.log('answer-style');

check('every skill mode inherits the shared contract', () => {
  for (const [skill, prompt] of Object.entries(SKILL_PROMPTS)) {
    assert.ok(prompt.includes('Accuracy contract:'), `${skill} missing accuracy contract`);
    assert.ok(prompt.includes('Voice (applies to EVERY answer'), `${skill} missing voice contract`);
    assert.ok(prompt.includes('Shape (default'), `${skill} missing shape contract`);
  }
});

check('candidate voice + anti-generic rules are present', () => {
  assert.ok(/first person/i.test(ACCURACY_POLICY));
  assert.ok(/Great question/.test(ACCURACY_POLICY));      // banned opener
  assert.ok(/Hope this helps/.test(ACCURACY_POLICY));     // banned closer
  assert.ok(/bolded 1-4 word tag/.test(ACCURACY_POLICY)); // bullet shape
  assert.ok(/name, a number, or a mechanism|an exact name/i.test(ACCURACY_POLICY));
});

check('answers stay short by contract', () => {
  assert.ok(/40-110 words/.test(ACCURACY_POLICY));
  assert.ok(/Hard ceiling/.test(ACCURACY_POLICY));
});

check('buildSystemPrompt defaults to the general mode', () => {
  assert.strictEqual(buildSystemPrompt(), SKILL_PROMPTS.general);
  assert.strictEqual(buildSystemPrompt({ skill: 'nope' }), SKILL_PROMPTS.general);
});

check('buildSystemPrompt folds in the resume as ground truth', () => {
  const out = buildSystemPrompt({ skill: 'interview', resume: 'Aashish — Node.js, Electron, 3 yrs' });
  assert.ok(out.startsWith(SKILL_PROMPTS.interview));
  assert.ok(out.includes('Aashish — Node.js, Electron, 3 yrs'));
  assert.ok(/first person/i.test(out));
  assert.ok(/Never invent a role, employer, metric or year/.test(out));
});

check('buildSystemPrompt appends per-call deltas last', () => {
  const out = buildSystemPrompt({ skill: 'coding', extra: 'INSTANT MODE' });
  assert.ok(out.trim().endsWith('INSTANT MODE'));
});

check('compact contract keeps the persona at a fraction of the tokens', () => {
  const compact = buildSystemPrompt({ skill: 'interview', compact: true });
  assert.ok(compact.length < SKILL_PROMPTS.interview.length / 3, 'compact prompt is not compact');
  assert.ok(/senior candidate/.test(compact));
  assert.ok(/First person/.test(compact));
  assert.ok(/bold 1-4 word tag/.test(compact));
  assert.ok(/Great question/.test(compact));      // still bans filler
  assert.ok(/never invent/i.test(compact));       // still bans fabrication
  assert.ok(/Interview mode/.test(compact));      // skill delta survives
});

check('compact contract still carries the resume', () => {
  const out = buildSystemPrompt({ skill: 'interview', compact: true, resume: 'Kafka, Spring Boot, 4 yrs' });
  assert.ok(out.includes('Kafka, Spring Boot, 4 yrs'));
  assert.ok(out.includes(COMPACT_POLICY.slice(0, 40)));
});

console.log('shortcuts');

check('close-shortcuts hotkey exists and is unique', () => {
  assert.strictEqual(SHORTCUTS.closeShortcuts, 'CommandOrControl+Shift+/');
  assert.strictEqual(SHORTCUTS.closeShortcutsAlt, 'CommandOrControl+Shift+?');
  const values = Object.values(SHORTCUTS);
  assert.strictEqual(new Set(values).size, values.length, 'duplicate accelerator in SHORTCUTS');
});

check('show-shortcuts hotkey is still Ctrl+Shift+L', () => {
  assert.strictEqual(SHORTCUTS.showShortcuts, 'CommandOrControl+Shift+L');
});

check('accelerators pretty-print for the help panel', () => {
  assert.strictEqual(prettyAccel('CommandOrControl+Shift+V', 'win32'), 'Ctrl+Shift+V');
  assert.strictEqual(prettyAccel('CommandOrControl+Shift+V', 'darwin'), 'Cmd+Shift+V');
  assert.strictEqual(prettyAccel('CommandOrControl+Shift+Up', 'win32'), 'Ctrl+Shift+↑');
  assert.strictEqual(prettyAccel(SHORTCUTS.closeShortcuts, 'win32'), 'Ctrl+Shift+/');
});

check('renderer-only keys are documented too', () => {
  assert.ok(RENDERER_ONLY_SHORTCUTS.length >= 3);
  for (const row of RENDERER_ONLY_SHORTCUTS) {
    assert.ok(row.accel && row.label, 'renderer-only shortcut row is incomplete');
  }
});

console.log(`\n${passed} checks passed.`);
