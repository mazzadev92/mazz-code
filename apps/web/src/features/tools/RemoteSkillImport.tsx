import { useState } from 'react';
import { Download, Globe, ShieldCheck } from '../../components/icons';
import { api } from '../../lib/api';
import { toast } from '../../lib/store';
import { Badge, Button, Card, ErrorBox, Field, Input } from '../../components/ui';

interface SkillImportPreview {
  sourceUrl: string;
  finalUrl: string;
  fetchedAt: string;
  archiveSha256: string;
  downloadedBytes: number;
  name: string;
  description: string;
  files: Array<{ path: string; sizeBytes: number; sha256: string }>;
}

interface PreviewResponse {
  token: string;
  expiresAt: string;
  preview: SkillImportPreview;
}

/** Real HTTPS skill import. Installation is a separate, explicit user action after preview. */
export function RemoteSkillImport({ onInstalled }: { onInstalled: () => void }) {
  const [url, setUrl] = useState('');
  const [pending, setPending] = useState<PreviewResponse | null>(null);
  const [busy, setBusy] = useState<'preview' | 'install' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [confirm, setConfirm] = useState(false);
  const [installed, setInstalled] = useState<{ name: string; archiveSha256: string } | null>(null);

  const preview = async () => {
    const previousToken = pending?.token;
    setBusy('preview');
    setError(null);
    setPending(null);
    setConfirm(false);
    setInstalled(null);
    try {
      if (previousToken) await api.del(`/api/skills/import/preview/${encodeURIComponent(previousToken)}`).catch(() => undefined);
      const result = await api.post<PreviewResponse>('/api/skills/import/preview', { url: url.trim() });
      setPending(result);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const install = async () => {
    if (!pending || !confirm) return;
    setBusy('install');
    setError(null);
    try {
      const result = await api.post<{ skill: { name: string }; preview: SkillImportPreview }>('/api/skills/import/install', {
        token: pending.token,
        confirm: true,
      });
      setInstalled({ name: result.skill.name, archiveSha256: result.preview.archiveSha256 });
      setPending(null);
      setConfirm(false);
      setUrl('');
      onInstalled();
      toast('good', 'Skill installé', `${result.skill.name} — contenu et provenance enregistrés sur disque.`);
    } catch (e) {
      setError(e);
      setPending(null);
      setConfirm(false);
    } finally {
      setBusy(null);
    }
  };

  const cancelPreview = async () => {
    const token = pending?.token;
    setPending(null);
    setConfirm(false);
    setError(null);
    if (token) await api.del(`/api/skills/import/preview/${encodeURIComponent(token)}`).catch(() => undefined);
  };

  return (
    <Card title="Importer un skill distant" subtitle="Source HTTPS publique : un fichier SKILL.md ou une archive ZIP contenant un seul skill. Le contenu est téléchargé et validé avant que l’installation puisse être confirmée.">
      <div className="space-y-3">
        <Field label="URL HTTPS du SKILL.md ou du ZIP" hint="Les redirections, DNS, tailles, chemins et fichiers de l’archive sont contrôlés côté Studio.">
          <div className="flex flex-wrap gap-2">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/SKILL.md ou archive.zip" className="min-w-[260px] flex-1 font-mono" aria-label="URL HTTPS du skill distant" />
            <Button icon={<Globe className="w-3.5 h-3.5" />} loading={busy === 'preview'} disabled={!url.trim() || busy !== null} onClick={() => void preview()}>
              Analyser la source
            </Button>
          </div>
        </Field>

        {error != null && <ErrorBox error={error} />}
        {installed && (
          <div role="status" className="rounded-md border border-good/40 bg-good/5 p-3 text-[12px] text-fg">
            <div className="flex items-center gap-2"><Badge tone="good">Installé</Badge><span className="font-mono">{installed.name}</span></div>
            <div className="mt-2 break-all text-muted">SHA-256 du paquet : <span className="font-mono">{installed.archiveSha256}</span></div>
          </div>
        )}

        {pending && (
          <div className="space-y-3 rounded-md border border-line bg-sunk p-3" aria-label="Prévisualisation du skill distant">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="info">À examiner</Badge>
              <span className="font-mono text-[13px] text-fg">{pending.preview.name}</span>
              <span className="text-[12px] text-muted">{formatBytes(pending.preview.downloadedBytes)} téléchargés</span>
            </div>
            <p className="text-[12px] text-muted">{pending.preview.description}</p>
            <dl className="grid gap-1 text-[11px] text-muted">
              <dt>Source demandée</dt><dd className="break-all font-mono text-fg">{pending.preview.sourceUrl}</dd>
              {pending.preview.finalUrl !== pending.preview.sourceUrl && <><dt>Destination finale vérifiée</dt><dd className="break-all font-mono text-fg">{pending.preview.finalUrl}</dd></>}
              <dt>Paquet SHA-256</dt><dd className="break-all font-mono text-fg">{pending.preview.archiveSha256}</dd>
              <dt>Récupéré le</dt><dd className="font-mono text-fg">{new Date(pending.preview.fetchedAt).toLocaleString()}</dd>
              <dt>Prévisualisation valable jusqu’au</dt><dd className="font-mono text-fg">{new Date(pending.expiresAt).toLocaleString()}</dd>
            </dl>
            <div className="max-h-48 overflow-auto rounded border border-line bg-panel">
              <div className="sticky top-0 grid grid-cols-[minmax(0,1fr)_5rem_12rem] gap-2 border-b border-line bg-raised px-2 py-1.5 text-[10px] uppercase tracking-wide text-faint">
                <span>Fichier installé</span><span>Taille</span><span>SHA-256</span>
              </div>
              {pending.preview.files.map((file) => (
                <div key={file.path} className="grid grid-cols-[minmax(0,1fr)_5rem_12rem] gap-2 border-b border-line/60 px-2 py-1.5 text-[10px] text-muted last:border-0">
                  <span className="break-all font-mono text-fg">{file.path}</span><span>{formatBytes(file.sizeBytes)}</span><span className="break-all font-mono">{file.sha256}</span>
                </div>
              ))}
            </div>
            <label className="flex cursor-pointer items-start gap-2 text-[12px] text-fg">
              <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="mt-0.5 accent-[var(--color-brand)]" />
              <span>J’ai examiné la source, les fichiers et leurs empreintes. J’autorise l’installation dans le dossier skills du Studio.</span>
            </label>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" icon={<Download className="w-3.5 h-3.5" />} loading={busy === 'install'} disabled={!confirm || busy !== null} onClick={() => void install()}>
                Confirmer et installer
              </Button>
              <Button variant="ghost" disabled={busy !== null} onClick={() => void cancelPreview()}>Annuler l’import</Button>
              <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-faint"><ShieldCheck className="h-3.5 w-3.5" /> Aucun script n’est exécuté pendant l’import.</span>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Kio`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} Mio`;
}
