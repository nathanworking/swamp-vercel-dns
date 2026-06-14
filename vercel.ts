/**
 * Vercel DNS integration for swamp.
 *
 * Models a Vercel account/team and manages DNS records via the Vercel REST API
 * (https://api.vercel.com). v1 ships:
 * - `sync` — list the account's domains (read-only; confirms the token + shows
 *   which domains Vercel manages).
 * - `upsertRecord` — idempotently ensure a single DNS record exists (skip if an
 *   identical type+name+value already exists; create otherwise).
 *
 * The API token is supplied through `globalArguments.apiToken`, wired to a vault
 * expression at model-creation time — never a literal token. Team-scoped tokens
 * need `teamId`.
 *
 * @module
 */
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  /** Vercel API bearer token. Supply via a vault expression, never inline. */
  apiToken: z.string().min(1).meta({ sensitive: true }),
  /** Team id for team-scoped accounts (omit for a personal account). */
  teamId: z.string().optional(),
  /** API base URL (override only for testing/proxies). */
  baseUrl: z.string().default("https://api.vercel.com"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** A domain as returned by `GET /v5/domains`. */
const DomainSchema = z.object({
  name: z.string(),
}).passthrough();

const DomainsResourceSchema = z.object({
  count: z.number(),
  fetchedAt: z.iso.datetime(),
  domains: z.array(DomainSchema),
});

/** A DNS record as returned by `GET /v4/domains/{domain}/records`. */
const RecordSchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  value: z.string().default(""),
}).passthrough();

const UpsertResultSchema = z.object({
  fetchedAt: z.iso.datetime(),
  domain: z.string(),
  type: z.string(),
  name: z.string(),
  value: z.string(),
  status: z.enum(["exists", "created"]),
  recordId: z.string().optional(),
});

/** Append the team query param when a team-scoped token is configured. */
function teamSuffix(teamId: string | undefined, joiner = "?"): string {
  return teamId ? `${joiner}teamId=${encodeURIComponent(teamId)}` : "";
}

/** Call the Vercel API, throwing on any non-2xx response. */
async function vercel(
  args: GlobalArgs,
  method: string,
  path: string,
  signal: AbortSignal,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${args.baseUrl}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${args.apiToken}`,
      "Accept": "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Vercel ${method} ${path} failed: ${res.status} ${res.statusText} — ${
        text.slice(0, 300)
      }`,
    );
  }
  return await res.json().catch(() => ({})) as Record<string, unknown>;
}

/** Vercel account/team DNS model. */
export const model = {
  type: "@goodcraft/vercel",
  version: "2026.06.14.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    "domains": {
      description: "Snapshot of the domains managed in the Vercel account",
      schema: DomainsResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "recordUpsert": {
      description: "Result of the last upsertRecord call",
      schema: UpsertResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    sync: {
      description: "List the domains managed in the Vercel account (read-only)",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          signal: AbortSignal;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const payload = await vercel(
          context.globalArgs,
          "GET",
          `/v5/domains${teamSuffix(context.globalArgs.teamId)}`,
          context.signal,
        );
        const domains = z.array(DomainSchema).parse(payload.domains ?? []);

        context.logger.info("Synced {count} Vercel domains", {
          count: domains.length,
        });

        const handle = await context.writeResource("domains", "domains", {
          count: domains.length,
          fetchedAt: new Date().toISOString(),
          domains,
        });
        return { dataHandles: [handle] };
      },
    },
    upsertRecord: {
      description:
        "Idempotently ensure a DNS record exists (skip if an identical type+name+value record is already present)",
      arguments: z.object({
        domain: z.string().min(1),
        type: z.string().default("A"),
        name: z.string().default(""),
        value: z.string().min(1),
        ttl: z.number().default(60),
      }),
      execute: async (
        args: {
          domain: string;
          type: string;
          name: string;
          value: string;
          ttl: number;
        },
        context: {
          globalArgs: GlobalArgs;
          signal: AbortSignal;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const g = context.globalArgs;
        const existingPayload = await vercel(
          g,
          "GET",
          `/v4/domains/${encodeURIComponent(args.domain)}/records${
            teamSuffix(g.teamId)
          }`,
          context.signal,
        );
        const records = z.array(RecordSchema).parse(
          existingPayload.records ?? [],
        );
        const match = records.find(
          (r) =>
            r.type === args.type &&
            r.name === args.name &&
            r.value === args.value,
        );

        let status: "exists" | "created";
        let recordId: string | undefined;
        if (match) {
          status = "exists";
          recordId = match.id;
        } else {
          const created = await vercel(
            g,
            "POST",
            `/v2/domains/${encodeURIComponent(args.domain)}/records${
              teamSuffix(g.teamId)
            }`,
            context.signal,
            {
              type: args.type,
              name: args.name,
              value: args.value,
              ttl: args.ttl,
            },
          );
          status = "created";
          recordId = (created.uid as string | undefined) ??
            (created.id as string | undefined);
        }

        context.logger.info("DNS {type} {name}.{domain} -> {value}: {status}", {
          type: args.type,
          name: args.name || "@",
          domain: args.domain,
          value: args.value,
          status,
        });

        const handle = await context.writeResource(
          "recordUpsert",
          `${args.type}-${args.name || "apex"}-${args.domain}`,
          {
            fetchedAt: new Date().toISOString(),
            domain: args.domain,
            type: args.type,
            name: args.name,
            value: args.value,
            status,
            recordId,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
