import { useState } from 'react';
import { ChevronDown, ChevronRight } from '../../components/icons';
import { Badge, Button, Notice } from '../../components/ui';
import { ServiceGuide } from '../services/ServiceGuide';
import { CATEGORY_LABELS, type ServiceEntry } from '../services/services-format';
import { Term } from './Term';
import { suggestServices } from './logic';
import type { ServiceCatalog } from './useServiceCatalog';

/** Fiche de service repliable ; le guide complet (inscription, jeton, test) est celui de la page Services. */
function ServiceAccordion({ service, cat }: { service: ServiceEntry; cat: ServiceCatalog }) {
  const [open, setOpen] = useState(false);
  const target = cat.targetOf(service);
  const state = target.kind === 'compute' ? cat.states[target.id] : undefined;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li className="rounded-[var(--radius-md)] border border-line bg-sunk">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="w-full flex flex-wrap items-center gap-2 px-3 py-2 text-left cursor-pointer">
        <Chevron className="w-3.5 h-3.5 text-faint" />
        <span className="font-medium text-fg text-[13px]">{service.name}</span>
        <Badge>{CATEGORY_LABELS[service.category] ?? service.category}</Badge>
        {service.requires_card === false && <Badge tone="good">Sans carte bancaire</Badge>}
        {service.requires_card === true && <Badge tone="warn">Carte bancaire requise</Badge>}
        {state?.ok && <Badge tone="good">Prêt</Badge>}
        <span className="ml-auto text-[12px] text-faint truncate max-w-[50%]">{service.free_tier}</span>
      </button>
      {open && <div className="px-3 pb-3 pt-2 border-t border-line"><ServiceGuide service={service} target={target} state={state} onChanged={cat.reload} /></div>}
    </li>
  );
}

function Missing({ cat, ids }: { cat: ServiceCatalog; ids: string[] }) {
  if (cat.error) return <Notice tone="warn" title="Catalogue indisponible">Le catalogue des services n’a pas pu être chargé. Vous pourrez reprendre cette étape plus tard depuis la page Services.</Notice>;
  if (!cat.services) return <p className="text-[12.5px] text-faint">Chargement du catalogue…</p>;
  return <p className="text-[12.5px] text-faint">Fiche introuvable dans le catalogue ({ids.join(', ')}). Consultez la page Services.</p>;
}

export function StepHuggingFace({ cat }: { cat: ServiceCatalog }) {
  const hf = cat.services?.find((s) => s.id === 'huggingface');
  return (
    <div className="space-y-3 text-[12.5px]">
      <Notice tone="good" title="Modèles MAZZ inclus d'office">
        Les modèles souverains MAZZ sont 100% publics et téléchargeables en 1 clic dans l’onglet Modèles sans compte ni jeton. Ce jeton n’est utile que si vous voulez utiliser des modèles sous licence fermée ou vos propres dépôts privés.
      </Notice>
      <p className="text-muted"><Term id="huggingface" /> sert à télécharger des modèles sans les stocker à la main, et à les envoyer sur un GPU distant. Créez un jeton de lecture (Read) ; le droit d’écriture (Write) n’est utile que pour envoyer vos propres modèles. Ce <Term id="cle">jeton</Term> est enregistré chiffré, sur cette machine.</p>
      {hf ? <ServiceGuide service={hf} target={cat.targetOf(hf)} state={cat.states[hf.provider_id ?? hf.id]} onChanged={cat.reload} /> : <Missing cat={cat} ids={['huggingface']} />}
    </div>
  );
}

export function StepGpu({ cat }: { cat: ServiceCatalog }) {
  const list = (['kaggle', 'colab', 'modal'] as const).map((id) => cat.services?.find((s) => s.id === id)).filter((s): s is ServiceEntry => !!s);
  return (
    <div className="space-y-3 text-[12.5px]">
      <Notice tone="good" title="Sans carte bancaire (recommandé pour débuter et ados)">
        Kaggle et Google Colab sont 100 % gratuits et ne demandent aucune carte bancaire à l’inscription. Modal offre 30 $/mois de crédit mais exige une carte bancaire pour vérifier l’identité.
      </Notice>
      <Notice tone="info" title="GPU gratuit : astuce Kaggle">
        Kaggle offre environ 30 h de GPU gratuit par semaine (T4 x2). Pensez impérativement à valider votre numéro de téléphone (SMS) dans Settings &gt; Phone Verification sur kaggle.com, sinon l’accès GPU reste bloqué. Espace disque éphémère : ~20 Go.
      </Notice>
      <p className="text-muted">Ces services prêtent un <Term id="gpu" /> gratuitement : <Term id="kaggle" /> et <Term id="colab" /> sans carte bancaire, <Term id="modal" /> avec carte bancaire. Déportez vos calculs lourds (modèles 32B ou 70B) sans solliciter votre machine locale.</p>
      <ul className="space-y-2">{list.map((s) => <ServiceAccordion key={s.id} service={s} cat={cat} />)}</ul>
      {!list.length && <Missing cat={cat} ids={['kaggle', 'colab', 'modal']} />}
    </div>
  );
}

export function StepOthers({ cat, goals, onOpenServices }: { cat: ServiceCatalog; goals: string[]; onOpenServices: () => void }) {
  const list = suggestServices(cat.services ?? [], goals, 8);
  return (
    <div className="space-y-3 text-[12.5px]">
      <p className="text-muted">Services filtrés selon vos objectifs (« gratuit sans carte bancaire » en premier). Chacun demande un compte et une <Term id="cle">clé API</Term> que vous créez vous-même.</p>
      <ul className="space-y-2">{list.map((s) => <ServiceAccordion key={s.id} service={s} cat={cat} />)}</ul>
      {cat.services && !list.length && <p className="text-faint">Aucun service ne correspond à vos objectifs dans le catalogue.</p>}
      {(cat.error || !cat.services) && <Missing cat={cat} ids={[]} />}
      <Button size="sm" variant="secondary" onClick={onOpenServices}>Voir tous les services</Button>
    </div>
  );
}
