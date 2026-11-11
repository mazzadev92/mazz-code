import { useState } from 'react';
import { ChevronDown, ChevronRight } from '../../components/icons';
import { Badge, Button, Card, Notice } from '../../components/ui';
import { navigate } from '../../lib/store';
import { ServiceGuide } from './ServiceGuide';
import { CATEGORY_LABELS, FREE_KIND_LABELS, isUnverified, type ServiceEntry } from './services-format';
import { useServiceCatalog, type ServiceCatalog } from '../setup/useServiceCatalog';

/** Collapsible service card, same guide as the Services page (signup, token, test). */
function ServiceAccordion({ service, cat }: { service: ServiceEntry; cat: ServiceCatalog }) {
  const [open, setOpen] = useState(false);
  const target = cat.targetOf(service);
  const state = target.kind === 'compute' ? cat.states[target.id] : undefined;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li className="rounded-[var(--radius-md)] border border-line bg-sunk">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="w-full flex flex-wrap items-center gap-2 px-3 py-2.5 text-left cursor-pointer">
        <Chevron className="w-3.5 h-3.5 text-faint" />
        <span className="font-medium text-fg text-[13px]">{service.name}</span>
        <Badge>{CATEGORY_LABELS[service.category] ?? service.category}</Badge>
        <Badge tone={service.free_kind === 'none' ? 'warn' : 'neutral'}>{FREE_KIND_LABELS[service.free_kind]}</Badge>
        {service.requires_phone === true && <Badge tone="info">Téléphone requis</Badge>}
        {service.requires_card === true && <Badge tone="warn">Carte bancaire</Badge>}
        {state?.ok && <Badge tone="good">Prêt</Badge>}
        {isUnverified(service) && <Badge tone="neutral">Quota à vérifier</Badge>}
        <span className="ml-auto text-[12px] text-faint truncate max-w-[55%]">{service.free_tier}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-2 border-t border-line">
          <ServiceGuide service={service} target={target} state={state} onChanged={cat.reload} />
        </div>
      )}
    </li>
  );
}

function Section({ title, subtitle, ids, cat }: { title: string; subtitle: string; ids: string[]; cat: ServiceCatalog }) {
  const list = ids.map((id) => cat.services?.find((s) => s.id === id)).filter((s): s is ServiceEntry => !!s);
  return (
    <Card title={title} subtitle={subtitle}>
      {cat.error && <Notice tone="warn" title="Catalogue indisponible">Le catalogue des services n’a pas pu être chargé. Réessayez dans un instant.</Notice>}
      {!cat.services && !cat.error && <p className="text-[12.5px] text-faint">Chargement du catalogue…</p>}
      {list.length > 0 && (
        <ul className="space-y-2">
          {list.map((s) => (
            <ServiceAccordion key={s.id} service={s} cat={cat} />
          ))}
        </ul>
      )}
      {cat.services && list.length === 0 && <p className="text-[12.5px] text-faint">Ces fiches ne sont pas dans le catalogue de cette version.</p>}
    </Card>
  );
}

/**
 * Guided services page: the few services a newcomer actually needs, with the same
 * signup/token/test guide as the full catalogue. The 164-service catalogue stays one click away.
 */
export default function GuidedServices() {
  const cat = useServiceCatalog();
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[980px] mx-auto px-6 py-6 space-y-4">
        <div>
          <h1 className="text-[20px] font-medium text-fg">Services et comptes</h1>
          <p className="text-[12.5px] text-muted mt-1 max-w-2xl">
            Tous ces services sont facultatifs. Un modèle local suffit pour commencer. Chaque fiche explique comment créer le compte, où trouver la clé et comment vérifier que tout fonctionne.
          </p>
        </div>

        <Notice tone="info" title="Comment ça marche, en 3 étapes">
          <ol className="list-decimal pl-5 space-y-1">
            <li>Cliquez sur « Créer un compte » : le site officiel s’ouvre dans un nouvel onglet. C’est gratuit et facultatif.</li>
            <li>Dans les réglages du site, créez une clé (ou un jeton) et copiez-la. Elle ressemble à une longue suite de lettres.</li>
            <li>Revenez ici, ouvrez la fiche du service, collez la clé dans le champ puis cliquez sur « Enregistrer et tester ». Un badge « Prêt » confirme que tout fonctionne.</li>
          </ol>
        </Notice>

        <Notice tone="info" title="Vos clés restent sur cette machine">
          Les jetons sont enregistrés chiffrés (DPAPI) et ne sont jamais renvoyés à l’interface. Créez-les vous-même chez chaque fournisseur ; MAZZ ne demande jamais votre mot de passe.
        </Notice>

        <Section
          title="Hugging Face"
          subtitle="Télécharger des modèles, envoyer un modèle vers un GPU distant. Un compte gratuit et un jeton de lecture suffisent."
          ids={['huggingface']}
          cat={cat}
        />
        <Section
          title="GPU gratuit"
          subtitle="Kaggle, Colab et Modal prêtent un GPU selon leur quota. Aucune carte bancaire pour les offres gratuites."
          ids={['kaggle', 'colab', 'modal']}
          cat={cat}
        />
        <Section
          title="API de modèles rapides"
          subtitle="Utile quand le modèle local est trop lent ou absent. Les offres gratuites ont un quota ; vérifiez-le avant de vous engager."
          ids={['groq', 'openrouter', 'mistral', 'ovh-ai']}
          cat={cat}
        />

        <Card title="Besoin d’un autre service ?">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-[12.5px] text-muted flex-1 min-w-[260px]">
              Le catalogue complet contient 164 services (bases de données, recherche, hébergement, paiement, etc.), filtrables par objectif et par gratuité.
            </p>
            <Button size="sm" variant="secondary" onClick={() => navigate('services', 'all')}>
              Ouvrir le catalogue complet
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
