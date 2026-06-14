# @goodcraft/vercel

Automate [Vercel](https://vercel.com) DNS from
[swamp](https://github.com/swamp-club/swamp). This model wraps the Vercel REST
API to list the domains an account or team manages and to **idempotently upsert
DNS records** — it skips when an identical `type`+`name`+`value` record already
exists and creates it otherwise, so runs are safe to repeat.

The API token is supplied through `globalArguments.apiToken`, wired to a vault
expression at model-creation time — never a literal token. Team-scoped tokens
also need `teamId`.

## Installation

```sh
swamp extension pull @goodcraft/vercel
```

## Usage

```sh
# Create the model with the token wired to a vault (never inline)
swamp model create @goodcraft/vercel vercel \
  --global-arg apiToken='${{ vault.get(op-secrets, "Vercel/Token") }}'

# Read-only: list the domains Vercel manages (proves the token)
swamp model method run vercel sync

# Idempotently ensure a DNS record exists (skips if already present)
swamp model method run vercel upsertRecord \
  --input domain='example.com' \
  --input type='CNAME' \
  --input name='app' \
  --input value='cname.vercel-dns.com'
```

## Methods

- `sync` — list the account's domains (read-only; confirms the token).
- `upsertRecord` — ensure a single DNS record exists; `status` is `exists` when
  an identical record was already present, `created` otherwise.

## How it works

`upsertRecord` first reads the domain's existing records and matches on
`type`+`name`+`value`; only a genuine miss issues a create. Every call hits the
Vercel REST API directly with Deno `fetch`, appending the `teamId` query
parameter when a team-scoped token is configured.

## License

MIT — see [LICENSE.txt](LICENSE.txt).
