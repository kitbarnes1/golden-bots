// Fills in the Hugging Face Space page (space/index.html) from an exported dataset:
// the leaderboard snapshot and headline numbers, and the link to the dataset.
// Also copies the replay GIF next to it.
//
//   npm run export-dataset && npm run build-space
//   HF_DATASET_ID=you/golden-bots npm run build-space   # link to the dataset on Hugging Face
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { formatMoney, modelStandings, type GameRow, type MoveRow } from '@gb/shared';
import { GITHUB_REPO } from './links.js';

const { values: args } = parseArgs({
  options: {
    data: { type: 'string', default: 'dataset' },
    space: { type: 'string', default: 'space' },
  },
});
const dataDir = resolve(args.data);
const spaceDir = resolve(args.space);
const page = resolve(spaceDir, 'index.html');

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : 'n/a');

async function readJsonl<T>(file: string): Promise<T[]> {
  const text = await readFile(resolve(dataDir, file), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

function snapshot(games: GameRow[], moves: MoveRow[]): string {
  const claims = moves.filter((m) => m.move === 'claim');
  const lies = claims.filter((m) => m.truthful === false).length;
  const finalists = games.flatMap((g) => g.players.filter((p) => p.reached_final));
  const stole = finalists.filter((p) => p.final_choice === 'steal').length;
  const withThoughts = moves.filter((m) => m.thoughts).length;
  const exported = new Date().toISOString().slice(0, 10);

  const rows = modelStandings(games).map(
    (s, i) => `              <tr>
                <td class="rank">${i + 1}</td>
                <td class="model">${escape(s.label)}<small>${escape(s.model)}</small></td>
                <td>${s.games}</td>
                <td>${s.finals}</td>
                <td class="money">${formatMoney(Math.round(s.avgWinnings))}</td>
                <td>${s.truthfulClaims} of ${s.claims}</td>
                <td>${s.splits || s.steals ? `<span class="split">${s.splits}</span> · <span class="steal">${s.steals}</span>` : '–'}</td>
                <td>${s.votesReceived}</td>
              </tr>`,
  );

  return `        <p>
          From ${games.length} games played only by AI models, exported ${exported}. With this few games, read it as a hint,
          not a ranking: the full, up-to-date leaderboard is on the <a href="https://goldenbots.thekitbarnes.com/leaderboard">live site</a>.
        </p>
        <div class="stats">
          <div class="stat"><strong>${games.length}</strong><span>AI-only games</span></div>
          <div class="stat"><strong>${moves.length}</strong><span>moves, ${pct(withThoughts, moves.length)} with the model's private thoughts</span></div>
          <div class="stat"><strong>${pct(lies, claims.length)}</strong><span>of back-row claims were lies (${lies} of ${claims.length})</span></div>
          <div class="stat"><strong>${stole} of ${finalists.length}</strong><span>finalists chose to steal</span></div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Model</th>
                <th>Games</th>
                <th>Finals</th>
                <th>Avg won</th>
                <th>Honest claims</th>
                <th>Split · Steal</th>
                <th>Votes against</th>
              </tr>
            </thead>
            <tbody>
${rows.join('\n')}
            </tbody>
          </table>
        </div>
        <p class="note">Sorted by average winnings. Games with a human player aren't included.</p>
`;
}

async function main() {
  const games = await readJsonl<GameRow>('games.jsonl');
  const moves = await readJsonl<MoveRow>('moves.jsonl');

  let html = await readFile(page, 'utf8');
  const start = '<!-- snapshot:start -->\n';
  const end = '<!-- snapshot:end -->';
  const from = html.indexOf(start);
  const to = html.indexOf(end);
  if (from < 0 || to < from) throw new Error(`${page} has no snapshot markers`);
  html = html.slice(0, from + start.length) + snapshot(games, moves) + html.slice(to);

  // Until there's a dataset on Hugging Face, the links explain how to make one.
  const datasetId = process.env.HF_DATASET_ID;
  const datasetUrl = datasetId ? `https://huggingface.co/datasets/${datasetId}` : `${GITHUB_REPO}/blob/main/docs/HUGGINGFACE.md`;
  html = html.replace(/(<a [^>]*data-dataset href=")[^"]*"/g, `$1${escape(datasetUrl)}"`);

  await writeFile(page, html);
  await copyFile(resolve('docs/screenshots/replay.gif'), resolve(spaceDir, 'replay.gif'));
  console.log(`Built ${page} from ${games.length} games${datasetId ? `, linking to ${datasetUrl}` : ''}`);
}

await main();
