// Serveur MCP de Binôme, lancé par Claude Desktop ou Claude Code (transport stdio).
//   ELECTRON_RUN_AS_NODE=1 Binome.exe mcp.mjs --data <dossier des données de l'app>
// Il ne lit rien sur le disque lui-même : chaque appel est transmis à l'app ouverte,
// qui vérifie les droits, demande confirmation si besoin et tient le journal.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PipeClient, pipePath, readToken } from './pipe.ts';
import { errorResult, registerTools, type ToolName } from './tools.ts';

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const dataDir = argValue('--data');
if (!dataDir) {
  process.stderr.write('Utilisation : mcp.mjs --data <dossier des données de Binôme>\n');
  process.exit(2);
}

const client = new PipeClient(pipePath(dataDir), () => readToken(dataDir));

// Outils autorisés dans l'app. App fermée ou Claude pas encore autorisé : on les déclare tous,
// et chaque appel répond ce qu'il faut faire.
const listed = await client.request({ op: 'list' }, 5_000);
const enabled = listed.ok && listed.enabled && listed.enabled.length > 0 ? new Set<ToolName>(listed.enabled) : null;

const server = new McpServer(
  { name: 'binome', version: '1.0.0' },
  {
    instructions:
      'Binôme garde un dossier identique sur deux PC, entre deux personnes. Ces outils agissent seulement sur le PC ' +
      'de l’utilisateur : son dossier partagé, son historique, son chat. Restaurer une version ou envoyer un fichier ' +
      'hors du dossier partagé demande sa confirmation dans l’app.',
  },
);

registerTools(
  server,
  async (name, args) => {
    const r = await client.request({ op: 'call', tool: name, args });
    if (!r.ok) return errorResult(r.error);
    return r.result ?? errorResult('Réponse vide de Binôme');
  },
  (name) => (enabled ? enabled.has(name) : true),
);

await server.connect(new StdioServerTransport());

const shutdown = () => {
  client.close();
  process.exit(0);
};
process.stdin.on('close', shutdown);
process.on('SIGTERM', shutdown);
