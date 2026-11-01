/**
 * MAZZ ÆNGENIUM — Registre d'actions UI (Single-Owner Action Registry)
 * 
 * Règle d'or : Une action, un propriétaire, un nœud DOM.
 * Toute action rendue hors de ses hosts échoue au contrôle lint.
 * Les mirrors doivent être explicitement justifiés.
 */

export interface ActionDefinition {
  readonly id: string;
  readonly label: string;
  readonly owner: string;
  readonly hosts: readonly string[];
  readonly mirror: readonly string[];
  readonly justification?: string;
  readonly shortcut?: string;
  readonly isDestructive?: boolean;
}

export const ACTIONS = {
  // Session lifecycle
  'session.new': {
    id: 'session.new',
    label: 'Nouvelle session',
    owner: 'SidebarHeader',
    hosts: ['SidebarHeader', 'CommandPalette'],
    mirror: ['CommandPalette'],
    justification: 'Palette globale requiert accès direct sans focus barre latérale',
    shortcut: 'Ctrl+Maj+O',
  },
  'session.send': {
    id: 'session.send',
    label: 'Envoyer',
    owner: 'ComposerPrimaryButton',
    hosts: ['ComposerPrimaryButton'],
    mirror: [],
    shortcut: 'Entrée',
  },
  'session.stop': {
    id: 'session.stop',
    label: 'Arrêter',
    owner: 'ComposerPrimaryButton',
    hosts: ['ComposerPrimaryButton'],
    mirror: [],
    shortcut: 'Échap',
  },
  'session.queue': {
    id: 'session.queue',
    label: 'Mettre en file d’attente',
    owner: 'ComposerQueueButton',
    hosts: ['ComposerQueueButton'],
    mirror: [],
    shortcut: 'Maj+Entrée',
  },
  'session.compact': {
    id: 'session.compact',
    label: 'Compacter le contexte',
    owner: 'ContextBanner',
    hosts: ['ContextBanner', 'ComposerContextMenu', 'CommandPalette'],
    mirror: ['ComposerContextMenu', 'CommandPalette'],
    justification: 'Déclenchable en alerte contexte, dans les options ou via palette',
  },
  'session.rename': {
    id: 'session.rename',
    label: 'Renommer la session',
    owner: 'SessionItemMenu',
    hosts: ['SessionItemMenu', 'ConversationHeader'],
    mirror: ['ConversationHeader'],
    justification: 'Édition directe du titre dans l’en-tête de conversation',
  },
  'session.delete': {
    id: 'session.delete',
    label: 'Supprimer la session',
    owner: 'SessionItemMenu',
    hosts: ['SessionItemMenu'],
    mirror: [],
    isDestructive: true,
  },
  'session.export': {
    id: 'session.export',
    label: 'Exporter la session',
    owner: 'ConversationHeader',
    hosts: ['ConversationHeader', 'SessionItemMenu', 'CommandPalette'],
    mirror: ['SessionItemMenu', 'CommandPalette'],
    justification: 'Export multi-formats accessible depuis le menu session et la palette',
    shortcut: 'Ctrl+Maj+E',
  },

  // Message & Transcript
  'message.copy': {
    id: 'message.copy',
    label: 'Copier le message',
    owner: 'MessageActions',
    hosts: ['MessageActions', 'SelectionBar'],
    mirror: ['SelectionBar'],
    justification: 'Barre flottante de sélection texte',
  },
  'message.edit': {
    id: 'message.edit',
    label: 'Modifier et rejouer',
    owner: 'MessageActions',
    hosts: ['MessageActions'],
    mirror: [],
  },
  'message.regenerate': {
    id: 'message.regenerate',
    label: 'Régénérer la réponse',
    owner: 'AssistantActions',
    hosts: ['AssistantActions'],
    mirror: [],
  },
  'message.branch': {
    id: 'message.branch',
    label: 'Créer une branche',
    owner: 'AssistantActions',
    hosts: ['AssistantActions'],
    mirror: [],
  },

  // Reasoning block
  'reasoning.toggle': {
    id: 'reasoning.toggle',
    label: 'Basculer la réflexion',
    owner: 'ReasoningCard',
    hosts: ['ReasoningCard'],
    mirror: [],
  },

  // Approvals & Gates
  'approval.allow_once': {
    id: 'approval.allow_once',
    label: 'Autoriser une fois',
    owner: 'ApprovalCard',
    hosts: ['ApprovalCard'],
    mirror: [],
    shortcut: 'Entrée',
  },
  'approval.allow_always': {
    id: 'approval.allow_always',
    label: 'Toujours autoriser',
    owner: 'ApprovalCard',
    hosts: ['ApprovalCard'],
    mirror: [],
    shortcut: 'Maj+Entrée',
  },
  'approval.deny': {
    id: 'approval.deny',
    label: 'Refuser',
    owner: 'ApprovalCard',
    hosts: ['ApprovalCard'],
    mirror: [],
    shortcut: 'Échap',
    isDestructive: true,
  },

  // Plan Mode & Navigation
  'plan.toggle': {
    id: 'plan.toggle',
    label: 'Basculer le mode plan',
    owner: 'ModeSwitcher',
    hosts: ['ModeSwitcher', 'CommandPalette'],
    mirror: ['CommandPalette'],
    justification: 'Raccourci global de bascule vers le mode plan',
    shortcut: 'Ctrl+Maj+P',
  },
  'plan.execute': {
    id: 'plan.execute',
    label: 'Exécuter le plan',
    owner: 'PlanInspectorTab',
    hosts: ['PlanInspectorTab'],
    mirror: [],
  },

  // Restore points & Diffs
  'checkpoint.create': {
    id: 'checkpoint.create',
    label: 'Créer un point de restauration',
    owner: 'ConversationHeader',
    hosts: ['ConversationHeader', 'CommandPalette'],
    mirror: ['CommandPalette'],
    justification: 'Snapshot instantané avant manipulation à risque',
    shortcut: 'Ctrl+Maj+S',
  },
  'checkpoint.rollback': {
    id: 'checkpoint.rollback',
    label: 'Restaurer ce point',
    owner: 'CheckpointAnchor',
    hosts: ['CheckpointAnchor', 'CheckpointsList'],
    mirror: ['CheckpointsList'],
    justification: 'Restauration accessible depuis le séparateur transcript ou le panneau',
    isDestructive: true,
  },
  'diff.apply': {
    id: 'diff.apply',
    label: 'Appliquer les modifications',
    owner: 'DiffInspectorTab',
    hosts: ['DiffInspectorTab'],
    mirror: [],
  },
  'diff.reject': {
    id: 'diff.reject',
    label: 'Rejeter les modifications',
    owner: 'DiffInspectorTab',
    hosts: ['DiffInspectorTab'],
    mirror: [],
    isDestructive: true,
  },

  // Panels & Navigation
  'panel.sidebar_toggle': {
    id: 'panel.sidebar_toggle',
    label: 'Basculer la barre latérale',
    owner: 'AppTitleBar',
    hosts: ['AppTitleBar', 'CommandPalette'],
    mirror: ['CommandPalette'],
    shortcut: 'Ctrl+B',
  },
  'panel.inspector_toggle': {
    id: 'panel.inspector_toggle',
    label: 'Basculer l’inspecteur droit',
    owner: 'AppTitleBar',
    hosts: ['AppTitleBar', 'CommandPalette'],
    mirror: ['CommandPalette'],
    shortcut: 'Ctrl+I',
  },
  'panel.terminal_toggle': {
    id: 'panel.terminal_toggle',
    label: 'Basculer le terminal',
    owner: 'AppTitleBar',
    hosts: ['AppTitleBar', 'CommandPalette'],
    mirror: ['CommandPalette'],
    shortcut: 'Ctrl+J',
  },
  'palette.open': {
    id: 'palette.open',
    label: 'Ouvrir la palette de commandes',
    owner: 'AppTitleBar',
    hosts: ['AppTitleBar'],
    mirror: [],
    shortcut: 'Ctrl+K',
  },
} as const satisfies Record<string, ActionDefinition>;

export type ActionId = keyof typeof ACTIONS;

/**
 * Gardien de conformité : vérifie qu'une action est légitimement hébergée.
 */
export function assertActionHost(actionId: ActionId, hostName: string): void {
  const def = ACTIONS[actionId];
  if (!def) {
    throw new Error(`[MAZZ Actions] Action inconnue dans le registre : "${actionId}"`);
  }
  if (!(def.hosts as readonly string[]).includes(hostName)) {
    throw new Error(
      `[MAZZ Actions Violée] L'action "${actionId}" (propriétaire: ${def.owner}) est rendue illégalement par "${hostName}". Hôtes autorisés : ${def.hosts.join(', ')}`
    );
  }
}
