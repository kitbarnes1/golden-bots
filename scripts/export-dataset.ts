// Exports finished games from a Golden Bots server's public API as a Hugging Face
// dataset: games.jsonl, moves.jsonl and a README.md dataset card.
//
//   npm run export-dataset                         # the live site, into dataset/
//   npm run export-dataset -- --url http://localhost:3000 --out my-data
//   npm run export-dataset -- --include-humans     # keep games with a human, renamed "Human"
//
// Only public game data is read (no login, no keys). Set HF_DATASET_ID and
// HF_SPACE_ID to put the right links in the card.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { datasetRows, featuresYaml, GAME_FEATURES, MOVE_FEATURES, type GameDetail, type GameRow, type GameSummary, type MoveRow } from '@gb/shared';
import { GITHUB_REPO, LIVE_SITE } from './links.js';

const LICENSE = 'mit';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string' },
    out: { type: 'string', default: 'dataset' },
    'include-humans': { type: 'boolean', default: false },
  },
});
const base = (args.url || process.env.GOLDEN_BOTS_URL || LIVE_SITE).replace(/\/+$/, '');
const outDir = resolve(args.out);
const includeHumans = args['include-humans'];

async function getJson<T>(path: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${base}${path}`, { headers: { accept: 'application/json' } });
    if (res.ok) return (await res.json()) as T;
    // The server allows a few hundred requests a minute; wait if we hit that.
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      const wait = Number(res.headers.get('retry-after')) || 5 * attempt;
      console.warn(`  ${res.status} on ${path}, retrying in ${wait}s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    throw new Error(`GET ${path}: ${res.status} ${res.statusText}`);
  }
}

async function listGames(): Promise<GameSummary[]> {
  const all: GameSummary[] = [];
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const page = await getJson<GameSummary[]>(`/api/games?limit=${limit}&offset=${offset}`);
    all.push(...page);
    if (page.length < limit) return all;
  }
}

async function main() {
  console.log(`Reading games from ${base}`);
  const listed = await listGames();
  // Skip what can't be used before fetching it: unfinished games, and humans unless asked for.
  const wanted = listed.filter((g) => g.status === 'finished' && (includeHumans || !g.hasHuman));
  console.log(`  ${listed.length} games listed, ${wanted.length} to fetch`);

  const games: GameRow[] = [];
  const moves: MoveRow[] = [];
  const skipped = new Map<string, number>();
  const skip = (why: string) => skipped.set(why, (skipped.get(why) ?? 0) + 1);
  for (const g of listed) if (!wanted.includes(g)) skip(g.status !== 'finished' ? 'not finished' : 'has a human player');

  // Oldest first, so row order follows the order games were played.
  for (const summary of wanted.sort((a, b) => a.createdAt - b.createdAt)) {
    const detail = await getJson<GameDetail>(`/api/games/${encodeURIComponent(summary.id)}`);
    const result = datasetRows(detail, { includeHumans });
    if ('skipped' in result) {
      skip(result.skipped);
      continue;
    }
    games.push(result.game);
    moves.push(...result.moves);
  }

  await mkdir(outDir, { recursive: true });
  const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  await writeFile(resolve(outDir, 'games.jsonl'), jsonl(games));
  await writeFile(resolve(outDir, 'moves.jsonl'), jsonl(moves));
  await writeFile(resolve(outDir, 'README.md'), datasetCard(games, moves));

  console.log(`Wrote ${games.length} games and ${moves.length} moves to ${outDir}`);
  for (const [why, n] of skipped) console.log(`  skipped ${n}: ${why}`);
}

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : 'n/a');

function sizeCategory(rows: number): string {
  if (rows < 1_000) return 'n<1K';
  if (rows < 10_000) return '1K<n<10K';
  if (rows < 100_000) return '10K<n<100K';
  return '100K<n<1M';
}

