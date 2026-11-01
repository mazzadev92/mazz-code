import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Code2,
  GitPullRequest,
  RefreshCw,
  ToggleLeft,
  ToggleRight,
} from 'lucide-react';
import { navigate, toast } from '../../lib/store';
import { Button, Badge } from '../../components/ui';

interface TokenSegment {
  label: string;
  tokens: number;
  pct: number;
  color: string;
}

export function MazzContextInspector() {

  const [remoteControl, setRemoteControl] = useState(true);
  const [activeWorkspace, setActiveWorkspace] = useState<'mazz-code' | 'mazz-gpu' | 'mazz-reverse' | 'mazz-models'>('mazz-code');
  const [compacting, setCompacting] = useState(false);

  // Accordion states
  const [mcpOpen, setMcpOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [connectorsOpen, setConnectorsOpen] = useState(false);

  const usedPct = 62;

  const segments: TokenSegment[] = [
    { label: 'Messages', tokens: 545800, pct: 54.6, color: '#3b82f6' },
    { label: 'System tools', tokens: 18100, pct: 1.8, color: '#f97316' },
    { label: 'MCP tools', tokens: 15900, pct: 1.6, color: '#94b89a' },
    { label: 'Skills', tokens: 13300, pct: 1.3, color: '#c9a57a' },
    { label: 'System prompt', tokens: 10500, pct: 1.1, color: '#a855f7' },
    { label: 'Custom agents', tokens: 9400, pct: 0.9, color: '#ec4899' },
    { label: 'MCP server instructions', tokens: 5800, pct: 0.6, color: '#06b6d4' },
    { label: 'Memory files', tokens: 937, pct: 0.1, color: '#ebe5d8' },
    { label: 'Autocompact buffer', tokens: 33000, pct: 3.3, color: '#64748b' },
    { label: 'Free space', tokens: 347300, pct: 34.7, color: '#1d2a22' },
  ];

  const recentFiles = [
    { name: 'workspace-tools.ts', path: 'packages/tools/src/workspace-tools.ts' },
    { name: 'modal_mazz_coder32b.py', path: 'mazz_control/modal_mazz_coder32b.py' },
    { name: 'QuotasView.tsx', path: 'apps/web/src/features/quotas/QuotasView.tsx' },
    { name: 'quotas.py', path: 'mazz_control/core/quotas.py' },
    { name: 'GATES.md', path: 'GATES.md' },
  ];

  const mazzAgents = [
    'mazz-lead-programmer',
    'mazz-engine-programmer',
    'mazz-technical-director',
    'mazz-security-engineer',
    'mazz-tools-programmer',
    'mazz-godot-specialist',
    'mazz-systems-designer',
    'mazz-gameplay-programmer',
    'mazz-ai-programmer',
  ];

  const handleCompact = () => {
    setCompacting(true);
    setTimeout(() => {
      setCompacting(false);
      toast('info', 'Compaction du contexte MAZZ effectuée : mémoire optimisée');
    }, 1200);
  };

  const handleCreatePR = () => {
    toast('good', 'Revue et commit MAZZ initiés pour la branche courante');
  };

  return (
    <div className="h-full flex flex-col min-h-0 text-[12px] select-none overflow-y-auto bg-obsidian-surface border-l border-line">
      {/* 1. Section Environnement MAZZ Souverain */}
      <div className="p-3 border-b border-line/70 space-y-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-faint flex items-center justify-between">
          <span>Piliers MAZZ</span>
          <span className="text-[10px] text-sage font-mono">ACTIF</span>
        </div>
        <div className="space-y-1">
          <label className="flex items-center gap-2 px-2 py-1 rounded hover:bg-raised/50 cursor-pointer text-fg text-[12px]">
            <input
              type="radio"
              name="workspace"
              checked={activeWorkspace === 'mazz-code'}
              onChange={() => setActiveWorkspace('mazz-code')}
              className="accent-sage"
            />
            <span className="font-mono text-fg font-medium">Mazz Code (D:\Mazz Code)</span>
          </label>
          <label className="flex items-center gap-2 px-2 py-1 rounded hover:bg-raised/50 cursor-pointer text-muted text-[12px]">
            <input
              type="radio"
              name="workspace"
              checked={activeWorkspace === 'mazz-gpu'}
              onChange={() => setActiveWorkspace('mazz-gpu')}
              className="accent-sage"
            />
            <span className="font-mono">MAZZ GPU ACX (D:\MAZZ GPU ACX)</span>
          </label>
          <label className="flex items-center gap-2 px-2 py-1 rounded hover:bg-raised/50 cursor-pointer text-muted text-[12px]">
            <input
              type="radio"
              name="workspace"
              checked={activeWorkspace === 'mazz-reverse'}
              onChange={() => setActiveWorkspace('mazz-reverse')}
              className="accent-sage"
            />
            <span className="font-mono">MAZZ Reverse Engine (D:\MAZZ_REVERSE_ENGINE)</span>
          </label>
          <label className="flex items-center gap-2 px-2 py-1 rounded hover:bg-raised/50 cursor-pointer text-muted text-[12px]">
            <input
              type="radio"
              name="workspace"
              checked={activeWorkspace === 'mazz-models'}
              onChange={() => setActiveWorkspace('mazz-models')}
              className="accent-sage"
            />
            <span className="font-mono">Models Locaux (D:\Models Locaux)</span>
          </label>
        </div>

        {/* Remote Control Switch */}
        <div className="pt-2 flex items-center justify-between border-t border-line/40">
          <div className="flex flex-col">
            <span className="text-muted text-[12px]">Routage Distant (Modal 32B)</span>
            <span className="text-[10px] text-faint">Bascule automatique si VRAM saturée</span>
          </div>
          <button
            type="button"
            onClick={() => setRemoteControl(!remoteControl)}
            className="cursor-pointer text-sage hover:text-champagne transition-colors"
            title="Activer / Désactiver le routage distant"
          >
            {remoteControl ? (
              <ToggleRight className="w-6 h-6 text-sage" />
            ) : (
              <ToggleLeft className="w-6 h-6 text-faint" />
            )}
          </button>
        </div>
      </div>

      {/* 2. Section Contexte (Jauge 1M Tokens & Quotas MAZZ) */}
      <div className="p-3 border-b border-line/70 space-y-2.5">
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">Contexte MAZZ</span>
          <span className="text-[12px] font-mono text-muted">
            <strong className="text-fg">{usedPct}%</strong> utilisé ·{' '}
            <span className="text-champagne font-semibold">619.7k</span> / 1M
          </span>
        </div>

        {/* Stacked Multi-Color Progress Bar */}
        <div className="w-full h-2 rounded-full overflow-hidden flex bg-line">
          {segments.map((seg) => (
            <div
              key={seg.label}
              style={{ width: `${seg.pct}%`, backgroundColor: seg.color }}
              title={`${seg.label}: ${(seg.tokens / 1000).toFixed(1)}k (${seg.pct}%)`}
              className="h-full transition-all"
            />
          ))}
        </div>

        {/* Legend Grid */}
        <div className="space-y-1 text-[11px] pt-1">
          {segments.slice(0, 10).map((seg) => (
            <div key={seg.label} className="flex items-center justify-between text-muted hover:text-fg transition-colors">
              <span className="flex items-center gap-1.5 truncate">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: seg.color }} />
                <span className="truncate">{seg.label}</span>
              </span>
              <span className="font-mono text-faint tabular-nums shrink-0">
                {seg.tokens >= 1000 ? `${(seg.tokens / 1000).toFixed(1)}k` : seg.tokens}{' '}
                <span className="text-[10px] text-faint">({seg.pct.toFixed(1).replace('.', ',')}%)</span>
              </span>
            </div>
          ))}
        </div>

        {/* Deferred Stats */}
        <div className="pt-2 border-t border-line/40 space-y-1 text-[11px] text-faint font-mono">
          <div className="flex justify-between">
            <span>Outils différés (MCP deferred)</span>
            <span>206.2k</span>
          </div>
          <div className="flex justify-between">
            <span>Outils système (Harnais deferred)</span>
            <span>23.2k</span>
          </div>
        </div>

        {/* Accordions Outils MCP, Mémoire, Agents MAZZ */}
        <div className="pt-2 space-y-1">
          {/* MCP Tools */}
          <div className="border border-line/50 rounded overflow-hidden">
            <button
              type="button"
              onClick={() => setMcpOpen(!mcpOpen)}
              className="w-full flex items-center justify-between px-2 py-1.5 bg-raised/30 hover:bg-raised text-[11.5px] cursor-pointer text-muted hover:text-fg"
            >
              <span className="flex items-center gap-1.5 font-medium">
                {mcpOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                Outils MCP Actifs
              </span>
              <Badge tone="brand">385</Badge>
            </button>
            {mcpOpen && (
              <div className="p-2 bg-sunk/60 text-[11px] space-y-1 font-mono text-faint">
                <div>mazz-reverse-engine (27 outils)</div>
                <div>godot-mcp-enhanced (112 outils)</div>
                <div>summer-engine-local (84 outils)</div>
                <div>godotlive (:8000/mcp)</div>
                <div>beckett (:8770/mcp)</div>
                <button
                  type="button"
                  onClick={() => navigate('tools')}
                  className="text-sage hover:underline pt-1 block"
                >
                  Gérer les serveurs d'outils →
                </button>
              </div>
            )}
          </div>

          {/* Fichiers Mémoire */}
          <div className="border border-line/50 rounded overflow-hidden">
            <button
              type="button"
              onClick={() => setMemoryOpen(!memoryOpen)}
              className="w-full flex items-center justify-between px-2 py-1.5 bg-raised/30 hover:bg-raised text-[11.5px] cursor-pointer text-muted hover:text-fg"
            >
              <span className="flex items-center gap-1.5 font-medium">
                {memoryOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                Mémoire Souveraine (Bib1 RAG)
              </span>
              <Badge tone="neutral">3</Badge>
            </button>
            {memoryOpen && (
              <div className="p-2 bg-sunk/60 text-[11px] space-y-1 font-mono text-faint">
                <div>Bib1 FTS5 (56 921 fragments indexés)</div>
                <div>Dossier maître architecture MAZZ</div>
                <div>Préférences studio locales</div>
              </div>
            )}
          </div>

          {/* Agents Personnalisés MAZZ */}
          <div className="border border-line/50 rounded overflow-hidden">
            <button
              type="button"
              onClick={() => setAgentsOpen(!agentsOpen)}
              className="w-full flex items-center justify-between px-2 py-1.5 bg-raised/30 hover:bg-raised text-[11.5px] cursor-pointer text-muted hover:text-fg"
            >
              <span className="flex items-center gap-1.5 font-medium">
                {agentsOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                Agents Studio MAZZ
              </span>
              <Badge tone="good">49</Badge>
            </button>
            {agentsOpen && (
              <div className="p-2 bg-sunk/60 text-[11px] space-y-1 font-mono text-faint max-h-36 overflow-y-auto">
                {mazzAgents.map((ag) => (
                  <div key={ag} className="truncate hover:text-fg cursor-pointer">
                    • {ag}
                  </div>
                ))}
                <div className="text-sage pt-1">+ 40 autres agents spécialisés</div>
              </div>
            )}
          </div>
        </div>

        {/* Bouton Compacter la session */}
        <div className="pt-2 flex flex-col gap-1.5">
          <div className="text-[10.5px] text-faint text-center">Gestion contextuelle active (G7)</div>
          <Button
            variant="ghost"
            size="sm"
            className="w-full border border-line hover:border-champagne/60 text-[11.5px]"
            onClick={handleCompact}
            disabled={compacting}
          >
            {compacting ? (
              <span className="flex items-center gap-1.5 text-champagne">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Compaction en cours...
              </span>
            ) : (
              'Compacter la session'
            )}
          </Button>
        </div>
      </div>

      {/* 3. Section Connecteurs */}
      <div className="p-3 border-b border-line/70">
        <button
          type="button"
          onClick={() => setConnectorsOpen(!connectorsOpen)}
          className="w-full flex items-center justify-between text-[11.5px] text-muted hover:text-fg cursor-pointer"
        >
          <span className="flex items-center gap-1.5 font-semibold uppercase tracking-wider text-faint text-[11px]">
            {connectorsOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            Connecteurs MAZZ
          </span>
          <span className="text-[11px] text-sage font-mono">Prêts & Sécurisés</span>
        </button>
        {connectorsOpen && (
          <div className="pt-2 text-[11px] space-y-1 text-faint">
            <p>Connecteurs locaux intégrés : MAZZ Reverse, Godot Runtime, vLLM / Modal 32B, Bib1 RAG SQLite.</p>
            <Button variant="ghost" size="xs" onClick={() => navigate('providers')} className="text-sage">
              Vérifier les fournisseurs →
            </Button>
          </div>
        )}
      </div>

      {/* 4. Section Fichiers Actifs de MAZZ Code */}
      <div className="p-3 border-b border-line/70 space-y-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-faint">Fichiers Actifs MAZZ</div>
        <div className="space-y-1">
          {recentFiles.map((rf) => (
            <button
              key={rf.path}
              type="button"
              onClick={() => navigate('code', rf.path)}
              className="w-full flex items-center gap-2 text-left text-[12px] hover:bg-raised/70 rounded px-1.5 py-1 cursor-pointer group transition-colors"
            >
              <Code2 className="w-3.5 h-3.5 text-sage shrink-0 group-hover:text-champagne" />
              <span className="font-mono text-fg truncate text-[11.5px]">{rf.name}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => navigate('code')}
          className="text-[11px] text-faint hover:text-sage transition-colors block pt-1"
        >
          Ouvrir l’explorateur de code →
        </button>
      </div>

      {/* 5. Section Modifications Git & Validation */}
      <div className="p-3 mt-auto bg-raised/20 border-t border-line space-y-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-faint">Diff Workspace</div>
        <div className="flex items-center justify-between gap-2">
          {/* Pill diff */}
          <div className="flex items-center gap-2 px-2 py-1 rounded bg-sunk border border-line text-[11.5px] font-mono tabular-nums">
            <span className="text-sage font-medium">+447 687</span>
            <span className="text-copper font-medium">-8 309</span>
          </div>

          {/* Bouton de Revue / PR */}
          <Button
            variant="primary"
            size="sm"
            onClick={handleCreatePR}
            icon={<GitPullRequest className="w-3.5 h-3.5" />}
            className="bg-leaf hover:bg-leaf/80 text-white font-medium text-[11.5px]"
          >
            Créer une PR
          </Button>
        </div>
      </div>
    </div>
  );
}
