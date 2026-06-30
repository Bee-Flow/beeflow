const test = require('node:test');
const assert = require('node:assert');

const driver = require('./securityScanDriver');
const { _safeWorkPath, _shq, _buildSeedMessage, WORK_DIR, TOOLS } = driver._internals;

test('_safeWorkPath keeps paths inside the scratch dir', () => {
    assert.strictEqual(_safeWorkPath('report.json'), `${WORK_DIR}/report.json`);
    assert.strictEqual(_safeWorkPath('sub/dir/x'), `${WORK_DIR}/sub/dir/x`);
    assert.strictEqual(_safeWorkPath(`${WORK_DIR}/a.txt`), `${WORK_DIR}/a.txt`);
});

test('_safeWorkPath rejects traversal / absolute escapes', () => {
    assert.strictEqual(_safeWorkPath('../../etc/passwd'), null);
    assert.strictEqual(_safeWorkPath('/etc/passwd'), null);
    assert.strictEqual(_safeWorkPath(`${WORK_DIR}/../secret`), null);
    assert.strictEqual(_safeWorkPath(''), null);
    assert.strictEqual(_safeWorkPath(null), null);
});

test('_shq single-quotes and escapes embedded quotes', () => {
    assert.strictEqual(_shq('abc'), `'abc'`);
    assert.strictEqual(_shq(`a'b`), `'a'\\''b'`);
});

test('seed message reflects aggression level + gates active scan', () => {
    const passive = _buildSeedMessage({ targetUrl: 'https://x.example', engines: [{ engine: 'zap' }], aggression: 'passive', activeAllowed: false });
    assert.match(passive, /PASSIVE/);
    assert.match(passive, /zap_active_scan is DISABLED/);
    assert.doesNotMatch(passive, /zap_active_scan IS available/);

    const offensive = _buildSeedMessage({ targetUrl: 'https://x.example', engines: [{ engine: 'zap' }], aggression: 'offensive', activeAllowed: true });
    assert.match(offensive, /OFFENSIVE/);
    assert.match(offensive, /zap_active_scan IS available/);
    assert.match(offensive, /sqlmap/);
});

test('TOOLS includes the new file + terminal tools', () => {
    const names = TOOLS.map((t) => t.name);
    for (const n of ['terminal_exec', 'file_write', 'file_read', 'zap_active_scan', 'done']) {
        assert.ok(names.includes(n), `missing tool ${n}`);
    }
    const term = TOOLS.find((t) => t.name === 'terminal_exec');
    assert.ok(term.input_schema.properties.timeoutMs, 'terminal_exec should accept timeoutMs');
});
