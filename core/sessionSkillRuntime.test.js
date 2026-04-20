/**
 * Unit tests for sessionSkillRuntime pure functions.
 *
 * Run: node core/sessionSkillRuntime.test.js
 *
 * No DB needed — we stub out the DB-touching skillStore import so the test
 * file stays self-contained and fast.
 */

const assert = require('assert');
const path = require('path');

// Stub the skillStore module before requiring sessionSkillRuntime so the
// runtime's `require('../stores/skillStore')` returns our stub instead of
// reaching for PostgreSQL.
const skillStorePath = require.resolve('../stores/skillStore');
require.cache[skillStorePath] = {
    id: skillStorePath,
    filename: skillStorePath,
    loaded: true,
    exports: {
        createSkill: async () => { throw new Error('skillStore.createSkill not stubbed for this test'); },
        getSkillsByIds: async () => [],
    },
};

const {
    bootstrapSessionSkills, // exercised via parseSkillPayload-style adapter mock
    buildSessionSkillInjection,
    executeActivateSessionSkill,
    initialActivatedSkillIds,
    deriveCompletedSkillIds,
} = require('./sessionSkillRuntime');

// parseSkillPayload + normalizeSessionSkill aren't exported. Test them via
// the public surface that uses them — bootstrapSessionSkills with a mock adapter.
async function bootstrapWith(adapterContent) {
    const adapter = { chat: async () => ({ content: adapterContent }) };
    return bootstrapSessionSkills({
        adapter,
        apiKey: 'k',
        apiUrl: 'http://test',
        modelId: 'test-model',
        message: 'help me write blog posts',
        timezone: 'UTC',
    });
}

