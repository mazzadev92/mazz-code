# Design system MAZZ ÆNGENIUM — Agent Studio

Source : `apps/web/src/styles/index.css` (jetons) et `apps/web/src/components/ui.tsx` (primitives). Direction artistique : « Living Engineering » (`D:\Mazz Laef\docs\DIRECTION_ARTISTIQUE_OFFICIELLE.md`).

## 1. Thèmes

Sélection par attributs sur `<html>` : `data-theme="bioforge|blueprint"`, `data-mode="dark|light"`, `data-contrast="high"`, `data-density="comfortable|compact"`, `data-motion="system|reduced|full"`. Bascule instantanée, enregistrée côté serveur et recopiée localement pour éviter un flash au chargement.

| Jeton | Bioforge sombre | Bioforge clair (Ivoire) | Blueprint sombre | Blueprint clair |
| :--- | :--- | :--- | :--- | :--- |
| `--bg` | `#0a0e0b` | `#fbfaf4` | `#0a111d` | `#f6f8fb` |
| `--panel` | `#0d1310` | `#f4f1e8` | `#0d1626` | `#eef2f8` |
| `--raised` | `#131b16` | `#ffffff` | `#121e32` | `#ffffff` |
| `--line` | `#1f2c24` | `#e1dacb` | `#1d2c45` | `#d5deeb` |
| `--fg` | `#ebe5d8` | `#14231b` | `#e3e9f3` | `#101b2c` |
| `--muted` | `#a6ad9f` | `#4c5b51` | `#9eadc4` | `#45536b` |
| `--primary` | `#c9a57a` champagne | `#123c2c` forest | `#8fbde6` cyanotype | `#1d4f86` |
| `--brand` | `#c9a57a` | `#86643a` | `#c9a57a` | `#86643a` |
| `--good` | `#94b89a` sage | `#2f6b4a` | `#8fc7a8` | `#2b6b4c` |
| `--warn` | `#d2b07c` | `#8a6224` | `#d8b67e` | `#855f1f` |
| `--bad` | `#c98a62` cuivre | `#9c4f33` | `#d39270` | `#984c31` |

Règles : aucune couleur néon ; les erreurs sont cuivre, jamais rouge vif ; la grille de construction (`.deco-grid`) n’apparaît que dans les zones décoratives (en-tête d’accueil, états vides), jamais derrière une conversation, l’éditeur ou un tableau. L’emblème lumineux n’est affiché que sur fond sombre ; en mode clair la tuile d’application le remplace.

Contraste élevé : `--muted` passe à la couleur du texte, bordures renforcées, halo supprimé.

## 2. Typographie

| Usage | Police | Taille |
| :--- | :--- | :--- |
| Interface | Inter Variable | 13 px (base), 11 à 14 px |
| Titres, marque | Sora Variable | 14 à 26 px, interlettrage -0,015 em ; marque 0,22 em |
| Code, chemins, mesures | JetBrains Mono Variable | `--code-size` (13 px, réglable 10 à 22) |

Polices embarquées localement (`@fontsource`) : aucune requête externe. Chiffres tabulaires (`.tabular`) pour toute mesure.

## 3. Espacement, formes, profondeur

- Échelle 4/8 px (`--space-1` à `--space-6`).
- Rayons : 4, 6, 8, 12, 16 px (`--radius-xs` à `--radius-xl`). Tuile de marque : 23 %.
- Bordures 1 px `--line` ; ombres `--shadow-1` (contrôles) et `--shadow-2` (popovers, dialogues). Pas de glassmorphism.
- Couches : panneaux 10, popovers 50, dialogues 60, palette 70, toasts 80.

## 4. Mouvement

Courbes nommées de la DA : `--ease-organic`, `--ease-precision`, `--ease-soft-snap`, `--ease-germinate`, `--ease-inhale`. Durées 110 / 160 / 220 ms.

| Animation | Usage | Justification |
| :--- | :--- | :--- |
| `breathe` 6 s | marque au repos | état « veille » de la DA |
| `core-pulse` | marque pendant une tâche | délibération, sans rotation |
| `core-latch` | marque pendant un outil | verrouillage mécanique |
| `core-contract` | erreur | contraction cuivre contenue |
| `germinate` | emblème d’accueil | apparition depuis la graine |
| `fade-up` | dialogues, toasts | entrée discrète |
| `indeterminate` | tâche en cours sans pourcentage connu | aucune fausse progression |

`prefers-reduced-motion` (ou le réglage « Réduites ») coupe les animations. Le texte en streaming n’anime rien : il est simplement ajouté.

## 5. Composants

| Composant | Rôle | Notes d’accessibilité |
| :--- | :--- | :--- |
| `Button`, `IconButton` | actions ; variantes primary, secondary, ghost, subtle, danger | `aria-busy` pendant le chargement, `aria-label` obligatoire pour les icônes |
| `Badge`, `StatusDot` | états fonctionnels (Local, API, En cours, Échec...) | jamais décoratifs |
| `Availability` | Disponible, Expérimental, Configuration requise, Non disponible | pour toute fonction incomplète |
| `Card`, `Stat`, `Notice`, `EmptyState`, `ErrorBox` | structure, mesure, information, état vide, erreur | `role="alert"` sur les erreurs |
| `Field`, `Input`, `Select`, `Toggle`, `Segmented`, `Tabs` | formulaires et choix | `role="switch"`, `radiogroup`, `tablist` |
| `Dialog`, `ConfirmDialog` | modales | piège de focus, Échap, retour du focus ; double clic neutralisé |
| `Splitter` | redimensionnement | `role="separator"`, flèches clavier, double clic = taille par défaut |
| `CommandPalette` | Ctrl+K | combobox / listbox, navigation clavier |
| `PathPicker` | dossiers et fichiers locaux | navigateur intégré + dialogue Windows natif |
| `DiffView` | diff unifié ou côte à côte | rendu limité à 3000 lignes |
| `Markdown`, `CodeBlock` | réponses du modèle | aucun HTML interprété, liens http(s)/mailto seuls |
| `Sparkline`, `LineChart`, `Meter` | mesures | SVG ; valeurs absentes en trous, jamais en zéro |

## 6. Icônes

Lucide (ISC), trait 2 px, tailles 14 à 18 px. Tuiles de module de la planche Bioforge (`public/brand/icons`) uniquement en en-tête de page. Aucun emoji : vérifié par `npm run lint:emoji`.

## 7. Rédaction

Français professionnel, phrases courtes, verbe d’action sur les boutons. Une valeur inconnue s’écrit « N/D ». Une fonction absente s’écrit « Non disponible » avec la raison et la piste de résolution. Une confirmation de succès n’apparaît qu’après la réponse du serveur.
