# @goodcraft/vercel

Automate [Vercel](https://vercel.com) DNS from
[swamp](https://github.com/swamp-club/swamp). This model wraps the Vercel REST
API to **fully manage a domain's DNS** — list the account's domains, list a
domain's records, **idempotently upsert** records (skip when an identical
`type`+`name`+`value` already exists), and **delete** records by id. Together
that's enough to re-point an apex from Vercel to an external server (e.g. a Forge
box) cleanly.

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

# List a domain's records (read-only) — find record ids
swamp model method run vercel listRecords --input domain='example.com'

# Idempotently ensure a DNS record exists (skips if already present)
swamp model method run vercel upsertRecord \
  --input domain='example.com' \
  --input type='CNAME' \
  --input name='app' \
  --input value='cname.vercel-dns.com'

# Delete a record by id — dryRun defaults true; re-run with dryRun=false
swamp model method run vercel deleteRecord \
  --input domain='example.com' --input recordId='rec_...' --input dryRun=false
```

## Methods

- `sync` — list the account's domains (read-only; confirms the token).
- `listRecords` — list a domain's DNS records (read-only); use it to find record
  ids.
- `upsertRecord` — ensure a single DNS record exists; `status` is `exists` when
  an identical record was already present, `created` otherwise.
- `deleteRecord` — delete a record by id (`dryRun: true` default; a missing
  record reports `absent`).

## How it works

`upsertRecord` first reads the domain's existing records and matches on
`type`+`name`+`value`; only a genuine miss issues a create. Every call hits the
Vercel REST API directly with Deno `fetch`, appending the `teamId` query
parameter when a team-scoped token is configured.

## Note: Vercel "default" records

When a domain is added to Vercel, Vercel creates auto-managed records (e.g. the
apex / `*` as an `ALIAS` → `cname.vercel-dns-*.com`). The Vercel **dashboard**
hides these and won't let you delete them there — but the **API exposes them**
with real ids, and `deleteRecord` *can* remove them. To re-point an apex from
Vercel to an external server (e.g. a Forge box):

1. `listRecords` → find the apex `ALIAS`/`A` record id.
2. `deleteRecord` that id (the apex can't hold both an `ALIAS` and an `A`).
3. `upsertRecord` your own `A` record → the server IP.

The apex's `CAA` records (if present) control which CAs may issue certificates —
make sure your CA (e.g. `letsencrypt.org`) is allowed before requesting a cert.
If the domain is still attached to a Vercel **project**, Vercel may re-create its
record; detach the project if you see it come back.

## License

MIT — see [LICENSE.txt](LICENSE.txt).