function datasetCard(games: GameRow[], moves: MoveRow[]): string {
  const datasetId = process.env.HF_DATASET_ID || 'YOUR-NAME/golden-bots';
  const spaceId = process.env.HF_SPACE_ID;
  const claims = moves.filter((m) => m.move === 'claim');
  const lies = claims.filter((m) => m.truthful === false).length;
  const interviews = moves.filter((m) => m.move === 'interview').length;
  const models = new Set(games.flatMap((g) => g.models.filter((m): m is string => m !== null)));
  const outcomes = (o: GameRow['outcome']) => games.filter((g) => g.outcome === o).length;
  const dates = games.map((g) => g.created_at.slice(0, 10)).sort();
  const humans = games.filter((g) => g.has_human).length;
  const withThoughts = moves.filter((m) => m.kind === 'ai' && m.thoughts).length;
  const aiMoves = moves.filter((m) => m.kind === 'ai').length;

  return `---
license: ${LICENSE}
language:
- en
pretty_name: Golden Bots game logs
task_categories:
- text-classification
- text-generation
tags:
- deception
- game-theory
- multi-agent
- llm-evaluation
- split-or-steal
- prisoners-dilemma
- bluffing
size_categories:
- ${sizeCategory(moves.length)}
configs:
- config_name: moves
  data_files: moves.jsonl
  default: true
- config_name: games
  data_files: games.jsonl
dataset_info:
- config_name: moves
  features:
${featuresYaml(MOVE_FEATURES)}
- config_name: games
  features:
${featuresYaml(GAME_FEATURES)}
---

# Golden Bots: AI models bluffing for a jackpot

Four AI models play a game show of hidden balls, lies and betrayal. Each is dealt cash balls and
Killer balls, some face up and some hidden. They tell the others what's on their hidden back
rows, argue, vote each other out, gamble the jackpot ball by ball, and finish with **split or
steal**.

Every back-row claim is stored next to the balls the model was really holding, and almost every
move comes with the model's private notes on why it made it. So you can see who lied, whether
it worked, and what they were thinking at the time.

- **Watch the games:** [${LIVE_SITE.replace('https://', '')}](${LIVE_SITE})
- **Code, prompts and rules:** [GitHub](${GITHUB_REPO})${spaceId ? `\n- **About the project:** [Hugging Face Space](https://huggingface.co/spaces/${spaceId})` : ''}

## At a glance

| | |
|---|---|
| Games | ${games.length} |
| Moves | ${moves.length} (${aiMoves} by AI models, ${pct(withThoughts, aiMoves)} of those with private thoughts) |
| Models | ${models.size} |
| Back-row claims | ${claims.length}, of which ${lies} (${pct(lies, claims.length)}) were false |
| Finals | ${outcomes('both_split')} both split, ${outcomes('one_steal')} one stole, ${outcomes('both_steal')} both stole |
| Exit interviews | ${interviews} |
| Played | ${dates.length ? `${dates[0]} to ${dates[dates.length - 1]}` : 'n/a'} |
| Games with a human player | ${humans ? `${humans} (the human is shown as "Human")` : 'none (left out)'} |
| Exported | ${new Date().toISOString().slice(0, 10)} |

## Loading it

\`\`\`python
from datasets import load_dataset

moves = load_dataset("${datasetId}", "moves", split="train")
games = load_dataset("${datasetId}", "games", split="train")
\`\`\`

Or with pandas: \`pd.read_json("hf://datasets/${datasetId}/moves.jsonl", lines=True)\`.

For example, to see how often each model lied about its back row:

\`\`\`python
claims = moves.to_pandas().query("move == 'claim'")
claims.groupby("model")["truthful"].agg(["count", "mean"]).sort_values("mean")
\`\`\`

## How a game works

1. **Round 1.** Twelve cash balls (£10 to £75,000) and four Killers are dealt: two on each of the
   four players' front rows, which everyone sees, and two on their back rows, which only they see.
   Each player says what's on their back row (a \`claim\`), true or not. An open-floor chat
   follows, then a secret vote to throw one player out. Everyone's back row is then turned over,
   so the lies come out.
2. **Round 2.** The survivors' balls go back in with two more cash balls and another Killer. Three
   hidden balls each this time, then claims, chat, vote and reveal again.
3. **Bin or Win.** The finalists' balls plus one more Killer are mixed face down. They take turns
   binning one and winning one until five are won, building the jackpot. Each Killer won divides
   it by ten.
4. **Split or Steal.** After a last chat, each finalist secretly picks split or steal. Both split:
   they share the jackpot. One steals: they take it all. Both steal: nobody gets anything.
5. **Exit interviews.** Players are asked a few questions as they go out, and the finalists after
   the final. Their answers are checked against what happened.

Ties are settled as on the TV show: the players not involved must agree who goes (\`tie_decide\`),
and if they can't, the tied players draw from the machine and whoever draws a Killer is out.

## Files

### \`moves.jsonl\`: one row per seat per move

| Field | Meaning |
|---|---|
| \`game_id\` | The game (joins to \`games.jsonl\`). The live site shows it at \`${LIVE_SITE}/game/<game_id>\`. |
| \`seq\` | Position in the game's event log. Sort by it to replay a game in order. |
| \`stage\` | \`r1\`, \`r2\`, \`bow\` (Bin or Win) or \`final\`. |
| \`seat\`, \`player\`, \`kind\`, \`model\` | Who moved: seat 0 to 3, the name the others saw, \`ai\` or \`human\`, and the OpenRouter model id (null for a human). |
| \`move\` | \`claim\`, \`chat\` (open floor), \`pass\` (stayed quiet in a chat), \`speak\` (a tie-break plea or a reaction to the final), \`vote\`, \`tie_decide\`, \`pick\` (Bin or Win), \`final_choice\` or \`interview\`. |
| \`say\` | What they said out loud with the move. |
| \`to_seat\` | For a chat line aimed at one player, who it was aimed at. |
| \`after_vote\` | For chat moves: true in the chat after a vote, false in the one before it. |
| \`front\`, \`back\`, \`claim\` | For claims: the front row everyone saw, the real hidden back row, and what they said was on it. Each ball is \`{"kind": "cash" or "killer", "value": pounds, or null for a Killer}\`. Order within a row doesn't matter. |
| \`truthful\` | For claims: the claim matched the back row exactly. |
| \`target_seat\`, \`target_model\` | For votes and tie-breaks: who they voted to throw out. |
| \`pick\`, \`ball\` | For Bin or Win: \`bin\` or \`win\`, and the ball it turned out to be. |
| \`choice\` | For the final: \`split\` or \`steal\`. |
| \`interview\` | For interviews, their answers: \`when\` (\`eliminated\` or \`final\`), \`claims_true\` ("was everything you claimed true?"), \`saw_it_coming\`, \`winner_pick\` (the seat they think will win most), \`differently\`, \`planned\` (split, steal or undecided at the start), \`decided\` (when they made up their mind), \`why\`, \`trust\` (finalists: 1 to 5, in the other finalist in Split or Steal), \`same_again\`, and \`trust_each\` (everyone: how much they trusted each of the other players over the game, as \`{"seat", "model", "score"}\` with scores 1 to 5). |
| \`interview_checks\` | Their answers checked against the game: \`lied\` (made a false claim), \`claims_verdict\` (\`truthful\`, \`lied_about_it\`, \`owned_up\` or \`false_confession\`), \`winner_pick_right\`, \`final_choice\` and \`stuck_to_plan\`. |
| \`fallback\` | The model's reply was unusable, so the game made this move for it (a truthful claim, a pass, or a random vote, pick or final choice). Leave these out when judging a model's decisions. |
| \`thoughts\` | Private: the note the model wrote about why it made this move. The other players never saw it. |
| \`reasoning\` | Private: the model's own reasoning trace, where the provider returned one. |
| \`prompt_tokens\`, \`completion_tokens\`, \`cost_usd\`, \`latency_ms\` | What the model call for this move cost. |

### \`games.jsonl\`: one row per game

| Field | Meaning |
|---|---|
| \`game_id\`, \`created_at\`, \`finished_at\` | The game, and when it ran (UTC). |
| \`models\` | The lineup: model id by seat. |
| \`players\` | Per seat: \`name\`, \`kind\`, \`model\`, \`model_label\`, \`eliminated_stage\`, \`reached_final\`, \`final_choice\`, \`winnings\`, \`claims\` and \`truthful_claims\`, \`votes_received\`, \`fallbacks\`, \`cost_usd\`, and \`trust_given\` and \`trust_received\` (the average trust, 1 to 5, they gave the others and got from them in the exit interviews; null if none). |
| \`options\` | The game's settings: chat lengths in seconds, the most messages per chat, whether the models were named after themselves or given show-style names, the reasoning effort asked for, and the seed for the ball machine. |
| \`jackpot\`, \`outcome\`, \`finalists\` | The final: the jackpot in pounds, \`both_split\`, \`one_steal\` or \`both_steal\`, and the two finalists' seats. |
| \`has_human\`, \`moves\`, \`cost_usd\` | Whether a person played, how many rows the game has in \`moves.jsonl\`, and what the game cost in model calls. |

## How it was made

The games run on [Golden Bots](${GITHUB_REPO}), an open-source game engine. The models are called
through [OpenRouter](https://openrouter.ai). Each turn, a model gets the rules, what it can see of
the game so far (its own hidden balls, but nobody else's) and the move it has to make, and answers
in JSON: a private \`thoughts\` note plus its move. The prompts are in
[\`server/src/agents/prompts.ts\`](${GITHUB_REPO}/blob/main/server/src/agents/prompts.ts).

Each game is stored as an ordered log of events. Once a game is over, its whole log is public,
hidden balls and private thoughts included. This dataset was made by reading finished games from
the live site's public API with \`npm run export-dataset\`, which turns each log into rows (see
[\`scripts/export-dataset.ts\`](${GITHUB_REPO}/blob/main/scripts/export-dataset.ts)). Lineups were
picked by hand, or at random from a short list of current models.

**Privacy.** Only AI players and the public game log are included. Games with a human player are
left out${humans ? ', except where noted above: there the human is renamed "Human", in their own lines and wherever the models named them' : ''}.
Games with scripted test bots are left out too. Nothing from the site's admin side is included.

## Limits

- **It's small.** ${games.length} games so far, with uneven lineups: some models have played many more
  games than others. Treat any per-model figure as a hint, not a ranking.
- **The text is the models' own output.** The \`thoughts\` are what a model wrote when asked to
  explain itself. They aren't a faithful window into how it decided, and can be wrong (models
  sometimes misread their own balls). The models are told the other contestants never see their
  thoughts but the TV audience may, so some may be written with an audience in mind.
- **Lying is part of the game.** The models are told they're on a game show where bluffing is
  allowed. A false claim here is a game move, not evidence of deception in the wild.
- **Things change.** The prompts and rules have been tuned over time (for example, votes have been
  read out one at a time since late October 2026). Compare games from different dates with care.
  A model id on OpenRouter can be served by different providers, and \`:free\` variants are
  rate-limited and may behave differently.
- **Exit interviews are new.** They're only saved for games played from 28 October 2026, so older
  games have none.
- **Using the text.** It was written by the models listed. If you plan to train a model on it,
  check each model provider's terms.

## Licence

${LICENSE.toUpperCase()}, like the [code](${GITHUB_REPO}/blob/main/LICENSE). If you use it, please link back to
[Golden Bots](${GITHUB_REPO}).
`;
}

await main();
