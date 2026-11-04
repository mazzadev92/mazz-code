import { useState } from 'react';
import { Check, Cloud, Cpu, Shuffle } from 'lucide-react';
import { saveSettings, toast, navigate, useApp } from '../../lib/store';
import { api, errorMessage } from '../../lib/api';
import type { Doctor } from '../../lib/types';
import { Button, Card, cx } from '../../components/ui';
import { PathPicker } from '../../components/overlays';

type Choice = 'local' | 'api' | 'hybrid';

/**
 * First-run assistant. Every step calls the real backend; nothing is downloaded.
 * It can be skipped and reopened from Settings.
 */
export function Onboarding({ doctor, onChanged }: { doctor?: Doctor; onChanged: () => void }) {
  const settings = useApp((s) => s.settings);
  const [step, setStep] = useState(0);
  const [choice, setChoice] = useState<Choice>(settings?.ai.executionMode === 'local_strict' ? 'local' : 'hybrid');
  const [picker, setPicker] = useState<'exe' | 'gguf' | null>(null);
  const [busy, setBusy] = useState(false);

  const finish = async () => {
    await saveSettings({ general: { onboardingDone: true } });
    toast('good', 'Configuration enregistrée', 'Vous pouvez relancer l’assistant depuis les paramètres.');
  };

  const steps = ['Mode de calcul', 'Moteur local', 'Premier modèle', 'Terminer'];
  const llamaFound = doctor ? doctor.llamaServer.discovered.length > 0 || !!doctor.llamaServer.configuredPath : false;

  return (
    <Card
      title="Assistant de première configuration"
      subtitle="Quatre étapes, toutes facultatives. Aucun modèle n’est téléchargé."
      actions={
        <Button size="xs" variant="ghost" onClick={() => void finish()}>
          Passer
        </Button>
      }
    >
      <ol className="flex gap-2 mb-4" aria-label="Étapes">
        {steps.map((s, i) => (
          <li key={s} className={cx('flex-1 h-1 rounded-full', i <= step ? 'bg-brand' : 'bg-line')} aria-current={i === step ? 'step' : undefined}>
            <span className="sr-only">{s}</span>
          </li>
        ))}
      </ol>
      {step === 0 && (
        <div className="space-y-3">
          <p className="text-[13px] text-muted">Où les modèles doivent-ils s’exécuter ?</p>
          <div className="grid sm:grid-cols-3 gap-2">
            {[
              { id: 'local' as Choice, icon: <Cpu className="w-4 h-4" />, title: 'Local strict', text: 'llama.cpp sur cette machine. Aucune requête réseau externe.' },
              { id: 'hybrid' as Choice, icon: <Shuffle className="w-4 h-4" />, title: 'Hybride', text: 'Local par défaut, fournisseurs API autorisés avec confirmation.' },
              { id: 'api' as Choice, icon: <Cloud className="w-4 h-4" />, title: 'API', text: 'Gemini, Claude, OpenAI, Groq, DeepSeek avec vos clés.' },
            ].map((c) => (
              <button key={c.id} type="button" aria-pressed={choice === c.id} onClick={() => setChoice(c.id)} className={cx('text-left p-3 rounded-[var(--radius-md)] border cursor-pointer transition-colors', choice === c.id ? 'border-brand bg-brand/5' : 'border-line bg-sunk hover:border-line-strong')}>
                <div className="flex items-center gap-2 text-[13px] text-fg font-medium">
                  {c.icon}
                  {c.title}
                </div>
                <p className="text-[12px] text-muted mt-1">{c.text}</p>
              </button>
            ))}
          </div>
          <div className="flex justify-end">
            <Button
              variant="primary"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await saveSettings({ ai: { executionMode: choice === 'local' ? 'local_strict' : 'hybrid_opt_in' } });
                  setStep(choice === 'api' ? 3 : 1);
                } catch (e) {
                  toast('bad', 'Enregistrement impossible', errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Continuer
            </Button>
          </div>
        </div>
      )}
      {step === 1 && (
        <div className="space-y-3">
          <p className="text-[13px] text-muted">Exécutables llama-server détectés (PATH, paramètres, dossier runtime) :</p>
          {doctor?.llamaServer.discovered.length ? (
            <ul className="space-y-1">
              {doctor.llamaServer.discovered.map((p) => (
                <li key={p} className="flex items-center gap-2 text-[12px]">
                  <span className="font-mono truncate flex-1">{p}</span>
                  <Button
                    size="xs"
                    variant={settings?.models.llamaServerPath === p ? 'primary' : 'secondary'}
                    icon={settings?.models.llamaServerPath === p ? <Check className="w-3 h-3" /> : undefined}
                    onClick={() => saveSettings({ models: { llamaServerPath: p } }).then(onChanged)}
                  >
                    {settings?.models.llamaServerPath === p ? 'Utilisé' : 'Utiliser'}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12.5px] text-warn">Aucun llama-server trouvé. Indiquez le chemin de llama-server.exe (build llama.cpp) ou renseignez le dossier runtime dans les paramètres.</p>
          )}
          <div className="flex justify-between">
            <Button variant="secondary" onClick={() => setPicker('exe')}>
              Choisir llama-server.exe
            </Button>
            <Button variant="primary" onClick={() => setStep(2)} disabled={!llamaFound && !settings?.models.llamaServerPath}>
              Continuer
            </Button>
          </div>
        </div>
      )}
      {step === 2 && (
        <div className="space-y-3">
          <p className="text-[13px] text-muted">Ajoutez un fichier .gguf existant. Il reste à son emplacement ; seuls ses en-têtes sont lus.</p>
          <p className="text-[12px] text-faint">Bibliothèque actuelle : {settings?.models.library.length ?? 0} modèle(s).</p>
          <div className="flex justify-between">
            <Button variant="secondary" onClick={() => setPicker('gguf')}>
              Ajouter un fichier GGUF
            </Button>
            <Button variant="primary" onClick={() => setStep(3)}>
              Continuer
            </Button>
          </div>
        </div>
      )}
      {step === 3 && (
        <div className="space-y-3">
          <p className="text-[13px] text-muted">Dernière étape : chargez le modèle et testez-le dans le Model Hub, ou connectez des services gratuits (Hugging Face pour télécharger des modèles, Kaggle ou Modal pour un GPU, des IA par API). Chaque service est expliqué pas à pas.</p>
          <div className="flex gap-2 justify-end">
            <Button onClick={() => navigate('services')}>Services gratuits</Button>
            <Button onClick={() => navigate('providers')}>Fournisseurs API</Button>
            <Button onClick={() => navigate('models')}>Model Hub</Button>
            <Button variant="primary" onClick={() => void finish()}>
              Terminer
            </Button>
          </div>
        </div>
      )}
      <PathPicker
        open={picker !== null}
        mode="file"
        ext={picker === 'exe' ? '.exe' : '.gguf'}
        title={picker === 'exe' ? 'Choisir llama-server.exe' : 'Choisir un modèle GGUF'}
        onClose={() => setPicker(null)}
        onPick={async (p) => {
          try {
            if (picker === 'exe') await saveSettings({ models: { llamaServerPath: p } });
            else {
              await api.post('/api/models/library', { path: p });
              await saveSettings({});
            }
            toast('good', picker === 'exe' ? 'Exécutable enregistré' : 'Modèle ajouté', p);
            onChanged();
          } catch (e) {
            toast('bad', 'Ajout impossible', errorMessage(e));
          }
        }}
      />
    </Card>
  );
}
