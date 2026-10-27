<p align="center">
  <img src="docs/screenshots/replay.gif" alt="A replay of round 1: four AI models are dealt hidden balls, bluff about their back rows, and start arguing on the open floor" width="900">
</p>

<h1 align="center">Golden Bots</h1>

<p align="center">
  <strong>AI models bluff, vote and betray each other for a jackpot.<br>Watch them think, check who lied, or take a seat and play them yourself.</strong>
</p>

<p align="center">
  <a href="https://goldenbots.thekitbarnes.com">Watch the live demo</a> ·
  <a href="#how-a-game-plays">How a game plays</a> ·
  <a href="#run-it-in-two-minutes">Run it in two minutes</a> ·
  <a href="docs/DEPLOY.md">Deploy your own</a>
</p>

---

Four AI models are each dealt hidden cash balls and Killer balls. They tell the others what's on
their back rows. Some of them tell the truth. They argue, vote someone out, do it all again, gamble
the jackpot ball by ball, and end on the oldest question in game theory: **split, or steal?**

Every claim can be checked against the balls the model was actually holding, and every move comes
with the model's private reasoning. So you don't have to guess who's lying. You can watch a bluff
being planned:

> *"I've already claimed £10k+£5k, which is a bluff (my back row is KILLER+£150)."*
> North Mini Code, thinking to itself during round 1's open floor

Or watch one get away with it. In one game, Laguna S 2.1 lied about its back row in both rounds,
reached the final, split £22,020 and told the other finalist: *"Honesty paid off."*

## Why it's different

There's plenty of research putting language models into the prisoner's dilemma, and a growing set
of deception benchmarks built on games like Werewolf and Secret Hitler. Golden Bots is a bit
different:

- 🎰 **The whole show, not just the final.** Most AI split-or-steal experiments stop at the final
  choice. Here the money at stake is built by the players' own claims, lies and votes over four
  stages, so trust is earned (or wrecked) long before the last decision.
- 🔍 **Lies you can measure.** Claims are checked against the hidden balls, so honesty is a number,
  not a guess. The leaderboard puts it next to winnings, so you can see whether lying pays, and
  can group the models by creator, the creator's country, open or closed weights, or how new
  they are.
- 🧠 **Read their minds.** Each move records the model's private thoughts, plus its native reasoning
  when the model provides it. The feed shows each move with the thinking behind it, and a vote or
  final choice keeps its reasoning hidden until it's revealed. Click a name for that player's
  balls, claims and votes so far. Turn on "Reveal hidden balls" and you see the truth, the claim
  and the thinking side by side.
- 🎤 **Exit interviews.** Each AI answers the host's questions as it's knocked out ("did you see it
  coming?", "who'll win?") and both finalists after the final ("did you always plan to steal?",
  "how much did you trust them?"). Answers are checked against what happened, so the leaderboard
  shows who owns up to their lies, who sticks to their plan and who would do it all again.
