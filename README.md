# Golden Balls: AI Edition

The British game show *Golden Balls*, played by AI models. Four contestants (models from
[OpenRouter](https://openrouter.ai), [Hugging Face](https://huggingface.co/docs/inference-providers)
or [Ollama](https://ollama.com) on your own computer, or three models and you) get hidden cash and
Killer balls. They bluff about what they hold, argue it out on a timed open floor, vote each other
off, play Bin or Win, and finish with Split or Steal. You can watch live, read each model's private
thoughts as it plays, replay old games, and follow a leaderboard of how each model does over time.

- **Faithful rules**: 12 cash balls (£10 to £75,000) and 4 Killers, front and back rows, claims,
  secret votes, the tie-break (the untied players must agree, otherwise a Killer draw), round 2
  with 2 more cash balls and 1 more Killer, Bin or Win (each Killer won divides the jackpot by
  10), then Split or Steal.
- **Open-floor chat**: before each vote, and again before Split or Steal, contestants get a
  timed conversation (60 seconds by default). They can talk to everyone or to one player, and
  whoever is asked something directly answers next. If you're playing, type into the chat at any
  time and the AI you address replies.
- **Reasoning on show**: every move records the model's private `thoughts`, plus its native
  reasoning tokens when the model provides them. Toggle them on or off, and switch on "Reveal
  hidden balls" to see who's lying while it happens.
- **Play yourself**: take one of the four seats. While a human is playing, nobody (including
  other tabs) can see hidden balls or AI thoughts until the game ends.
- **Leaderboard**: average winnings per game, total and best wins, how often each model reaches
  the final, split rate, honesty (share of back-row claims that were true), final outcomes,
  fumbles (unusable replies) and API cost. There's also a chart of each model's running average.
- **Replays**: every event is stored, so any finished game can be replayed at 0.5× to 4×.
- **Mock players** (free, offline) for trying it out without an API key. Games with mock players
  are "practice" games and stay off the leaderboard unless you ask for them.
- **Autoplay** (optional): start an all-AI game on a timer so the leaderboard fills up by itself.

## Run it locally

Needs Node 22.13 or newer.

```bash
npm install
cp .env.example .env      # add API keys here (optional, see below)
npm run dev               # API on :3000, web app on http://localhost:5173
```

With no keys and no Ollama, only the mock players are offered. Other commands:

```bash
npm test                  # engine + API tests (vitest)
npm run typecheck
npm run build && npm start   # production build, served at http://localhost:3000
docker compose up --build    # or the same thing in Docker
```

## Where the models come from

You can mix providers in one game. A model id's prefix says where it runs:

| Provider | Model id looks like | Cost | Set up |
|---|---|---|---|
| **Ollama** (your computer) | `ollama:llama3.1:8b` | **Free**, unlimited | Install [Ollama](https://ollama.com), run `ollama pull llama3.1:8b`. It's detected automatically. |
| **OpenRouter** free models | `meta-llama/llama-3.3-70b-instruct:free` | **Free**, rate-limited: 50 requests a day, or 1,000 a day after a one-off $10 credit purchase | `OPENROUTER_API_KEY` |
| **OpenRouter** | `anthropic/claude-sonnet-4.5` | Pay per token | `OPENROUTER_API_KEY` |
| **Hugging Face** | `hf:Qwen/Qwen2.5-72B-Instruct` | Pay per token at the provider's price. Free accounts get no monthly credits; PRO includes $2 a month | `HF_TOKEN` (with the "Inference Providers" permission) |

**Playing for free:** Ollama is the easiest. Small models (7–9B) run fine on a recent laptop and
cost nothing, but they bluff and argue less convincingly than the big hosted models. They're also
slower on modest hardware, so pick longer chat times. Running four *different* local models means
swapping them in and out of memory, so one or two models across the four seats is quicker. The
**Free lineup** button fills the table with free models. A game makes roughly 50–90 model calls,
so OpenRouter's 50-a-day free limit won't cover a single game, but 1,000 a day is plenty.

If a provider rejects your key, you run out of credits, a model doesn't exist, or Ollama isn't
running, the game stops with a clear message rather than carrying on with random moves.

## Configuration

All settings are environment variables (see `.env.example`).

| Variable | Default | What it does |
|---|---|---|
| `OPENROUTER_API_KEY` | – | Enables OpenRouter models. |
| `HF_TOKEN` | – | Enables Hugging Face models (`hf:` prefix). |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Where Ollama runs (`ollama:` prefix). Set it empty to turn Ollama off. From Docker, use `http://host.docker.internal:11434`. |
| `ADMIN_PASSWORD` | – | Required to start, stop or delete games. **Set this in production**, otherwise anyone can spend your credits. Watching and the leaderboard stay public. |
| `PUBLIC_URL` | `http://localhost:3000` | Sent to OpenRouter as the app's referer. |
| `MAX_CONCURRENT_GAMES` | `3` | Games that can run at once. |
| `FEATURED_MODELS` | a mix of current models | Comma-separated model ids shown first in the picker (prefixes allowed). Any model can still be typed in. |
| `LLM_MAX_TOKENS` / `LLM_TIMEOUT_MS` / `LLM_MAX_RETRIES` | `4096` / `120000` / `3` | Per-call limits. |
| `HUMAN_TIMEOUT_MS` | 15 min | How long a human gets per move before autopilot takes over. |
| `AUTOPLAY_INTERVAL_MINUTES` | `0` (off) | Start an all-AI game every N minutes. |
| `AUTOPLAY_MODELS` | featured list | Pool to draw autoplay lineups from. |
| `DATABASE_PATH` | `./data/golden-balls.db` | SQLite file. |

**What a game costs:** a game is roughly 50–90 model calls, each with a few thousand tokens of
game transcript. Most of the variation comes from the chats, and the "most messages per chat"
option caps it. With mid-priced models expect very roughly $0.50–$1.50 per game, a few cents with
budget models, and nothing with Ollama or free models. The exact cost is tracked per move and shown
on each game and on the leaderboard.

## How the AI contestants play

Each turn, the model gets the rules, the game so far from its own point of view (the public
transcript, its own back row, and its own earlier private notes) and one task: claim, chat,
vote, pick a ball, or choose split or steal. It replies in JSON with a private `thoughts`
field. Replies are validated; an unusable reply gets one retry with the error explained, and if
that fails too the host makes a neutral move for the model (truthful claim, random vote, and so
on). That counts as a "fumble" on the leaderboard.

**The open floor** runs for the time set in the game options, one message at a time so that
everyone hears everything. Who speaks next:

1. Anyone a human has asked something answers first.
2. If two players have gone back and forth three times, someone else cuts in.
3. Otherwise, anyone who was asked something directly replies, oldest question first.
4. Otherwise, whoever has been quiet longest.

Contestants can pass when they've nothing to add. The floor closes when time runs out, when
everyone passes, or when the message cap is reached. If you're playing, the floor stays open for
you after the AIs hit the cap, until time runs out or you click "I'm done talking". When someone
asks you something directly, the AIs wait up to 20 seconds for your answer.

Models are told their aim is to leave with as much money as possible, and that bluffing is
allowed but up to them. By default contestants are named after their models and know who
they're playing against. Untick "Contestants know which model each other is" to use anonymous
names instead.

## Deploy to AWS with your Cloudflare domain

The setup in `infra/terraform` creates:

- A small **EC2 instance** (Graviton `t4g.small`, about $12/month) running the app and
  `cloudflared` with Docker Compose. It has **no inbound ports**: a **Cloudflare Tunnel** carries
  traffic for `goldenballs.thekitbarnes.com`, and Cloudflare handles TLS.
- A separate encrypted **EBS volume** for the SQLite database, so it survives instance
  replacement, plus **nightly backups to S3** (kept 90 days).
- An **ECR** repository for images, and **SSM Parameter Store** entries for your secrets.
- A **GitHub Actions OIDC role**, so pushes to `main` build an ARM image, push it to ECR and roll
  it out over SSM. No AWS keys are stored in GitHub.
- The Cloudflare **tunnel**, its routing, and the proxied **DNS record**.

### 1. Prerequisites

- Terraform 1.6 or newer and AWS credentials for your account (`aws configure`).
- A Cloudflare API token (My Profile → API Tokens → Create Token → Custom) with:
  - Account → **Cloudflare Tunnel** → Edit
  - Zone → **DNS** → Edit, for `thekitbarnes.com`
- Your Cloudflare **account id** and the **zone id** of `thekitbarnes.com` (both on the
  domain's Overview page).
- An OpenRouter API key and/or a Hugging Face token, and a password for starting games. (Ollama
  isn't available on the server: the small instance has no GPU.)

### 2. Create the infrastructure

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars    # fill in ids, keys and password
export CLOUDFLARE_API_TOKEN=...
terraform init
terraform apply
terraform output github_actions_variables
```

If your AWS account already has the GitHub OIDC provider
(`token.actions.githubusercontent.com`), set `create_github_oidc_provider = false`.

Terraform state includes your API key and password. Keep it private, for example by enabling
the S3 backend block in `versions.tf`.

### 3. Connect GitHub Actions

In the GitHub repo, open Settings → Secrets and variables → Actions → **Variables** and add the
four values from `terraform output github_actions_variables`: `AWS_REGION`,
`AWS_DEPLOY_ROLE_ARN`, `ECR_REPOSITORY` and `EC2_INSTANCE_ID`.

Then merge to `main` (or run the **Deploy** workflow by hand). The workflow runs the tests,
builds a `linux/arm64` image, pushes it to ECR and runs `/opt/golden-balls/deploy.sh <sha>` on
the instance. A minute later the site is live at **https://goldenballs.thekitbarnes.com**.

### Running it

- **Shell on the server** (no SSH needed): `aws ssm start-session --target <instance_id>`
- **Logs**: `cd /opt/golden-balls && sudo docker compose logs -f app`
- **Change a setting or secret**: edit `terraform.tfvars` (use `extra_app_env` for things like
  `AUTOPLAY_INTERVAL_MINUTES`), run `terraform apply`, then rerun the Deploy workflow or
  `sudo /opt/golden-balls/deploy.sh` on the server.
- **Backups**: run nightly by a systemd timer (`systemctl list-timers golden-balls-backup*`).
  Run one now with `sudo /opt/golden-balls/backup.sh`.
- **Restore**: stop the app (`sudo docker compose stop app`), copy a backup from S3 over
  `/var/lib/golden-balls/data/golden-balls.db`, delete the `-wal` and `-shm` files next to it,
  then `sudo docker compose start app`.
- **Tear down**: the data volume has `prevent_destroy` so the leaderboard can't be deleted by
  accident. Remove that line from `main.tf` before `terraform destroy`.

### Without Terraform

Any machine with Docker works: create a tunnel in the Cloudflare dashboard (Zero Trust →
Networks → Tunnels), add a public hostname `goldenballs.thekitbarnes.com` → `http://app:3000`,
put its token in `.env` as `CLOUDFLARE_TUNNEL_TOKEN` along with your other settings, and run
`docker compose --profile tunnel up -d --build`.

## Project layout

```
shared/   Types, events and rules shared by server and web
server/   Fastify API, game engine, agents (OpenRouter, human, mock), SQLite, SSE streaming
  src/engine/   Rules engine: rounds, votes and tie-breaks, Bin or Win, Split or Steal
  src/agents/   LLM prompts and parsing, human input, mock strategies
web/      React + Vite front end: studio view, transcript, replays, leaderboard
infra/    Terraform for AWS + Cloudflare
```

Games are event-sourced: the engine emits an ordered event log, which is stored in SQLite,
streamed to browsers over Server-Sent Events (filtered by what each viewer may see) and folded
into the stage view on the client. Replays come from the same log.

*A fan-made experiment inspired by the ITV game show. Not affiliated with its makers. The prize
money is imaginary.*
