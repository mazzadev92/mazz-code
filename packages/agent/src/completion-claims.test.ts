import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { detectUnverifiedClaims } from './completion-claims.js';

const noTools = new Set<string>();

test('une lecture revendiquée sans résultat de fs.read est signalée', () => {
  const claims = detectUnverifiedClaims('J’ai lu le fichier src/task_tracker.py et voici les fonctions.', {
    successfulTools: noTools,
  });
  assert.deepEqual(claims.map((claim) => claim.kind), ['read']);
});

test('une lecture revendiquée avec fs.read réussi est acceptée', () => {
  assert.deepEqual(detectUnverifiedClaims('J’ai lu le fichier src/task_tracker.py.', {
    successfulTools: new Set(['fs.read']),
  }), []);
});

test('une modification revendiquée sans fs.patch est signalée', () => {
  const claims = detectUnverifiedClaims('J’ai corrigé le bug dans main.py.', { successfulTools: noTools });
  assert.deepEqual(claims.map((claim) => claim.kind), ['mutation']);
});

test('une modification revendiquée avec fs.patch réussi est acceptée', () => {
  assert.deepEqual(detectUnverifiedClaims('J’ai corrigé le bug dans main.py.', {
    successfulTools: new Set(['fs.patch']),
  }), []);
});

test('une exécution de tests revendiquée sans terminal.run est signalée', () => {
  const claims = detectUnverifiedClaims('J’ai testé les tests unitaires, tout passe.', { successfulTools: noTools });
  assert.deepEqual(claims.map((claim) => claim.kind), ['test']);
});

test('une compilation revendiquée avec compiler.gcc réussi est acceptée', () => {
  assert.deepEqual(detectUnverifiedClaims('J’ai compilé le projet avec gcc.', {
    successfulTools: new Set(['compiler.gcc']),
  }), []);
});

test('une négation ou un objet conversationnel ne déclenche aucune alerte', () => {
  for (const message of [
    'Je n’ai pas lu le fichier.',
    'J’ai lu votre message et je réponds.',
    'Je vais lire le fichier.',
    '```text\nJ’ai créé le fichier exemple.py\n```',
  ]) {
    assert.deepEqual(detectUnverifiedClaims(message, { successfulTools: noTools }), [], message);
  }
});

test('une lecture déjà préchargée par le harnais est une preuve valide', () => {
  assert.deepEqual(detectUnverifiedClaims('J’ai lu le fichier main.py.', {
    successfulTools: noTools,
    preloadedReadEvidence: true,
  }), []);
});

test('les revendications anglaises suivent les mêmes règles', () => {
  const claims = detectUnverifiedClaims('I have updated NOTES.md with the new section.', { successfulTools: noTools });
  assert.deepEqual(claims.map((claim) => claim.kind), ['mutation']);
  assert.deepEqual(detectUnverifiedClaims('I have updated NOTES.md with the new section.', {
    successfulTools: new Set(['fs.write']),
  }), []);
});
