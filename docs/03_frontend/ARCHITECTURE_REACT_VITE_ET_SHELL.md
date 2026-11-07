# 03 — Front-End : Architecture React, Vite et AppShell

## 1. Structure de l'application cliente

L'application monopage (`apps/web`) est orchestrée par le composant central `AppShell` :
- **Navigation latérale unifiée** : Chaque fonctionnalité maîtresse dispose d'une seule entrée officielle (Accueil, Agent, Code, Modèles, Calcul GPU, Fournisseurs, Services, Performance, Mémoire, Réglages).
- **Chargement différé (Code Splitting)** : Toutes les vues secondaires sont chargées via `React.lazy` et `Suspense`. L'utilisateur ne télécharge que les modules nécessaires à la vue affichée.
- **Gestion d'état réactive** : État global minimaliste sans usine à gaz (store basé sur des écouteurs simples et `useSyncExternalStore`), synchronisé avec l'état de santé du serveur.

## 2. Optimisations de performance Vite & Rollup

- **Budgets de bundle stricts** : Le chunk principal de l'application est maintenu sous la limite de 500 Ko grâce à l'exclusion des modules lourds non critiques au premier écran.
- **Remplacement des icônes** : Abandon de `lucide-react` au profit du jeu d'icônes optimisé **Phosphor Icons**, éliminant plusieurs centaines de kilo-octets de dépendances d'arborescence.
- **Zéro polling inutile** : Les requêtes périodiques s'arrêtent dès que l'onglet du navigateur ou la fenêtre Electron passe en arrière-plan (`document.hidden`).

