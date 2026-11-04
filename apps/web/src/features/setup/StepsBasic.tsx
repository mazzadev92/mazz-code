import { useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { saveSettings, toast, useApp } from '../../lib/store';
import type { Doctor } from '../../lib/types';
import { Button } from '../../components/ui';
import { PathPicker } from '../../components/overlays';
import { Term } from './Term';
import { GOALS, hardwareVerdict } from './logic';

export function StepWelcome() {
  return (
    <div className="space-y-2 text-[13px] text-muted">
      <p>MAZZ est un atelier d’IA qui tourne sur votre ordinateur. Il peut utiliser des <Term id="modele">modèles</Term> installés chez vous, ou des services en ligne gratuits que vous connectez vous-même. Rien n’est envoyé à l’éditeur.</p>
      <p>Chaque étape est facultative et peut être reprise plus tard depuis Paramètres, section Général.</p>
    </div>
  );
}

export function StepComputer({ doctor }: { doctor?: Doctor }) {
  const v = hardwareVerdict({ ramBytes: doctor?.memory.totalBytes, cores: doctor?.cpu.logicalCores, gpus: doctor?.gpu.detected.map((g) => g.name) });
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[12.5px]">
        {[['Mémoire (RAM)', v.ram], ['Processeur', v.cpu], ['Carte graphique', v.gpu], ['Espace disque', v.disk]].map(([k, val]) => (
          <div key={k} className="rounded-md border border-line bg-sunk px-3 py-2">
            <dt className="text-faint text-[11px]">{k}</dt>
            <dd className="text-fg break-words">{val}</dd>
          </div>
        ))}
      </dl>
      <p className="text-[13px] text-fg">{doctor ? v.text : 'Détection en cours…'}</p>
      <p className="text-[12.5px] text-muted">
        Un <Term id="modele" /> se mesure en <Term id="parametres" /> ; plus il est gros, plus il demande de <Term id="vram">RAM ou de VRAM</Term>. La <Term id="quantification" /> le compresse pour qu’il tienne en mémoire. Les valeurs « N/D » ne sont pas détectées par cette version.
      </p>
    </div>
  );
}

export function StepStorage({ dataDir }: { dataDir?: string }) {
  const folders = useApp((s) => s.settings?.models.scanFolders) ?? [];
  const [picker, setPicker] = useState(false);
  return (
    <div className="space-y-3 text-[12.5px]">
      <div>
        <div className="text-faint text-[11px]">Dossier de données (clés chiffrées, sessions, réglages)</div>
        <div className="font-mono text-fg break-all">{dataDir ?? 'N/D'}</div>
        <p className="text-muted mt-1">Défini au lancement de l’application (mode portable : à côté de l’application, sinon profil utilisateur). Il n’est pas modifiable ici.</p>
      </div>
      <div>
        <div className="text-faint text-[11px]">Dossiers de modèles analysés</div>
        {folders.length ? <ul className="font-mono text-fg">{folders.map((f) => <li key={f} className="break-all">{f}</li>)}</ul> : <p className="text-muted">Aucun dossier pour l’instant : vous pouvez le laisser vide.</p>}
        <Button size="sm" className="mt-2" onClick={() => setPicker(true)}>Ajouter un dossier de modèles</Button>
      </div>
      <PathPicker open={picker} mode="folder" title="Choisir un dossier de modèles" onClose={() => setPicker(false)} onPick={async (p) => {
        try {
          await saveSettings({ models: { scanFolders: Array.from(new Set([...folders, p])) } });
          toast('good', 'Dossier ajouté', p);
        } catch (e) { toast('bad', 'Ajout impossible', errorMessage(e)); }
      }} />
    </div>
  );
}

export function StepGoals({ goals, onChange }: { goals: string[]; onChange: (g: string[]) => void }) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-[13px] text-muted mb-1">Plusieurs choix possibles. Ils servent uniquement à ne proposer que les services utiles.</legend>
      {GOALS.map((g) => (
        <label key={g.id} className="flex items-center gap-2 text-[13px] text-fg cursor-pointer">
          <input type="checkbox" checked={goals.includes(g.id)} onChange={(e) => onChange(e.target.checked ? [...goals, g.id] : goals.filter((x) => x !== g.id))} />
          {g.label}
        </label>
      ))}
    </fieldset>
  );
}

export function StepModels({ onNavigate, onChanged }: { onNavigate: () => void; onChanged: () => void }) {
  const count = useApp((s) => s.settings?.models.library.length ?? 0);
  const [picker, setPicker] = useState(false);
  return (
    <div className="space-y-3 text-[12.5px]">
      <p className="text-muted">Un fichier <Term id="gguf" /> reste à son emplacement ; seuls ses en-têtes sont lus. Choisissez une <Term id="quantification" /> adaptée à votre mémoire et lisez la licence du modèle avant de l’utiliser.</p>
      <p className="text-faint">Bibliothèque actuelle : {count} modèle(s).</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setPicker(true)}>Ajouter un fichier GGUF</Button>
        <Button size="sm" variant="secondary" onClick={onNavigate}>Ouvrir la page Modèles (catalogue et téléchargements)</Button>
      </div>
      <PathPicker open={picker} mode="file" ext=".gguf" title="Choisir un modèle GGUF" onClose={() => setPicker(false)} onPick={async (p) => {
        try {
          await api.post('/api/models/library', { path: p });
          await saveSettings({});
          toast('good', 'Modèle ajouté', p);
          onChanged();
        } catch (e) { toast('bad', 'Ajout impossible', errorMessage(e)); }
      }} />
    </div>
  );
}
