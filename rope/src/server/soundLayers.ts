import type { Plugin } from 'vite';
import { createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { allSlotKeys } from '../audio/slots';
import { validateProject, type LayerCatalog, type LayerProject } from '../audio/layerProject';
export function soundLayerService(): Plugin {
    return { name: 'sound-layer-service', apply: 'serve', configureServer(server) {
            const dir = join(server.config.root, 'tools/audio');
            const file = join(dir, 'layer-projects.json');
            const read = (): LayerCatalog => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1, sources: [], projects: [] };
            const save = (catalog: LayerCatalog) => {
                const temp = file + '.tmp';
                writeFileSync(temp, JSON.stringify(catalog, null, 2) + '\n');
                renameSync(temp, file);
            };
            server.middlewares.use('/api/sound-layers', async (req, res) => {
                const send = (code: number, body: unknown) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
                try {
                    const url = new URL(req.url ?? '/', 'http://local');
                    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`)
                        return send(403, { error: 'Use this editor’s origin.' });
                    if (req.method === 'GET' && url.pathname === '/')
                        return send(200, read());
                    if (req.method === 'GET' && url.pathname === '/file') {
                        const catalog = read();
                        const source = catalog.sources.find(s => s.id === url.searchParams.get('id'));
                        if (!source)
                            return send(404, { error: 'Unknown source' });
                        const target = realpathSync(resolve(dir, source.file));
                        if (!['sources', 'out', 'layer-uploads'].some(d => target.startsWith(realpathSync(join(dir, d)) + sep)))
                            return send(403, { error: 'Source outside audio workspace' });
                        res.setHeader('Content-Type', ({ '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.aiff': 'audio/aiff' } as Record<string, string>)[extname(target)] ?? 'application/octet-stream');
                        res.setHeader('Content-Length', statSync(target).size);
                        res.setHeader('Cache-Control', 'no-cache');
                        createReadStream(target).on('error', () => res.destroy()).pipe(res);
                        return;
                    }
                    if (req.method !== 'PUT' && req.method !== 'POST')
                        return send(405, { error: 'Method not allowed' });
                    const chunks: Buffer[] = [];
                    let bytes = 0;
                    for await (const chunk of req) {
                        bytes += chunk.length;
                        if (bytes > 64 * 1024 * 1024)
                            return send(413, { error: 'Audio upload limit is 64 MB' });
                        chunks.push(Buffer.from(chunk));
                    }
                    const body = Buffer.concat(chunks);
                    const catalog = read();
                    if (req.method === 'PUT' && url.pathname === '/project') {
                        const project = JSON.parse(body.toString()) as LayerProject;
                        validateProject(project, catalog.sources);
                        if (!allSlotKeys().includes(project.slot))
                            throw Error('Unknown sound event');
                        const index = catalog.projects.findIndex(p => p.id === project.id);
                        if (index < 0)
                            catalog.projects.push(project);
                        else
                            catalog.projects[index] = project;
                        save(catalog);
                        return send(200, { ok: true });
                    }
                    if (req.method === 'POST' && url.pathname === '/source') {
                        const name = (url.searchParams.get('name') ?? 'Recording').slice(0, 200);
                        const id = 'import-' + createHash('sha256').update(body).digest('hex').slice(0, 16);
                        const existing = catalog.sources.find(s => s.id === id);
                        if (existing)
                            return send(200, existing);
                        const uploads = join(dir, 'layer-uploads');
                        mkdirSync(uploads, { recursive: true });
                        const ext = ['.wav', '.mp3', '.ogg', '.flac', '.aif', '.aiff'].includes(extname(name).toLowerCase()) ? extname(name).toLowerCase() : '.wav';
                        const target = join(uploads, id + ext);
                        writeFileSync(target, body);
                        const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', target], { encoding: 'utf8', timeout: 10000 });
                        const seconds = Number(probe.stdout?.trim());
                        if (probe.status !== 0 || !(seconds > 0) || seconds > 600)
                            throw Error('Use an audio recording up to ten minutes long');
                        const source = { id, name, file: 'layer-uploads/' + id + ext, seconds, source: 'User import: ' + name, author: '', license: '' };
                        catalog.sources.push(source);
                        save(catalog);
                        return send(200, source);
                    }
                    send(404, { error: 'Unknown layer-editor endpoint' });
                }
                catch (e) {
                    send(400, { error: e instanceof Error ? e.message : String(e) });
                }
            });
        } };
}
