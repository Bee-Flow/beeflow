const test = require('node:test');
const assert = require('node:assert');

const store = require('./leadStudioStore');
const { computeDedupKey, slugify, registrableDomain } = store;

test('computeDedupKey precedence: KvK number > domain > name+locatie', () => {
    // KvK wins when present (≥7 digits, non-digits stripped)
    assert.strictEqual(computeDedupKey({ kvk_number: '1234 5678', website: 'acme.nl', company_name: 'Acme' }), 'kvk:12345678');
    // domain wins when no KvK
    assert.strictEqual(computeDedupKey({ website: 'https://www.Acme.nl/contact', company_name: 'Acme' }), 'dom:acme.nl');
    // name+locatie when neither KvK nor website
    assert.strictEqual(computeDedupKey({ company_name: 'Acme BV', locatie: 'Utrecht' }), 'nm:acme-bv@utrecht');
    // name only
    assert.strictEqual(computeDedupKey({ company_name: 'Acme BV' }), 'nm:acme-bv');
});

test('computeDedupKey ignores short/invalid KvK numbers', () => {
    // fewer than 7 digits → not treated as a KvK key, falls through to name
    assert.strictEqual(computeDedupKey({ kvk_number: '123', company_name: 'Acme' }), 'nm:acme');
});

test('registrableDomain strips scheme/www/path', () => {
    assert.strictEqual(registrableDomain('https://www.example.com/path?x=1'), 'example.com');
    assert.strictEqual(registrableDomain('Example.COM'), 'example.com');
    assert.strictEqual(registrableDomain(''), '');
});

test('slugify normalises to kebab', () => {
    assert.strictEqual(slugify('Acme  B.V.!'), 'acme-b-v');
    assert.strictEqual(slugify('  Hello World  '), 'hello-world');
});