(async () => {
    // ── parseSkillPayload via bootstrap: happy path ─────────────────
    {
        const json = JSON.stringify([
            { name: 'A', description: 'a', instructions: 'do A', dynamicActivation: true },
            { name: 'B', description: 'b', instructions: 'do B' },
        ]);
        const skills = await bootstrapWith(json);
        assert.strictEqual(skills.length, 2, 'happy path returns 2 skills');
        assert.strictEqual(skills[0].name, 'A');
        assert.strictEqual(skills[0].dynamicActivation, true);
        assert.strictEqual(skills[1].dynamicActivation, true, 'dynamicActivation defaults to true');
        assert.ok(skills[0].id.startsWith('sess_'), 'id is auto-generated with sess_ prefix');
    }

    // ── parseSkillPayload: fenced JSON ──────────────────────────────
    {
        const fenced = '```json\n[{"name":"X","description":"x","instructions":"i"}]\n```';
        const skills = await bootstrapWith(fenced);
        assert.strictEqual(skills.length, 1, 'fenced JSON is parsed');
        assert.strictEqual(skills[0].name, 'X');
    }

    // ── parseSkillPayload: malformed JSON falls back to safe default ─
    {
        const skills = await bootstrapWith('not valid json at all');
        assert.strictEqual(skills.length, 1, 'malformed JSON falls back to one safe skill');
        assert.strictEqual(skills[0].name, 'Task Execution');
        assert.strictEqual(skills[0].dynamicActivation, true);
    }

    // ── parseSkillPayload: array > MAX_SESSION_SKILLS gets capped ───
    {
        const arr = Array.from({ length: 9 }, (_, i) => ({ name: `S${i}`, description: '', instructions: '' }));
        const skills = await bootstrapWith(JSON.stringify(arr));
        assert.strictEqual(skills.length, 5, 'capped at MAX_SESSION_SKILLS (5)');
    }

    // ── parseSkillPayload: { skills: [...] } wrapper shape ──────────
    {
        const wrapped = JSON.stringify({ skills: [{ name: 'W', instructions: 'w' }] });
        const skills = await bootstrapWith(wrapped);
        assert.strictEqual(skills.length, 1, '{skills:[...]} wrapper is unwrapped');
        assert.strictEqual(skills[0].name, 'W');
    }

    // ── normalizeSessionSkill: defaults for missing fields ──────────
    {
        const skills = await bootstrapWith(JSON.stringify([{ name: 'Bare' }]));
        assert.strictEqual(skills[0].description, '', 'missing description → empty string');
        assert.strictEqual(skills[0].instructions, '');
        assert.strictEqual(skills[0].workflow, '');
        assert.strictEqual(skills[0].rules, '');
        assert.strictEqual(skills[0].examples, '');
        assert.strictEqual(skills[0].dynamicActivation, true);
    }

    // ── buildSessionSkillInjection: empty list ──────────────────────
    {
        const out = buildSessionSkillInjection({ sessionSkills: [], activatedSkillIds: [] });
        assert.strictEqual(out.systemPromptAddendum, '', 'empty list → no addendum');
        assert.deepStrictEqual(out.tools, [], 'empty list → no tools');
    }

    // ── buildSessionSkillInjection: all-inactive uses manifest only ─
    {
        const ss = [
            { id: 'a', name: 'A', description: 'da' },
            { id: 'b', name: 'B', description: 'db' },
        ];
        const out = buildSessionSkillInjection({ sessionSkills: ss, activatedSkillIds: [] });
        assert.match(out.systemPromptAddendum, /AVAILABLE ON DEMAND/);
        assert.ok(!/ACTIVE CHAT-LOCAL SKILLS/.test(out.systemPromptAddendum), 'no active section when all inactive');
        const toolNames = out.tools.map(t => t.function.name);
        assert.ok(toolNames.includes('activate_session_skill'));
        assert.ok(toolNames.includes('publish_session_skill_to_library'));
    }

    // ── buildSessionSkillInjection: mixed active + inactive ─────────
    // `a` is non-terminal (has downstream `b`) and `b` is not active, so `a`
    // stays "in focus" (active body injected) rather than being marked done.
    {
        const ss = [
            { id: 'a', name: 'A', description: 'da', instructions: 'inst-a', order: 1, dependsOn: [] },
            { id: 'b', name: 'B', description: 'db', order: 2, dependsOn: ['a'] },
        ];
        const out = buildSessionSkillInjection({ sessionSkills: ss, activatedSkillIds: ['a'] });
        assert.match(out.systemPromptAddendum, /ACTIVE CHAT-LOCAL SKILLS/);
        assert.match(out.systemPromptAddendum, /AVAILABLE ON DEMAND/);
        assert.match(out.systemPromptAddendum, /inst-a/);
    }

    // ── executeActivateSessionSkill: happy path returns activatedSkillIds ─
    {
        const ss = [{ id: 'x', name: 'X', description: 'dx', instructions: 'go' }];
        const out = await executeActivateSessionSkill({
            args: { skill_ids: ['x'] },
            sessionSkills: ss,
            activatedSkillIds: [],
        });
        assert.strictEqual(out.success, true);
        assert.deepStrictEqual(out.activatedSkillIds, ['x']);
        assert.match(out.content, /Loaded 1 session skill/);
    }

    // ── executeActivateSessionSkill: unknown id ─────────────────────
    {
        const out = await executeActivateSessionSkill({
            args: { skill_ids: ['nope'] },
            sessionSkills: [{ id: 'x', name: 'X' }],
            activatedSkillIds: [],
        });
        assert.ok(out.error, 'unknown id returns error');
    }

    // ── executeActivateSessionSkill: empty input ────────────────────
    {
        const out = await executeActivateSessionSkill({
            args: { skill_ids: [] },
            sessionSkills: [{ id: 'x' }],
        });
        assert.ok(out.error, 'empty input returns error');
    }

    // ── dependencies: unmet dep rejects activation ──────────────────
    {
        const ss = [
            { id: 'a', name: 'Research', order: 1, dependsOn: [] },
            { id: 'b', name: 'Write',    order: 2, dependsOn: ['a'] },
        ];
        const out = await executeActivateSessionSkill({
            args: { skill_ids: ['b'] },
            sessionSkills: ss,
            activatedSkillIds: [],
        });
        assert.ok(out.error, 'activating step 2 without step 1 returns error');
        assert.match(out.error, /Research/, 'error cites the missing dep name');
    }

    // ── dependencies: batch activation of valid prefix chain ────────
    {
        const ss = [
            { id: 'a', name: 'A', order: 1, dependsOn: [] },
            { id: 'b', name: 'B', order: 2, dependsOn: ['a'] },
        ];
        const out = await executeActivateSessionSkill({
            args: { skill_ids: ['a', 'b'] },
            sessionSkills: ss,
            activatedSkillIds: [],
        });
        assert.strictEqual(out.success, true, 'batch activates prefix chain');
        assert.deepStrictEqual(out.activatedSkillIds.sort(), ['a', 'b']);
    }

    // ── dependencies: reactivating already-active skill is a no-op ──
    {
        const ss = [{ id: 'a', name: 'A', order: 1, dependsOn: [] }];
        const out = await executeActivateSessionSkill({
            args: { skill_ids: ['a'] },
            sessionSkills: ss,
            activatedSkillIds: ['a'],
        });
        assert.strictEqual(out.success, true, 'already-active is not an error');
    }

    // ── resolveDependencies (via parseSkillPayload): names -> ids ───
    {
        const json = JSON.stringify([
            { name: 'Research',   order: 1, dependsOn: [] },
            { name: 'LinkedIn',   order: 2, dependsOn: ['Research'] },
        ]);
        const skills = await bootstrapWith(json);
        assert.strictEqual(skills.length, 2);
        const research = skills.find(s => s.name === 'Research');
        const linkedin = skills.find(s => s.name === 'LinkedIn');
        assert.deepStrictEqual(linkedin.dependsOn, [research.id], 'name resolved to canonical id');
    }

    // ── manifest shows READY vs BLOCKED ─────────────────────────────
    {
        const ss = [
            { id: 'a', name: 'A', order: 1, dependsOn: [] },
            { id: 'b', name: 'B', order: 2, dependsOn: ['a'] },
        ];
        const out = buildSessionSkillInjection({ sessionSkills: ss, activatedSkillIds: [] });
        assert.match(out.systemPromptAddendum, /READY/, 'step 1 shows READY');
        assert.match(out.systemPromptAddendum, /BLOCKED by: A/, 'step 2 shows BLOCKED by A');
    }

    // ── initialActivatedSkillIds: picks step-1 nodes with no deps ───
    {
        const ss = [
            { id: 'a', name: 'A', order: 1, dependsOn: [] },
            { id: 'b', name: 'B', order: 1, dependsOn: [] }, // parallel step-1
            { id: 'c', name: 'C', order: 2, dependsOn: ['a'] },
        ];
        const ids = initialActivatedSkillIds(ss);
        assert.deepStrictEqual(ids.sort(), ['a', 'b'], 'both step-1 skills are auto-activated');
    }

    // ── deriveCompletedSkillIds: terminal active → done ─────────────
    {
        const ss = [
            { id: 'a', name: 'A', order: 1, dependsOn: [] },
            { id: 'b', name: 'B', order: 2, dependsOn: ['a'] },
        ];
        // Only step 1 active: 'a' has an inactive downstream → not yet completed.
        let done = deriveCompletedSkillIds(ss, ['a']);
        assert.deepStrictEqual(done, [], 'step 1 alone is not completed');
        // Both active: 'a' completed (downstream 'b' active), 'b' terminal so also completed.
        done = deriveCompletedSkillIds(ss, ['a', 'b']);
        assert.deepStrictEqual(done.sort(), ['a', 'b'], 'full pipeline all completed');
    }

    // ── buildSessionSkillInjection: completed skills trailer ────────
    {
        const ss = [
            { id: 'a', name: 'A', order: 1, dependsOn: [], instructions: 'body-a' },
            { id: 'b', name: 'B', order: 2, dependsOn: ['a'], instructions: 'body-b' },
        ];
        const out = buildSessionSkillInjection({ sessionSkills: ss, activatedSkillIds: ['a', 'b'] });
        assert.match(out.systemPromptAddendum, /COMPLETED STEPS/, 'completed trailer renders');
        // Bodies of completed skills must NOT be re-injected.
        assert.ok(!/body-a/.test(out.systemPromptAddendum), 'completed skill body is elided');
        assert.ok(!/body-b/.test(out.systemPromptAddendum), 'completed skill body is elided');
    }

    // ── buildSessionSkillInjection: compactMode elides active bodies ─
    {
        const ss = [
            { id: 'a', name: 'A', order: 1, dependsOn: [], instructions: 'body-a' },
            { id: 'b', name: 'B', order: 2, dependsOn: ['a'], instructions: 'body-b' },
        ];
        // With only 'a' active (still in focus), non-compact mode DOES inject body.
        let out = buildSessionSkillInjection({ sessionSkills: ss, activatedSkillIds: ['a'] });
        assert.match(out.systemPromptAddendum, /body-a/, 'non-compact inlines active body');
        // compactMode should elide the body.
        out = buildSessionSkillInjection({ sessionSkills: ss, activatedSkillIds: ['a'], compactMode: true });
        assert.ok(!/body-a/.test(out.systemPromptAddendum), 'compactMode elides active body');
        assert.match(out.systemPromptAddendum, /bodies elided after compaction/);
    }

    // ── cycle detection: circular deps are broken ───────────────────
    {
        // Patch console.warn so the expected warning doesn't muddy test output.
        const originalWarn = console.warn;
        console.warn = () => {};
        const json = JSON.stringify([
            { name: 'A', order: 1, dependsOn: ['B'] },
            { name: 'B', order: 2, dependsOn: ['A'] },
        ]);
        const skills = await bootstrapWith(json);
        console.warn = originalWarn;
        assert.strictEqual(skills.length, 2, 'both skills survive cycle break');
        // After cycle break, at least one skill must have empty deps so the
        // pipeline can schedule.
        const anyRoot = skills.some(s => (s.dependsOn || []).length === 0);
        assert.ok(anyRoot, 'cycle broken — at least one root remains');
    }

    console.log('[sessionSkillRuntime.test] all assertions passed ✓');
})().catch(err => {
    console.error('[sessionSkillRuntime.test] FAILED:', err);
    process.exit(1);
});
