import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { advertisedOperations, compareRuntimeToolNames, requireAdvertisedOperation } from './knowledge-engines.js';
test('runtime MCP catalog maps dotted operations without corrupting internal underscores', () => {
    const report = compareRuntimeToolNames(['engine.health', 'aengenium.audit_16_pillars', 'knowledge.search'], [{ name: 'engine_health' }, { name: 'aengenium_audit_16_pillars' }, { name: 'knowledge_search' }]);
    assert.equal(report.exactMatch, true);
    assert.deepEqual(report.missingFromRuntime, []);
    assert.deepEqual(report.undeclaredAtRuntime, []);
    assert.equal(report.declaredOperationCount, 3);
    assert.deepEqual(report.advertisedOperations, ['engine.health', 'aengenium.audit_16_pillars', 'knowledge.search']);
});
test('runtime MCP catalog reports missing, undeclared and duplicate tools instead of hiding drift', () => {
    const report = compareRuntimeToolNames(['engine.health', 'math.calculate'], [{ name: 'engine_health' }, { name: 'engine_health' }, { name: 'unexpected_tool' }]);
    assert.equal(report.exactMatch, false);
    assert.deepEqual(report.missingFromRuntime, ['math_calculate']);
    assert.deepEqual(report.undeclaredAtRuntime, ['unexpected_tool']);
    assert.deepEqual(report.duplicateRuntimeNames, ['engine_health']);
});
test('duplicate declarations in the Studio catalog are reported as drift', () => {
    const report = compareRuntimeToolNames(['engine.health', 'engine.health'], [{ name: 'engine_health' }]);
    assert.equal(report.exactMatch, false);
    assert.deepEqual(report.duplicateDeclaredNames, ['engine_health']);
    assert.deepEqual(report.advertisedOperations, []);
});
test('only uniquely advertised names are exposed for the next model request', () => {
    const declared = ['engine.health', 'math.calculate', 'knowledge.search'];
    const actual = ['engine_health', 'knowledge_search', 'untracked_tool'];
    assert.deepEqual(advertisedOperations(declared, actual), ['engine.health', 'knowledge.search']);
    assert.deepEqual(advertisedOperations(declared, ['engine_health', 'engine_health', 'knowledge_search']), ['knowledge.search']);
});
test('dispatch authorization refuses a declared operation absent from runtime listTools', () => {
    const declared = ['engine.health', 'math.calculate', 'aengenium.audit_16_pillars', 'knowledge.search'];
    assert.equal(requireAdvertisedOperation('aengenium.audit_16_pillars', declared, ['aengenium_audit_16_pillars']), 'aengenium_audit_16_pillars');
    assert.equal(requireAdvertisedOperation('knowledge.search', declared, ['knowledge_search']), 'knowledge_search');
    assert.throws(() => requireAdvertisedOperation('math.calculate', declared, ['engine_health']), /n’annonce pas « math_calculate »/);
    assert.throws(() => requireAdvertisedOperation('not.declared', declared, ['not_declared']), /Opération Bib1 inconnue/);
});
test('ambiguous dotted-to-wire mappings cannot be authorized even if the wire name exists', () => {
    const collision = ['a.b_c', 'a_b.c'];
    assert.deepEqual(advertisedOperations(collision, ['a_b_c']), []);
    assert.throws(() => requireAdvertisedOperation('a.b_c', collision, ['a_b_c']), /Opération Bib1 ambiguë/);
});
