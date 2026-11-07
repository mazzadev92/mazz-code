# 03 — Front-End : Éditeur CodeMirror et vue partagée d'aperçu

## 1. Découpage dynamique de CodeMirror 6

Dans les versions antérieures, le chunk d'éditeur (`editor-*.js`) pesait près de 800 Ko car l'ensemble des grammaires de coloration syntaxique (C++, Python, Rust, TypeScript, Markdown, SQL, CSS, HTML) était regroupé dans un bloc monolithique.

Une analyse fine du fichier `vite.config.ts` a mis en évidence un caractère d'échappement ASCII invisible (`\x08`) dans l'expression régulière de découpage, forçant l'inclusion indésirable de tous les parseurs Lezer.

### Résolution et résultats :
- L'expression régulière a été corrigée pour laisser Rollup isoler chaque mode syntaxique dans son propre chunk dynamique.
- Poids de l'éditeur principal : **réduit de 795 Ko à 396 Ko (-50%)**.
- Les modules de langage (`@codemirror/lang-python`, `@codemirror/lang-cpp`, etc.) sont désormais téléchargés à la volée selon l'extension du fichier ouvert par le développeur.

## 2. Vue partagée d'aperçu interactif (Split Preview)

Pour les fichiers textuels interprétables (`.md`, `.html`, `.svg`), la vue Code propose un bouton « Aperçu » permettant de scinder l'écran en deux panneaux synchronisés :
- **Panneau gauche** : Éditeur de code en temps réel avec coloration syntaxique et détection des modifications non sauvegardées.
- **Panneau droit** :
  - **Fichiers Markdown (`.md`)** : Rendu dynamique des titres, tableaux, blocs de code surlignés et formules mathématiques KaTeX.
  - **Fichiers HTML (`.html`)** : Rendu isolé dans la sandbox sécurisée `ArtifactSandbox` avec CSP stricte sans réseau.
  - **Fichiers SVG (`.svg`)** : Rendu vectoriel centré avec fond tramé pour vérifier visuellement les tracés graphiques.