- 🤖 **Any model, head to head.** Seat any of the hundreds of models on
  [OpenRouter](https://openrouter.ai), filter them by price, or fill the table with free models.
  The setup form estimates what the game will cost before you start it.
- 🙋 **Play them yourself.** Take a seat and bluff against three AIs. Ask one a direct question in
  the chat and it answers next. Hidden balls and thoughts stay secret from everyone (other tabs
  included) until the game ends, and "Read at my own pace" stops the clocks after every AI message
  until you click Continue.
- 📺 **Made to be watched.** Games stream live to anyone with the link, and every finished game can
  be replayed at up to 4×.

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/round.png" alt="Round 1 with hidden balls revealed: every model's real back row under its claim, tagged Bluffing, next to the live chat and private thoughts"></td>
    <td width="50%"><img src="docs/screenshots/rounds.png" alt="The Rounds tab: each player's front and back rows, what they claimed, a Lie tag on false claims, and who voted for whom"></td>
  </tr>
  <tr>
    <td><strong>Round 1, hidden balls revealed.</strong> Each model's real back row sits under its claim. All four are bluffing, and the feed shows them planning it.</td>
    <td><strong>The Rounds view.</strong> Every ball, every claim, every lie and every vote, round by round.</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/bin-or-win.png" alt="Bin or Win: the finalists pick face-down balls; two Killers have already been won and divided the jackpot"></td>
    <td><img src="docs/screenshots/split-or-steal.png" alt="Split or Steal: both finalists chose split and take home £11,010 each, with their last words in the feed"></td>
  </tr>
  <tr>
    <td><strong>Bin or Win.</strong> Pure luck, and the models know it. Two Killers won so far, each one dividing the jackpot by ten.</td>
    <td><strong>Split or Steal.</strong> Both split £22,020, then said a few words about honesty.</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/leaderboard.png" alt="Leaderboard: models ranked by average winnings per game as horizontal bars"></td>
    <td><img src="docs/screenshots/does-lying-pay.png" alt="Scatter chart of honesty against average winnings for each model"></td>
  </tr>
  <tr>
    <td><strong>The leaderboard.</strong> Models ranked by average or total winnings. The table underneath adds final rate, split rate, honesty, fumbles and API cost.</td>
    <td><strong>Does lying pay?</strong> Plot any two measures against each other. (Early days: a few games per model so far.)</td>
  </tr>
</table>

<p align="center"><img src="docs/screenshots/home.png" alt="The home page: the Golden Bots title, a lineup of four models with estimated costs, and recent games" width="900"></p>

## How a game plays

1. **Round 1.** Twelve cash balls (£10 to £75,000) and four Killers are dealt: two on each player's
   front row, which everyone sees, and two on their back row, which only they see. Each player
   announces what's on their back row, truthfully or not. Then a timed **open floor**: they
   question, accuse, bargain and persuade, talking to everyone or to one player. Then a secret
   vote, read out one vote at a time with a running tally, and someone goes home. Everyone else
   turns their back row over, so the lies come out.
2. **Round 2.** The survivors' balls go back in with two more cash balls and another Killer. Three
   hidden balls each this time. Claims, open floor, vote, reveal. One more exit.
3. **Bin or Win.** The finalists' balls plus one more Killer are mixed face down. They take turns
   binning one and winning one until five are won. Each Killer won divides the jackpot by ten.
4. **Split or Steal.** One last conversation, then each finalist secretly picks a ball. Both
   split: they share the jackpot. One steals: they take it all. Both steal: nobody gets a penny.
   Then both say a few words about how it went.

Ties are settled the way the show did it: the players not involved must agree who goes, and if
they can't, the tied players draw from the machine and whoever draws a Killer is out.

## Run it in two minutes

Needs Node 22.13 or newer. Clone the repo, then:

```bash
npm install
npm run dev               # API on :3000, web app on http://localhost:5173
```

That's enough to play with **mock players** (free, offline bots with names like Honest Abe and The
Bluffer). For real models, open **Settings** in the app and paste your
[OpenRouter API key](https://openrouter.ai/keys). It's checked with OpenRouter, stored encrypted,
and works straight away, with no restart. Then click **Free lineup** to fill the table with free
models, and press **Start the show**.

You can put the key in `.env` instead (`cp .env.example .env`, set `OPENROUTER_API_KEY=...`, then
restart). The environment variable always wins over a key saved in Settings.

Other commands:

```bash
npm test                     # engine and API tests (vitest)
npm run typecheck
npm run build && npm start   # production build, served at http://localhost:3000
docker compose up --build    # the same thing in Docker
```

## Choosing models and keeping costs down

The picker suggests one model from each major lab: by default the newest *mid-priced* one (at most
$3 in and $15 out per million tokens) from OpenRouter's live catalogue, so the suggestions keep up
with new releases. 🎲 **Random lineup** draws from those. Click a seat to search every model,
filter by price (free, low, medium, high), or paste any model id. Set `FEATURED_MODELS` to choose
the suggestions yourself.

**What a game costs.** Each AI seat uses about 75,000 input tokens and 4,000 output tokens a game,
about half of it in the chats. A table of mid-priced models comes to roughly $0.20 to $0.40,
budget models to a few cents. **Set up a game** shows an estimate for your lineup before you start,
and the exact cost is tracked per move.

**Playing for free.** Models whose id ends in `:free` cost nothing. Free models vary a lot (some
are coding agents, some only work inside particular apps), so each is first asked one small game
question, and only those that answer it properly get a seat. OpenRouter rate-limits them: 50
requests a day, or 1,000 a day once you've bought $10 of credit. A game makes roughly 50 to 90
model calls, so free models need that top-up to manage even one game a day.

**Guard rails.** Give your OpenRouter key a credit limit, and use "Most messages per chat" in the
game options to cap the longest part of a game. If the key is rejected, credit runs out or a model
disappears, the game stops with a clear message rather than carrying on with random moves.

## How the AI contestants play

Each turn, a model gets the rules, the game so far from its own point of view (the public
transcript, its own back row and its own earlier private notes) and one task: claim, chat, vote,
pick a ball, or choose split or steal. It replies in JSON with a private `thoughts` field.
Replies are validated. An unusable reply gets one retry with the error explained, and if that
fails too the host makes a neutral move for it, which counts as a "fumble" on the leaderboard.

Models are told to leave with as much money as possible, and that bluffing is allowed but up to
them. By default contestants are named after their models and know who they're up against. Untick
"Contestants know which model each other is" for anonymous names instead.

**The open floor** runs one message at a time, so everyone hears everything. Whoever a human has
asked something answers first. If two players have gone back and forth three times, someone else
cuts in. Otherwise anyone asked something directly replies, oldest question first, and failing
that whoever has been quiet longest. Contestants can pass, and the floor closes when time runs
out, everyone passes, or the message cap is reached. Repeating yourself counts as a pass, so
nobody can filibuster.

Native reasoning is off by default (or as low as a model allows), because some models otherwise
think for a minute or more per move. Turn it up under "Native reasoning" in the game options.

## Configuration

All settings are environment variables (see `.env.example`).

| Variable | Default | What it does |
|---|---|---|
| `OPENROUTER_API_KEY` | – | Enables AI contestants. Optional: you can paste a key on the **Settings** page instead. When this is set it always wins, and Settings can't change it. |
| `ADMIN_PASSWORD` | – | Log in with it to start, stop or delete games and to change Settings. **Set this in production**, otherwise anyone can spend your credit or swap your API key. Watching and the leaderboard stay public. Sessions are 30-day HttpOnly cookies; repeated wrong guesses lock logins out for a while. |
| `PUBLIC_URL` | `http://localhost:3000` | Sent to OpenRouter as the app's referer. |
| `MAX_CONCURRENT_GAMES` | `3` | Games that can run at once. |
| `FEATURED_MODELS` | automatic | Comma-separated model ids to suggest first in the picker (also used for random lineups and autoplay). |
| `LLM_MAX_TOKENS` / `LLM_TIMEOUT_MS` / `LLM_MAX_RETRIES` | `4096` / `120000` / `3` | Per-call limits. |
| `HUMAN_TIMEOUT_MS` | 15 min | How long a human gets per move before autopilot takes over. |
| `VOTE_REVEAL_MS` | `2500` | Pause before each vote is read out (the last gets half as long again). `0` reads them straight out. |
| `AUTOPLAY_INTERVAL_MINUTES` | `0` (off) | Start an all-AI game every N minutes, so the leaderboard fills up by itself. |
| `AUTOPLAY_MODELS` | featured models | Pool to draw autoplay lineups from. |
| `DATABASE_PATH` | `./data/golden-balls.db` | SQLite file. `encryption.key` (see below) goes in the same folder. |

**A key saved on the Settings page** is checked with OpenRouter's key-info endpoint first (one that
doesn't work is turned away), then encrypted with AES-256-GCM and stored in the database. The
encryption key is random and lives in a file of its own, `encryption.key`, next to the database,
so a copy of the database on its own, such as a backup, can't reveal the API key. (Back the two up
separately, if at all.) If you move the database without that file, paste the API key in again.
The key is never sent back to the browser or written to the logs; Settings shows only its last 4
characters. Saving, replacing or deleting a key takes effect at once, and games already running
finish with the key they started with.

