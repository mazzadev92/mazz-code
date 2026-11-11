import { useState } from 'react';
import { ExternalLink } from '../../components/icons';
import { api, errorMessage } from '../../lib/api';
import { toast } from '../../lib/store';
import { Badge, Button, Field, Input, Notice } from '../../components/ui';
import { FREE_KIND_LABELS, isUnverified, type SecretTarget, type ServiceEntry } from './services-format';

export interface ProviderState { configured: boolean; ok: boolean | null; detail?: string }

const yesNo = (v: boolean | null, yes: string, no: string, unknown: string) => (v === true ? yes : v === false ? no : unknown);

/** Guided setup of one service: what it is worth, numbered steps with the direct link, where to paste, test. */
export function ServiceGuide({ service, target, state, onChanged }: { service: ServiceEntry; target: SecretTarget; state?: ProviderState; onChanged: () => void }) {
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async () => {
    setBusy(true); setResult(null);
    try {
      if (target.kind === 'compute') {
        const r = await api.post<{ state: ProviderState }>(`/api/compute/providers/${encodeURIComponent(target.id)}/configure`, { token: secret });
        setResult({ ok: r.state.ok === true, text: r.state.detail ?? 'Enregistré.' });
      } else if (target.kind === 'router') {
        await api.put(`/api/integrations/${encodeURIComponent(target.id)}/key`, { key: secret });
        const t = await api.post<{ ok: boolean; detail?: string }>(`/api/integrations/${encodeURIComponent(target.id)}/test`, {});
        setResult({ ok: t.ok, text: t.detail ?? (t.ok ? 'Clé valide.' : 'Clé refusée.') });
      }
      setSecret('');
      toast('good', `${service.name} : enregistré`);
      onChanged();
    } catch (e) {
      setResult({ ok: false, text: errorMessage(e) });
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3 text-[12.5px]">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={service.free_kind === 'none' ? 'warn' : isUnverified(service) ? 'neutral' : 'good'}>{FREE_KIND_LABELS[service.free_kind]}</Badge>
        <Badge tone={service.requires_card ? 'warn' : 'neutral'}>{yesNo(service.requires_card, 'Carte bancaire demandée', 'Sans carte bancaire', 'Carte : à vérifier')}</Badge>
        <Badge>{yesNo(service.requires_phone, 'Téléphone demandé', 'Sans téléphone', 'Téléphone : à vérifier')}</Badge>
        {service.cold_start && <Badge tone="neutral">{service.cold_start}</Badge>}
        <span className="text-faint">vérifié le {service.verified_at}</span>
        <a className="text-info inline-flex items-center gap-1 hover:underline" href={service.source_url} target="_blank" rel="noreferrer noopener">source officielle <ExternalLink className="w-3 h-3" /></a>
      </div>
      <p className="text-muted">{service.free_tier}</p>
      {isUnverified(service) && <Notice tone="warn" title="Quota non vérifié">Aucune déclaration officielle claire n’a été trouvée. Lisez la page du service avant de vous y fier.</Notice>}
      {service.requires_card === true && <Notice tone="warn" title="Carte bancaire demandée">Ce service peut devenir payant. Fixez une limite de dépense avant de commencer.</Notice>}
      {service.requires_phone === true && <Notice tone="info" title="Vérification par SMS requise">Pour empêcher le minage abusif, ce fournisseur exige la validation de votre numéro de téléphone dans les réglages de profil afin de débloquer le GPU gratuit et l'accès Internet.</Notice>}
      {service.id === 'huggingface' && <Notice tone="good" title="Modèles MAZZ inclus d'office">Les modèles souverains de la flotte MAZZ sont libres et téléchargeables directement dans l'onglet Modèles sans jeton. Cette configuration n'est requise que pour vos propres dépôts personnels.</Notice>}
      {service.steps.length > 0 && (
        <ol className="list-decimal pl-5 space-y-1 text-fg/90">
          {service.steps.map((s) => <li key={s}>{s}</li>)}
        </ol>
      )}
      <div className="flex flex-wrap gap-2">
        <a href={service.signup_url} target="_blank" rel="noreferrer noopener"><Button size="sm" variant="secondary" icon={<ExternalLink className="w-3.5 h-3.5" />}>Créer un compte</Button></a>
        <a href={service.website} target="_blank" rel="noreferrer noopener"><Button size="sm" variant="ghost">Site officiel</Button></a>
      </div>
      {service.where_to_find && <p className="text-faint">Où le trouver : {service.where_to_find}</p>}
      {target.kind !== 'none' && service.secret_name && (
        <div className="space-y-2">
          <Field label={service.secret_name} htmlFor={`sec-${service.id}`} hint={`Enregistré : ${service.where_saved}`}>
            <Input id={`sec-${service.id}`} type="password" autoComplete="off" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value)} />
          </Field>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => void save()} loading={busy} disabled={!secret.trim()}>Enregistrer et tester</Button>
            {state && <Badge tone={state.ok ? 'good' : state.configured ? 'warn' : 'neutral'}>{state.ok ? 'Prêt' : state.configured ? 'À vérifier' : 'Pas encore configuré'}</Badge>}
            {result && <span className={result.ok ? 'text-good' : 'text-bad'}>{result.text}</span>}
          </div>
        </div>
      )}
      {target.kind === 'compute' && !service.secret_name && state && (
        <div className="flex items-center gap-2"><Badge tone={state.ok ? 'good' : 'neutral'}>{state.ok ? 'Prêt' : 'Pas encore configuré'}</Badge><span className="text-faint">{state.detail}</span></div>
      )}
      {target.kind === 'none' && <Notice tone="info" title="Guide seulement">MAZZ ne pilote pas encore ce service. Suivez les étapes ; s’il propose une API compatible OpenAI, ajoutez-le dans Fournisseurs.</Notice>}
      {service.notes && <p className="text-faint">Bon à savoir : {service.notes}</p>}
    </div>
  );
}
