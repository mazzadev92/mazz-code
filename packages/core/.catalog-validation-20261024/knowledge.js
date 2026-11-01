import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
export class LegacyKnowledgeManager {
    cfg;
    child;
    log = [];
    constructor(cfg) {
        this.cfg = cfg;
    }
    base() {
        return `http://127.0.0.1:${this.cfg().port}`;
    }
    available() {
        return existsSync(path.join(this.cfg().home, 'mazz_knowledge', '__main__.py'));
    }
    async health() {
        try {
            return (await fetch(`${this.base()}/search?q=test&k=1`, { signal: AbortSignal.timeout(2000) })).ok;
        }
        catch {
            return false;
        }
    }
    /** Starts `python -m mazz_knowledge serve` if nothing answers on the port. */
    async ensure() {
        if (await this.health())
            return true;
        if (!this.available() || this.child)
            return false;
        const c = this.cfg();
        // The Python setting may name the install folder rather than the executable.
        const python = resolvePython(c.python);
        const child = spawn(python, ['-m', 'mazz_knowledge', 'serve', '--port', String(c.port)], { cwd: c.home, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        this.child = child;
        const push = (d) => {
            for (const l of d.toString('utf-8').split(/\r?\n/))
                if (l.trim())
                    this.log.push(l.slice(0, 300));
            if (this.log.length > 100)
                this.log.splice(0, this.log.length - 100);
        };
        child.stdout?.on('data', push);
        child.stderr?.on('data', push);
        child.on('error', (err) => {
            this.log.push(`Lancement impossible (${python}) : ${err.message}`);
            if (this.child === child)
                this.child = undefined;
        });
        child.on('exit', () => {
            if (this.child === child)
                this.child = undefined;
        });
        for (let i = 0; i < 120; i++) {
            if (await this.health())
                return true;
            if (!this.child)
                return false;
            await new Promise((r) => setTimeout(r, 500));
        }
        return false;
    }
    status() {
        return { home: this.cfg().home, port: this.cfg().port, available: this.available(), ownedByStudio: !!this.child, log: this.log.slice(-20) };
    }
    async context(query, k = 3, budget = 2800) {
        if (!(await this.ensure()))
            return null;
        const qs = new URLSearchParams({ q: query.slice(0, 2000), k: String(k), budget: String(budget), hybrid: 'true', include_imports: 'false' });
        try {
            const r = await fetch(`${this.base()}/context?${qs}`, { signal: AbortSignal.timeout(8000) });
            return r.ok ? (await r.json()) : null;
        }
        catch {
            return null;
        }
    }
    /** The engine's own ITool adapter (integrations/knowledge-tool.mjs). */
    async loadTool() {
        const file = path.join(this.cfg().home, 'integrations', 'knowledge-tool.mjs');
        if (!existsSync(file))
            return null;
        const mod = (await import(pathToFileURL(file).href));
        const tool = new mod.KnowledgeSearchTool(this.base());
        const exec = tool.execute.bind(tool);
        // The engine is started on first use.
        tool.execute = async (p, c) => ((await this.ensure()) ? exec(p, c) : { success: false, output: null, error: 'Moteur de connaissances indisponible (Bib1).', durationMs: 0 });
        return tool;
    }
    stop() {
        if (this.child?.pid)
            spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true });
        this.child = undefined;
    }
}
/** The Python setting may name the install folder rather than the executable. */
export function resolvePython(p = 'python') {
    const exe = p || 'python';
    return !exe.toLowerCase().endsWith('.exe') && existsSync(path.join(exe, 'python.exe')) ? path.join(exe, 'python.exe') : exe;
}
export class KnowledgeManager extends LegacyKnowledgeManager {
}
