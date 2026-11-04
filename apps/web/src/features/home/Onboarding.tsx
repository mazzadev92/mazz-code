import { useEffect, useState } from 'react';
import { saveSettings, toast, navigate, useApp } from '../../lib/store';
import { errorMessage } from '../../lib/api';
import type { Doctor } from '../../lib/types';
import { Button, Card, cx } from '../../components/ui';
import { readGoals, readStep, writeGoals, writeStep } from '../setup/logic';
import { useServiceCatalog } from '../setup/useServiceCatalog';
import { StepComputer, StepGoals, StepModels, StepStorage, StepWelcome } from '../setup/StepsBasic';
import { StepGpu, StepHuggingFace, StepOthers } from '../setup/StepsServices';
import { StepFinalTest, StepSecurity } from '../setup/StepsFinal';

const TITLES = ['Bienvenue', 'Votre ordinateur', 'Où stocker les données', 'Que voulez-vous faire ?', 'Modèles locaux', 'Hugging Face', 'Calcul GPU gratuit', 'Autres services', 'Sécurité et confiance', 'Test final'];

/**
 * First-run assistant (10 steps, spec: docs/setup/ASSISTANT_PREMIER_LANCEMENT.md). Every step is optional,
 * the current step survives navigation, and it can be reopened from Settings.
 */
export function Onboarding({ doctor, onChanged }: { doctor?: Doctor; onChanged: () => void }) {
  const dataDir = useApp((s) => s.health?.dataDir);
  const [step, setStep] = useState(() => readStep(TITLES.length));
  const [goals, setGoals] = useState<string[]>(readGoals);
  const [busy, setBusy] = useState(false);
  const cat = useServiceCatalog();
  const ready = Object.entries(cat.states).filter(([, s]) => s.ok).map(([id]) => id);
  const last = step === TITLES.length - 1;

  useEffect(() => writeStep(step), [step]);
  const changeGoals = (g: string[]) => { setGoals(g); writeGoals(g); };

  const finish = async () => {
    setBusy(true);
    try {
      await saveSettings({ general: { onboardingDone: true } });
      writeStep(0);
      toast('good', 'Assistant terminé', 'Vous pouvez le relancer depuis Paramètres, section Général.');
    } catch (e) {
      toast('bad', 'Enregistrement impossible', errorMessage(e));
    } finally { setBusy(false); }
  };
  const go = (to: string) => navigate(to as Parameters<typeof navigate>[0]);

  return (
    <Card
      title="Assistant de première configuration"
      subtitle={`Étape ${step + 1} sur ${TITLES.length} : ${TITLES[step]}. Tout est facultatif.`}
      actions={<Button size="xs" variant="ghost" loading={busy} onClick={() => void finish()}>Tout passer</Button>}
    >
      <ol className="flex gap-1.5 mb-4" aria-label="Progression">
        {TITLES.map((t, i) => (
          <li key={t} className={cx('flex-1 h-1 rounded-full', i <= step ? 'bg-brand' : 'bg-line')} aria-current={i === step ? 'step' : undefined}>
            <span className="sr-only">{t}</span>
          </li>
        ))}
      </ol>
      <div className="min-h-[140px]">
        {step === 0 && <StepWelcome />}
        {step === 1 && <StepComputer doctor={doctor} />}
        {step === 2 && <StepStorage dataDir={dataDir} />}
        {step === 3 && <StepGoals goals={goals} onChange={changeGoals} />}
        {step === 4 && <StepModels onNavigate={() => go('models')} onChanged={onChanged} />}
        {step === 5 && <StepHuggingFace cat={cat} />}
        {step === 6 && <StepGpu cat={cat} />}
        {step === 7 && <StepOthers cat={cat} goals={goals} onOpenServices={() => go('services')} />}
        {step === 8 && <StepSecurity />}
        {step === 9 && <StepFinalTest recap={[
          `${doctor?.library.count ?? 0} modèle(s) local(aux) dans la bibliothèque`,
          ready.length ? `Services prêts : ${ready.join(', ')}` : 'Aucun service en ligne configuré (facultatif, reprenez-les dans Services)',
        ]} />}
      </div>
      <div className="flex items-center justify-between mt-4 pt-3 border-t border-line">
        <Button size="sm" variant="ghost" disabled={step === 0} onClick={() => setStep(step - 1)}>Précédent</Button>
        <div className="flex gap-2">
          {step > 0 && !last && <Button size="sm" variant="ghost" onClick={() => setStep(step + 1)}>Passer cette étape</Button>}
          {last
            ? <Button size="sm" variant="primary" loading={busy} onClick={() => void finish()}>Terminer</Button>
            : <Button size="sm" variant="primary" onClick={() => setStep(step + 1)}>{step === 0 ? 'Commencer' : 'Suivant'}</Button>}
        </div>
      </div>
    </Card>
  );
}
