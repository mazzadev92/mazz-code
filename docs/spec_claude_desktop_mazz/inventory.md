# INVENTAIRE EXHAUSTIF DES COMPOSANTS — MAZZ ÆNGENIUM DESKTOP
Document de référence : interdiction de tout composant hors de cet inventaire.

| Composant | Fichier source | Instances autorisées | Propriétaire / Rôle | Actions gérées |
| :--- | :--- | :---: | :--- | :--- |
| `AppTitleBar` | `shell/AppShell.tsx` | 1 | Shell principal | `panel.sidebar_toggle`, `panel.inspector_toggle`, `panel.terminal_toggle`, `palette.open` |
| `StatusBar` | `shell/AppShell.tsx` | 1 | Shell principal | Visualisation débit tok/s, tokens session, RAM |
| `SidebarHeader` | `features/sessions/SessionsSidebar.tsx` | 1 | Barre latérale | `session.new`, filtre recherche Ctrl+F |
| `SessionList` | `features/sessions/SessionsSidebar.tsx` | 1 | Barre latérale | Groupes chronologiques, sélection clavier |
| `SessionItem` | `features/sessions/SessionsSidebar.tsx` | N (virtualisé) | Liste de sessions | `session.rename`, `session.delete`, `session.export` |
| `ConversationHeader` | `features/agent/AgentView.tsx` | 1 | Zone conversation | Titre éditable, jauge contexte, snapshot |
| `TranscriptView` | `features/agent/TurnView.tsx` | 1 | Zone centrale | Rendu flux, ancrage bas, markdown, LaTeX |
| `UserMessageBlock` | `features/agent/TurnView.tsx` | N | Transcript | `message.copy`, `message.edit` |
| `AssistantMessageBlock` | `features/agent/TurnView.tsx` | N | Transcript | `message.copy`, `message.regenerate`, `message.branch` |
| `ReasoningCard` | `features/agent/TurnView.tsx` | N (max 1/message) | Blocs spécialisés | `reasoning.toggle` |
| `ToolCallCard` | `features/agent/TurnView.tsx` | N | Blocs spécialisés | Visualisation statut, arguments, sortie 240px |
| `ApprovalCard` | `features/agent/TurnView.tsx` | N (max 1 active) | Blocs d'approbation | `approval.allow_once`, `approval.allow_always`, `approval.deny` |
| `ComposerDock` | `features/agent/Composer.tsx` | 1 | Zone de saisie | Conteneur dock, dropzone, attachements |
| `ComposerPrimaryButton` | `features/agent/Composer.tsx` | 1 (nœud unique) | Compositeur | `session.send` (en idle/typing) ou `session.stop` (en streaming) |
| `ModeSwitcher` | `features/agent/Composer.tsx` | 1 | Compositeur | `plan.toggle`, sélecteur Ask/Plan/Agent/Auto/Review |
| `ModelPicker` | `features/agent/ModelPicker.tsx` | 1 | Compositeur | Hiérarchie MAZZ Cloud / Local / Distant |
| `InspectorTabs` | `features/agent/AgentInspector.tsx` | 1 | Panneau droit | Onglets Artefacts, Diff, Fichiers, Tâches, Plan |
| `DiffView` | `features/code/DiffView.tsx` | 1 | Inspecteur | `diff.apply`, `diff.reject`, vue unifiée/split |
| `CommandPalette` | `components/overlays/CommandPalette.tsx` | 1 (modal) | Système global | Commandes, sessions, fichiers (Ctrl+K) |
| `ConfirmDialog` | `components/overlays/ConfirmDialog.tsx` | 1 (modal) | Sécurité | Confirmations destructives avec piège de focus |
