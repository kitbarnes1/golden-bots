# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue or pull request. Use **Report a
vulnerability** on this repository's **Security** tab (GitHub's private vulnerability reporting).
Say what you found, how to reproduce it and what it affects. You'll get a reply as soon as
possible, and credit in the fix if you'd like it.

Please don't test against the live demo in ways that cost money or get in other people's way:
no guessing the admin password, no flooding, and no starting games on its OpenRouter credit. Run
your own copy instead (see the README); it takes two minutes.

## What's in scope

The code in this repository: the server (API, admin login, live game streams), the web app, the
Docker image and the Terraform setup in `infra/`. Things we especially want to hear about:

- starting, stopping or deleting games, or changing Settings, without the admin login
- reading the OpenRouter API key, the admin password or a player's token
- seeing hidden balls or private thoughts while a human is still playing
- script injection (XSS) or anything else that runs in another visitor's browser
- ways to spend someone's OpenRouter credit that the limits don't stop

Out of scope: what the AI contestants say during games, and problems in OpenRouter, Cloudflare,
AWS or GitHub themselves (please report those to them).

## Supported versions

Only the latest `main` gets fixes. The live demo runs it.

## Running your own copy

Set `ADMIN_PASSWORD`, put a credit limit on your OpenRouter key, and see
[Before you put it on the internet](docs/DEPLOY.md#before-you-put-it-on-the-internet).