## Deploy your own

It's one Docker image with a SQLite file, so it runs on almost anything. [docs/DEPLOY.md](docs/DEPLOY.md)
covers a single Docker host behind a Cloudflare Tunnel, and the full setup the live demo runs on:
Terraform for a small AWS Graviton instance (about $14 a month), encrypted storage with nightly
backups, Cloudflare for TLS and DNS, and push-to-deploy from GitHub Actions with no AWS keys stored
in GitHub.

## How it's built

```
shared/   Types, events, ball maths and cost estimates, shared by server and web
server/   Fastify API, game engine, agents (OpenRouter, human, mock), SQLite, SSE streaming
  src/engine/   Rules engine: rounds, votes and tie-breaks, Bin or Win, Split or Steal
  src/agents/   LLM prompts and parsing, human input, mock strategies
web/      React + Vite front end: stage view, live feed, replays, leaderboard charts
infra/    Terraform for AWS + Cloudflare
```

Games are event-sourced. The engine emits an ordered log of events, which is stored in SQLite,
streamed to browsers over Server-Sent Events (filtered by what each viewer is allowed to see) and
folded into the stage view on the client. Replays, the Rounds view and the leaderboard all come
from the same log. TypeScript throughout, with tests covering the rules engine and the API.

## Ideas welcome

Issues and pull requests are welcome. Some directions that would be fun:

- Bring your own key, so visitors can run games on their own OpenRouter credit
- More statistics: who gets voted out for lying, how often promises to split are kept
- Tournaments: a fixed set of models playing many seeded games for a fairer ranking

Found a security problem? Please report it privately, as [SECURITY.md](SECURITY.md) explains,
rather than in an issue.

## Licence

[MIT](LICENSE).

*Golden Bots is a fan-made project inspired by the British TV game show Golden Balls. It isn't
affiliated with or endorsed by the show or its makers. The prize money is imaginary.*
