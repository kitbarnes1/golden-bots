# Deploying Golden Bots

Golden Bots runs anywhere Docker does. This guide covers the two routes it was built for: a full
AWS + Cloudflare setup with Terraform and push-to-deploy, and a single Docker host behind a
Cloudflare Tunnel.

## AWS + Cloudflare with Terraform

The setup in `infra/terraform` creates:

- A small **EC2 instance** (Graviton `t4g.small` by default, or `t4g.micro` with 1 GB of swap to
  save money; about $20 or $14 a month all in, counting disks and the public IPv4 address) running
  the app and `cloudflared` with Docker Compose. It has **no inbound ports**: a **Cloudflare
  Tunnel** carries traffic for `<subdomain>.<your domain>`, and Cloudflare handles TLS.
- A separate encrypted **EBS volume** for the SQLite database, so it survives instance
  replacement, plus **nightly backups to S3** (kept 90 days).
- An **ECR** repository for images, and **SSM Parameter Store** entries for your secrets.
- A **GitHub Actions OIDC role**, so pushes to `main` build an ARM image, push it to ECR and roll
  it out over SSM. No AWS keys are stored in GitHub.
- The Cloudflare **tunnel**, its routing, and the proxied **DNS record**.

### 1. Prerequisites

- Terraform 1.6 or newer and the AWS CLI, signed in as an identity that can create this stack.
  `infra/iam/terraform-policy.json` is a policy scoped to it (EC2, one ECR repository,
  `golden-balls-*` buckets, roles and SSM parameters, the GitHub OIDC provider, and Session
  Manager on the app server): attach it to a `golden-balls-terraform` role and assume that role.
- A Cloudflare API token (My Profile → API Tokens → Create Token → Custom) with:
  - Account → **Cloudflare Tunnel** → Edit
  - Zone → **DNS** → Edit, for your domain
- Your Cloudflare **account id** and your domain's **zone id** (both on the domain's Overview page).
- An OpenRouter API key (ideally with a credit limit), and a password for starting games. The key
  goes into SSM and reaches the app as `OPENROUTER_API_KEY`, so the Settings page shows it as set
  by the environment and can't change it.
- A private S3 bucket with versioning on, for Terraform's state. The state holds your API key and
  password, so keep it private:

  ```bash
  aws s3api create-bucket --bucket <state-bucket> --region eu-west-2 \
    --create-bucket-configuration LocationConstraint=eu-west-2
  aws s3api put-bucket-versioning --bucket <state-bucket> --versioning-configuration Status=Enabled
  aws s3api put-public-access-block --bucket <state-bucket> \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  ```

### 2. Create the infrastructure

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # your ids, keys, password, domain and repo
cp backend.hcl.example backend.hcl             # your state bucket's name
export CLOUDFLARE_API_TOKEN=...
terraform init -backend-config=backend.hcl
terraform apply
terraform output github_actions_variables
```

`terraform.tfvars` and `backend.hcl` are git-ignored. If your AWS account already has the GitHub
OIDC provider (`token.actions.githubusercontent.com`), set `create_github_oidc_provider = false`.

### 3. Connect GitHub Actions

In the GitHub repo, open Settings → Secrets and variables → Actions → **Variables** and add the
four values from `terraform output github_actions_variables`: `AWS_REGION`,
`AWS_DEPLOY_ROLE_ARN`, `ECR_REPOSITORY` and `EC2_INSTANCE_ID`.

Then merge to `main` (or run the **Deploy** workflow by hand). The workflow runs the tests,
builds a `linux/arm64` image, pushes it to ECR and runs `/opt/golden-balls/deploy.sh <sha>` on
the instance. A minute later the site is live at `https://<subdomain>.<your domain>`. Deploys
run one at a time, and a push that GitHub delivers after a newer one is skipped, so the site
never slips back to an older version.

The deploy role trusts only pushes to `main` of your repository, so forks and pull requests can't
deploy.

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

## Any Docker host + a Cloudflare Tunnel

No Terraform needed. Create a tunnel in the Cloudflare dashboard (Zero Trust → Networks →
Tunnels) and add a public hostname pointing at `http://app:3000`. Put its token in `.env` as
`CLOUDFLARE_TUNNEL_TOKEN` along with your other settings (at least `ADMIN_PASSWORD` and
`PUBLIC_URL`, plus `OPENROUTER_API_KEY` unless you'd rather paste the key on the Settings page),
then:

```bash
docker compose --profile tunnel up -d --build
```

Without a tunnel, `docker compose up -d --build` serves the app on `127.0.0.1:3000`, ready for an
HTTPS reverse proxy on the same machine.

## Before you put it on the internet

- **Set `ADMIN_PASSWORD`.** Without it, anyone who finds the site can start games on your
  OpenRouter credit, or replace your key on the Settings page. With it, watching games and the
  leaderboard stay public, and starting, stopping or deleting games and changing Settings need the
  login (a 30-day HttpOnly session cookie, with lockouts after repeated wrong guesses).
- **Give your OpenRouter key a credit limit** in the OpenRouter dashboard.
- Requests are rate-limited per visitor, security headers (including a strict
  Content-Security-Policy) are on, and plain HTTP is redirected to HTTPS when behind Cloudflare.
