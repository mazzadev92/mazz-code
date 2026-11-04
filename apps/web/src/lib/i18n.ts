// i18n structure: French is the reference language; English covers the shell
// (navigation, status bar, common actions). Missing English keys fall back to French.
import { getState } from './store';

const fr = {
  'nav.home': 'Accueil',
  'nav.agent': 'Agent',
  'nav.sessions': 'Sessions',
  'nav.projects': 'Projets',
  'nav.code': 'Code',
  'nav.git': 'Git',
  'nav.models': 'Modèles',
  'nav.providers': 'Fournisseurs',
  'nav.compute': 'Calcul GPU',
  'nav.tools': 'Outils et MCP',
  'nav.memory': 'Mémoire',
  'nav.performance': 'Performance',
  'nav.quotas': 'Quotas',
  'nav.muce': 'MUCE',
  'nav.settings': 'Paramètres',
  'action.newSession': 'Nouvelle session',
  'action.openFolder': 'Ouvrir un dossier',
  'action.search': 'Rechercher',
  'action.cancel': 'Annuler',
  'action.save': 'Enregistrer',
  'action.retry': 'Réessayer',
  'action.close': 'Fermer',
  'status.ready': 'Prêt',
  'status.busy': 'En cours',
  'status.error': 'Erreur',
  'status.offline': 'Hors ligne',
  'status.connected': 'Connecté',
  'layout.focus': 'Focus chat',
  'layout.coding': 'Coding',
  'layout.review': 'Review',
  'layout.monitoring': 'Monitoring',
} as const;

export type I18nKey = keyof typeof fr;

const en: Partial<Record<I18nKey, string>> = {
  'nav.home': 'Home',
  'nav.agent': 'Agent',
  'nav.sessions': 'Sessions',
  'nav.projects': 'Projects',
  'nav.code': 'Code',
  'nav.git': 'Git',
  'nav.models': 'Models',
  'nav.providers': 'Providers',
  'nav.compute': 'GPU compute',
  'nav.tools': 'Tools and MCP',
  'nav.memory': 'Memory',
  'nav.performance': 'Performance',
  'nav.quotas': 'Quotas',
  'nav.muce': 'MUCE',
  'nav.settings': 'Settings',
  'action.newSession': 'New session',
  'action.openFolder': 'Open folder',
  'action.search': 'Search',
  'action.cancel': 'Cancel',
  'action.save': 'Save',
  'action.retry': 'Retry',
  'action.close': 'Close',
  'status.ready': 'Ready',
  'status.busy': 'Busy',
  'status.error': 'Error',
  'status.offline': 'Offline',
  'status.connected': 'Connected',
  'layout.focus': 'Focus chat',
  'layout.coding': 'Coding',
  'layout.review': 'Review',
  'layout.monitoring': 'Monitoring',
};

export function t(key: I18nKey): string {
  const lang = getState().settings?.general.language ?? 'fr';
  return (lang === 'en' && en[key]) || fr[key];
}
