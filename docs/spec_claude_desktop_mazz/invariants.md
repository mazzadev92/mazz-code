# INVARIANTS TESTABLES DE L'APPLICATION — MAZZ ÆNGENIUM
Chaque invariant porte un identifiant numérique et dispose d'une règle de vérification automatisée.

## 1. Unicité du DOM & Actions
- **INV-01** : Le bouton primaire du compositeur est un nœud DOM strictement unique (`#composer-primary`). Lors de la génération, il permute d'icône, d'intitulé et d'action sans être démonté ni dupliqué.
  *Vérification* : `document.querySelectorAll('#composer-primary').length === 1` en tout état de la machine.
- **INV-02** : Aucune action ne peut être rendue hors de sa liste déclarée `hosts` dans `actions.ts`.
  *Vérification* : Script lint analysant `data-action` dans l'AST JSX.

## 2. Intégrité des données & Données de production
- **INV-03** : Aucune donnée fictive (tableaux mock, faker, lorem ipsum) n'est autorisée dans les chemins d'exécution de production. Toute liste affichée dérive obligatoirement du store ou d'une réponse API backend.
  *Vérification* : Scan grep CI : `grep -rnE "TODO|lorem|dummy|fake" src/`.

## 3. Direction Artistique & Jetons
- **INV-04** : Aucune valeur hexadécimale de couleur littérale n'est tolérée en dur dans les fichiers composants `.tsx`. Toutes les couleurs dérivent impérativement des variables CSS (`var(--bg)`, `var(--brand)`, `var(--bad)`, etc.).
  *Vérification* : Scan grep CI interdisant `#[0-9a-fA-F]{3,6}` hors de `index.css` et `anim.css`.
- **INV-05** : Les erreurs et alertes utilisent exclusivement le cuivre contrôlé (`#c98a62` / `var(--bad)`). Tout rouge néon agressif (`#ff0000`, `rgb(255,0,0)`) est rejeté.

## 4. Navigation & Clavier
- **INV-06** : La fermeture de tout dialogue modal ou panneau restitue systématiquement le focus à l'élément DOM déclencheur d'origine.
  *Vérification* : Test E2E Playwright mesurant `document.activeElement` avant et après fermeture d'une modale.
- **INV-07** : Tout texte ou titre tronqué par ellipsis doit obligatoirement posséder un attribut `title` ou une infobulle accessible reflétant le contenu complet.

## 5. Performances & Mémoire
- **INV-08** : L'empreinte mémoire UI du navigateur reste inférieure à 250 Mo avec 10 000 messages virtualisés.
- **INV-09** : Premier rendu interactif inférieur à 400 ms sur CPU Skylake i5-6500.
