/** Résumés courts de docs/legal/PRIVACY.md et EULA.md. Les documents complets sont fournis avec l'installeur. */
export function Legal() {
  return (
    <div className="rounded-md border border-line bg-sunk px-3 py-2 text-[12.5px] space-y-2">
      <div>
        <div className="font-medium text-fg">Confidentialité (résumé)</div>
        <ul className="list-disc pl-5 text-muted">
          <li>L’éditeur ne collecte aucune donnée : pas de compte, pas de télémétrie.</li>
          <li>Sessions, réglages et clés restent sur votre machine ; les clés sont chiffrées.</li>
          <li>Une donnée ne part que si vous connectez un service externe et l’utilisez ; ce fournisseur applique alors ses propres conditions.</li>
        </ul>
      </div>
      <div>
        <div className="font-medium text-fg">Licence d’utilisation (résumé)</div>
        <ul className="list-disc pl-5 text-muted">
          <li>Un agent peut lire, modifier et supprimer des fichiers et lancer des commandes dans les dossiers que vous autorisez.</li>
          <li>Les réponses d’un modèle peuvent être inexactes : vérifiez-les.</li>
          <li>Chaque modèle et chaque service tiers a sa propre licence et ses propres conditions, que vous respectez.</li>
        </ul>
      </div>
      <p className="text-faint">Les documents complets (licence et politique de confidentialité) sont fournis avec l’installeur et font foi.</p>
    </div>
  );
}
