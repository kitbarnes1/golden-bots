terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.10"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State holds your API keys (they're passed in as variables), so keep it
  # somewhere private. To share it, uncomment and point at an S3 bucket you own:
  # backend "s3" {
  #   bucket       = "my-terraform-state"
  #   key          = "golden-balls/terraform.tfstate"
  #   region       = "eu-west-2"
  #   use_lockfile = true
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = "golden-balls"
      ManagedBy = "terraform"
    }
  }
}

# Reads CLOUDFLARE_API_TOKEN from the environment.
provider "cloudflare" {}
