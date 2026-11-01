import type { ToolDefinition } from '@mazz/shared';

/**
 * Specialist sub-agents. The main loop stays the single orchestrator; a
 * specialist runs a nested loop on a sub-task with a restricted tool set and a
 * small step budget, then returns only its summary (its intermediate text does
 * not enter the parent context, which keeps small local models focused).
 */

export type SpecialistRole = 'explorer' | 'reviewer' | 'tester';

export interface Specialist {
  label: string;
  tools: string[];
  instructions: string;
  maxIterations: number;
}

export const SPECIALISTS: Record<SpecialistRole, Specialist> = {
  explorer: {
    label: 'Explorateur',
    tools: ['code.map', 'code.search', 'code.outline', 'fs.list', 'fs.read'],
    instructions: 'Spécialiste exploration, lecture seule : trouve les fichiers et symboles utiles à la question, puis réponds par une synthèse courte avec chemins et lignes.',
    maxIterations: 6,
  },
  reviewer: {
    label: 'Relecteur',
    tools: ['code.search', 'code.outline', 'fs.read', 'git.status'],
    instructions: 'Spécialiste revue de code, lecture seule : signale défauts, risques et corrections précises avec chemins et lignes. Pas de reformulation de la demande.',
    maxIterations: 6,
  },
  tester: {
    label: 'Testeur',
    tools: ['fs.list', 'fs.read', 'code.search', 'terminal.run', 'compiler.gcc'],
    instructions: 'Spécialiste tests : compile et exécute ce qui est demandé, puis rapporte les commandes, codes retour et erreurs exacts. Tu ne modifies pas les fichiers.',
    maxIterations: 6,
  },
};

/** Built-in: task list of the run, shown to the user (equivalent of a todo list). */
export const PLAN_DEFINITION: ToolDefinition = {
  name: 'plan.update',
  description: 'Crée le plan visible d’une tâche en plusieurs étapes. Au premier appel, fournis objective, constraints et acceptanceCriteria, puis la liste complète des étapes avec id, content, dependencies et status. MAZZ enregistre les résultats réels et avance les statuts après validation des outils ; ne rappelle pas cet outil uniquement pour changer un statut.',
  category: 'analysis',
  parameters: {
    type: 'object',
    properties: {
      objective: { type: 'string', description: 'Objectif stable du plan; requis au premier appel.' },
      constraints: { type: 'array', description: 'Contraintes à conserver durant le plan; requis au premier appel.', items: { type: 'string' } },
      acceptanceCriteria: { type: 'array', description: 'Résultats observables; au moins un requis au premier appel.', items: { type: 'string' } },
      items: {
        type: 'array', description: 'Liste complète des étapes et de leurs dépendances.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Identifiant stable, unique dans le plan; accepte une chaîne numérique comme 1 ou un préfixe comme s1.' },
            content: { type: 'string', description: 'Action vérifiable de cette étape.' },
            dependencies: { type: 'array', items: { type: 'string' }, description: 'Identifiants des étapes préalables.' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['id', 'content', 'dependencies', 'status'],
        },
      },
    },
    required: ['items'],
  },
  requiresPermission: false,
};

/** Built-in: multiple-choice question to the user when a decision is really theirs. */
export const ASK_DEFINITION: ToolDefinition = {
  name: 'user.ask',
  description: 'Pose une question seulement si une information ou un vrai choix manque. Une mutation explicite passe par l’outil fichier et son autorisation UI.',
  category: 'analysis',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string' },
      options: { type: 'array', items: { type: 'string' }, description: '2 à 4 réponses possibles' },
    },
    required: ['question', 'options'],
  },
  requiresPermission: false,
};

/** agent.delegate, listing the built-in specialists and the user's own agents (.mazz/agents, .claude/agents). */
export function delegateDefinition(custom: Record<string, { description?: string }> = {}): ToolDefinition {
  const extra = Object.entries(custom).map(([k, v]) => `${k} : ${(v.description ?? '').slice(0, 80)}`);
  return {
    ...DELEGATE_DEFINITION,
    description: extra.length ? `${DELEGATE_DEFINITION.description} Agents du projet : ${extra.join(' ; ')}.` : DELEGATE_DEFINITION.description,
    parameters: {
      ...DELEGATE_DEFINITION.parameters,
      properties: {
        ...DELEGATE_DEFINITION.parameters.properties,
        role: { type: 'string', enum: [...Object.keys(SPECIALISTS), ...Object.keys(custom)], description: 'Spécialiste' },
      },
    },
  };
}

export const DELEGATE_DEFINITION: ToolDefinition = {
  name: 'agent.delegate',
  description: 'Confie une sous-tâche à un agent spécialiste (explorer : trouver dans le code ; reviewer : relire ; tester : compiler et exécuter) et reçoit sa synthèse.',
  category: 'analysis',
  parameters: {
    type: 'object',
    properties: {
      role: { type: 'string', enum: ['explorer', 'reviewer', 'tester'], description: 'Spécialiste' },
      task: { type: 'string', description: 'Sous-tâche précise' },
    },
    required: ['role', 'task'],
  },
  // Write-capable tools inside the specialist keep their own permission checks.
  requiresPermission: false,
};
