// Access values are managed on the existing Worker and preserved by --keep-vars.
interface Env {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

declare namespace Cloudflare {
  interface Env {
    ACCESS_TEAM_DOMAIN?: string;
    ACCESS_AUD?: string;
  }
}
