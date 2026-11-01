import { useState } from 'react';
import { errorMessage } from '../../lib/api';
import { saveSettings, toast, useApp } from '../../lib/store';
import { Badge, Button, Card } from '../../components/ui';

// Mirrors the RANGES of models.parallel / models.contextSize in packages/core/src/settings.ts.
const CTX_MIN = 256;
const CTX_MAX = 262144;
export const FORGE_SLOTS = 4;

/** Slots and total context so that each slot keeps at least `ctx / parallel` tokens (capped by validation). */
export function slotPreset(current: { parallel: number; contextSize: number }, slots: number): { parallel: number; contextSize: number } {
  const perSlot = Math.floor(current.contextSize / Math.max(1, current.parallel));
  return { parallel: slots, contextSize: Math.min(CTX_MAX, Math.max(CTX_MIN, perSlot * slots)) };
}

/** One-click switch between 1 slot and the Forge preset (4 parallel slots). */
export function ForgePresetCard() {
  const models = useApp((s) => s.settings?.models);
  const [busy, setBusy] = useState(false);
  if (!models) return null;
  const forge = models.parallel === FORGE_SLOTS;
  const target = slotPreset(models, forge ? 1 : FORGE_SLOTS);
  const perSlot = Math.floor(models.contextSize / Math.max(1, models.parallel));
  const apply = async () => {
    setBusy(true);
    try {
      await saveSettings({ models: target });
      toast('good', forge ? 'Retour à 1 slot' : 'Préréglage Forge appliqué', 'Démarrez ou redémarrez le modèle pour l’appliquer.');
    } catch (e) {
      toast('bad', 'Enregistrement impossible', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title="Préréglage Forge"
      subtitle="Le mode Forge échantillonne plusieurs candidats en parallèle via les slots de llama-server."
      actions={<Badge tone={forge ? 'brand' : 'neutral'}>{models.parallel} slot(s), {perSlot} tokens par slot</Badge>}
    >
      <div className="space-y-2 text-[12.5px] text-muted">
        <p>
          Mesuré sur cette machine avec Qwen3 0.6B : 1 slot = 35 tok/s, 4 slots en parallèle = 95 tok/s au total (source : forge benchmark 2026-10-25). Chaque slot reçoit contexte / slots ; le contexte total est donc multiplié pour garder au moins le contexte actuel par slot{target.contextSize === CTX_MAX && !forge ? ` (plafonné à ${CTX_MAX})` : ''}.
        </p>
        <p className="text-faint">Le modèle doit être démarré ou redémarré pour que le changement s’applique.</p>
        <Button size="sm" variant={forge ? 'secondary' : 'primary'} loading={busy} onClick={apply}>
          {forge ? `Revenir à 1 slot (contexte ${target.contextSize})` : `Appliquer : ${FORGE_SLOTS} slots, contexte ${target.contextSize}`}
        </Button>
      </div>
    </Card>
  );
}
