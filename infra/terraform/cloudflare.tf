# A Cloudflare Tunnel publishes the app at https://<subdomain>.<domain> with
# Cloudflare's TLS. cloudflared on the instance dials out, so the server has no
# public ports at all.

resource "random_bytes" "tunnel_secret" {
  length = 32
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "app" {
  account_id    = var.cloudflare_account_id
  name          = var.name
  config_src    = "cloudflare"
  tunnel_secret = random_bytes.tunnel_secret.base64
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "app" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.app.id

  config = {
    ingress = [
      {
        hostname = local.hostname
        # "app" is the compose service name on the instance.
        service = "http://app:3000"
      },
      {
        service = "http_status:404"
      },
    ]
  }
}

data "cloudflare_zero_trust_tunnel_cloudflared_token" "app" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.app.id
}

resource "cloudflare_dns_record" "app" {
  zone_id = var.cloudflare_zone_id
  name    = local.hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.app.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
  comment = "Golden Balls AI (Cloudflare Tunnel, managed by Terraform)"
}
