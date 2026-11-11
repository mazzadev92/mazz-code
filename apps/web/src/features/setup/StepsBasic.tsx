import { useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { fmtBytes } from '../../lib/format';
import { saveSettings, toast, useApp } from '../../lib/store';
import type { Doctor } from '../../lib/types';
import { Button } from '../../components/ui';
import { PathPicker } from '../../components/overlays';
import { Term } from './Term';
import { GOALS, diskVerdict, hardwareVerdict } from './logic';

export function StepWelcome() {
  const [accepted, setAccepted] = useState(true);
  return (
    <div className="space-y-3 text-[13px] text-muted">
      <p>MAZZ est un atelier d’IA d’ingénierie qui tourne sur votre ordinateur. Il peut utiliser des <Term id="modele">modèles</Term> installés chez vous, ou des services distants gratuits que vous connectez vous-même. <strong>Rien n’est envoyé à l’éditeur.</strong></p>
      <div className="rounded-md border border-line bg-sunk p-3 text-[12.5px] space-y-2">
        <div className="font-medium text-fg flex items-center justify-between">
          <span>Cadre d’utilisation & Sécurité</span>
          <span className="text-[11px] text-faint">Logiciel propriétaire gratuit</span>
        </div>
        <p className="text-muted">
          L’utilisation de MAZZ est réservée aux personnes de <strong>15 ans et plus</strong> (ou sous accord parental pour les 13-14 ans). Vos clés d’API sont protégées sur votre ordinateur par <strong>chiffrement Windows DPAPI</strong> et ne quittent jamais votre machine.
        </p>
        <label className="flex items-start gap-2 pt-1 text-fg cursor-pointer select-none">
          <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="mt-0.5 rounded border-line" />
          <span>J’accepte le Contrat de Licence Utilisateur Final (EULA) et les CGU de MAZZ.</span>
        </label>
      </div>
      <p className="text-[12px] text-faint">Chaque étape est facultative et peut être reprise plus tard depuis Paramètres, section Général.</p>
    </div>
  );
}

export function StepComputer({ doctor }: { doctor?: Doctor }) {
  const gpuNames = doctor?.gpu.detected.map((g) => g.vramBytes
    ? `${g.name} (${Math.round(g.vramBytes / 1024 ** 3)} Go de VRAM)`
    : g.name);
  const v = hardwareVerdict({ ramBytes: doctor?.memory.totalBytes, cores: doctor?.cpu.logicalCores, gpus: gpuNames, diskFreeBytes: doctor?.disk?.data?.freeBytes });
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
      {doctor && <p className="text-[13px] text-fg">{diskVerdict(doctor.disk?.data?.freeBytes).text}</p>}
      <p className="text-[12.5px] text-muted">
        Un <Term id="modele" /> se mesure en <Term id="parametres" /> ; plus il est gros, plus il demande de <Term id="vram">RAM ou de VRAM</Term>. La <Term id="quantification" /> le compresse pour qu’il tienne en mémoire. Les valeurs « N/D » ne sont pas détectées par cette version.
      </p>
      {doctor?.gpu.detected.length ? (
        <div className="text-[12px] text-muted">
          <span className="text-faint text-[11px]">Détail des cartes graphiques : </span>
          {doctor.gpu.detected.map((g) => `${g.name}${g.vramBytes ? ` — ${Math.round(g.vramBytes / 1024 ** 3)} Go` : ''}${g.driver ? ` — pilote ${g.driver}` : ''}`).join(' · ')}
        </div>
      ) : null}
    </div>
  );
}

export function StepStorage({ dataDir, doctor }: { dataDir?: string; doctor?: Doctor }) {
  const folders = useApp((s) => s.settings?.models.scanFolders) ?? [];
  const [picker, setPicker] = useState(false);
  return (
    <div className="space-y-3 text-[12.5px]">
      <div>
        <div className="text-faint text-[11px]">Dossier de données (clés chiffrées, sessions, réglages)</div>
        <div className="font-mono text-fg break-all">{dataDir ?? 'N/D'}</div>
        <p className="text-muted mt-1">Défini au lancement de l’application (mode portable : à côté de l’application, sinon profil utilisateur). Il n’est pas modifiable ici.</p>
        {doctor && <p className="text-fg mt-1">{diskVerdict(doctor.disk?.data?.freeBytes).text}</p>}
      </div>
      <div>
        <div className="text-faint text-[11px]">Dossiers de modèles analysés</div>
        {folders.length ? <ul className="font-mono text-fg">{folders.map((f) => <li key={f} className="break-all">{f}</li>)}</ul> : <p className="text-muted">Aucun dossier pour l’instant : vous pouvez le laisser vide.</p>}
        {doctor?.disk?.models && <p className="text-fg mt-1">Volume des modèles : {diskVerdict(doctor.disk.models.freeBytes).text}</p>}
        <Button size="sm" className="mt-2" onClick={() => setPicker(true)}>Ajouter un dossier de modèles</Button>
      </div>
      {doctor?.volumes?.length ? (
        <div>
          <div className="text-faint text-[11px]">Disques détectés sur cet ordinateur</div>
          <ul className="mt-1 space-y-1">
            {doctor.volumes.map((volume) => (
              <li key={volume.mount} className="flex flex-wrap items-baseline justify-between gap-2 rounded border border-line bg-sunk px-2 py-1">
                 <span className="font-mono text-fg">
                   {volume.mount} {volume.label ? `· ${volume.label}` : ''}{' '}
                   <span className="text-faint text-[11px]">{volume.type === 'fixed' ? 'interne' : volume.type === 'removable' ? 'amovible' : volume.type === 'network' ? 'réseau' : 'autre'}</span>{' '}
                   {volume.mediaType === 'ssd' && <span className="text-faint text-[11px]">· SSD</span>}
                   {volume.mediaType === 'hdd' && <span className="text-faint text-[11px]">· Disque dur</span>}
                 </span>
                <span className="text-muted">{fmtBytes(volume.freeBytes)} libres sur {fmtBytes(volume.totalBytes)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
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
        <Button size="sm" variant="secondary" onClick={onNavigate}>Ouvrir le Model Hub (modèles MAZZ publics, téléchargements)</Button>
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
