# Golden Bots on Hugging Face

Two things can go on [Hugging Face](https://huggingface.co):

- **A dataset** of the finished games: every back-row claim next to the real balls, every chat line,
  vote, pick and final choice, the private thoughts behind each move, who believed and trusted whom,
  and the exit interviews checked against what happened. It's made by `npm run export-dataset`.
- **A Space**: one static page (free to host) that introduces the project, plays the replay GIF,
  shows a leaderboard snapshot from the dataset, and links to the live site, this repo and the
  dataset. It's the [`space/`](../space) folder, filled in by `npm run build-space`.

A GitHub Actions workflow, [`huggingface.yml`](../.github/workflows/huggingface.yml), builds both
and pushes them. It only runs when you start it, and does nothing until the steps below are done.
The live demo publishes to [this dataset](https://huggingface.co/datasets/Kitbarnes/golden-bots)
and [this Space](https://huggingface.co/spaces/Kitbarnes/golden-bots).

The Space doesn't run the game itself. The app needs an always-on disk for its SQLite database and
an OpenRouter key, and a public copy would let anyone spend your OpenRouter credit. A free Space
also goes to sleep when nobody visits. So the Space is a shop window, and the games stay on your
own server.

## What goes in the dataset

Only finished games, read from the site's public API (the same data anyone can see once a game is
over). No login, no admin data and no keys are involved.

- Games with a human player are **left out**. `--include-humans` keeps them, with the human renamed
  "Human" in their own lines and wherever the models named them. Only use it if the people who
  played are happy for their chat to be published.
- Games with scripted mock bots are left out (they're for testing).
- Exit interviews are only saved for games played from 28 October 2026, so older games have none.
  The private ratings with each vote (`ratings`) are newer still, so older games have them null.

The dataset card (`dataset/README.md`) is written by the script too: what every field means, how
the data was made, and its limits.

## Try it locally

```bash
npm run export-dataset
```

This reads the live site and writes `dataset/` (git-ignored): `games.jsonl`, `moves.jsonl` and
`README.md`. Options go after `--`:

```bash
npm run export-dataset -- --url http://localhost:3000 --out my-dataset --include-humans
```

Then fill in the Space page from it, and look at it:

```bash
npm run build-space
```

```bash
python -m http.server 8765 --directory space
```

and open http://localhost:8765. (Opening `space/index.html` straight from disk works too, though
some browsers won't load the GIF that way.)

`build-space` rewrites the leaderboard part of `space/index.html` and copies the replay GIF in
next to it. Set `HF_DATASET_ID` first to point the page's dataset links at Hugging Face; without
it they point here.

## Set it up

### 1. On huggingface.co

1. **Create the dataset.** Go to [huggingface.co/new-dataset](https://huggingface.co/new-dataset),
   pick yourself as the owner, call it something like `golden-bots`, choose **Public**, and create
   it. Its id is `your-name/golden-bots`.
2. **Create the Space.** Go to [huggingface.co/new-space](https://huggingface.co/new-space), give it
   a name (it can be `golden-bots` too, as Spaces and datasets have separate names), choose the
   **Static** SDK with the blank template and the free hardware, choose **Public**, and create it.
3. **Make a token** that can write to just those two. Go to
   [Settings > Access Tokens](https://huggingface.co/settings/tokens), create a new token, and choose
   **Fine-grained**. Name it (say, "Golden Bots GitHub sync"). Under the repositories permissions,
   add the dataset and the Space, and give it write access to them. Leave everything else off.
   Copy the token, as it's only shown once.

### 2. On GitHub

In the repo, go to **Settings > Secrets and variables > Actions**:

- On the **Secrets** tab, add `HF_TOKEN` with the token.
- On the **Variables** tab, add:
  - `HF_DATASET_ID`: the dataset's id, such as `your-name/golden-bots`
  - `HF_SPACE_ID`: the Space's id, such as `your-name/golden-bots`
  - `GOLDEN_BOTS_URL` (optional): your own site, if you're not exporting from the live demo

### 3. Run it

Go to **Actions > Hugging Face > Run workflow**. In about a minute it exports the games, builds the
page and pushes both. Then look at:

- `https://huggingface.co/datasets/your-name/golden-bots`: the viewer should offer two subsets,
  `moves` and `games`.
- `https://huggingface.co/spaces/your-name/golden-bots`

Run it again whenever you want to publish newer games. Each run replaces the files on Hugging
Face with a fresh export (the old versions stay in the repo's history there). The page and card
are rebuilt each time, so change them here in `space/` and `scripts/`, not on Hugging Face.

## Without GitHub Actions

The [`hf` command-line tool](https://huggingface.co/docs/huggingface_hub/guides/cli) can push the
same folders from your machine. After `hf auth login` (with a token that can write to both repos):

```bash
hf upload your-name/golden-bots dataset . --repo-type dataset
```

```bash
hf upload your-name/golden-bots space . --repo-type space
```
