import { Router } from "express";
import { buildSchema, graphql } from "graphql";
import * as StellarSdk from "@stellar/stellar-sdk";
import {
  PersistedQueryCache,
  PersistedQueryError,
  type GraphQLRequest,
} from "../lib/apq.js";
import { getUsageHistory } from "../lib/usageEvents.js";
import { stellarService, server, CONTRACT_ID } from "../lib/stellar.js";
import { logger } from "../lib/logger.js";

export const schema = buildSchema(`
  type UsageEvent {
    id: Int!
    meterId: String!
    units: Float!
    cost: String!
    receivedAt: String!
    transactionHash: String
  }

  type UsageHistory {
    events: [UsageEvent!]!
    page: Int!
    pageSize: Int!
    total: Int!
    hasMore: Boolean!
  }

  type MeterBalance { meterId: String!, balance: String!, updatedAt: String! }
  type MeterStatus { meterId: String!, status: String!, updatedAt: String! }
  type Payment {
    txHash: String!
    address: String!
    meterId: String
    amountXlm: Float
    plan: String
    status: String!
    confirmedAt: String!
    date: String
    memo: String
  }
  type UsageUpdate { meterId: String!, units: Float!, cost: String!, updatedAt: String! }

  type Meter {
    id: String!
    owner: String!
    active: Boolean!
    unitsUsed: Float!
    plan: String!
    lastPayment: String!
    expiresAt: String!
    dailyLimit: Float
    daySpent: Float
    balance: String
    payments: [Payment!]!
    usageHistory(page: Int = 1, pageSize: Int = 20): UsageHistory!
  }

  type Subscription {
    meterBalanceChanged(meterId: String!): MeterBalance!
    meterStatusChanged(meterId: String!): MeterStatus!
    paymentConfirmed(address: String!): Payment!
    usageUpdated(meterId: String!): UsageUpdate!
  }

  type Query {
    health: String!
    meter(id: String!): Meter
    metersByOwner(address: String!): [Meter!]!
    payments(meterId: String!): [Payment!]!
    usageHistory(meterId: String!, page: Int = 1, pageSize: Int = 20): UsageHistory!
  }
`);

const persistedQueries = new PersistedQueryCache();

export async function fetchMeter(id: string) {
  try {
    const result = await stellarService.query("get_meter", [
      StellarSdk.nativeToScVal(id, { type: "symbol" }),
    ]);
    const native = StellarSdk.scValToNative(result);
    return native ?? null;
  } catch {
    return null;
  }
}

export async function fetchMeterBalance(id: string): Promise<string> {
  try {
    const result = await stellarService.query("get_meter_balance", [
      StellarSdk.nativeToScVal(id, { type: "symbol" }),
    ]);
    const native = StellarSdk.scValToNative(result);
    return String(native ?? 0);
  } catch {
    return "0";
  }
}

export async function fetchMetersByOwner(address: string) {
  try {
    const result = await stellarService.query("get_meters_by_owner", [
      StellarSdk.nativeToScVal(address, { type: "address" }),
    ]);
    const native = StellarSdk.scValToNative(result);
    return Array.isArray(native) ? native : [];
  } catch {
    return [];
  }
}

export async function fetchPaymentsForMeter(meterId: string): Promise<any[]> {
  try {
    const EVT_NS = StellarSdk.xdr.ScVal.scvSymbol("solargrid").toXDR("base64");
    const ACTION = StellarSdk.xdr.ScVal.scvSymbol("payment").toXDR("base64");

    const response = await (server as any).getEvents({
      startLedger: 1,
      filters: [
        {
          type: "contract",
          contractIds: [CONTRACT_ID],
          topics: [[EVT_NS, ACTION]],
        },
      ],
      limit: 1000,
    });

    const payments: any[] = [];
    for (const event of response?.events ?? []) {
      try {
        const topics = (event.topic ?? []).map((t: string) =>
          StellarSdk.xdr.ScVal.fromXDR(t, "base64"),
        );
        if (topics.length >= 3) {
          const mVal = topics[2];
          const mId =
            mVal.switch().name === "scvSymbol"
              ? mVal.sym().toString()
              : mVal.switch().name === "scvString"
              ? mVal.str().toString()
              : "unknown";
          if (mId === meterId) {
            const dataXdr = event.value ?? event.data;
            const dataVal = StellarSdk.xdr.ScVal.fromXDR(dataXdr, "base64");
            const native = StellarSdk.scValToNative(dataVal);
            const [payer, , amount, plan, memo] = Array.isArray(native)
              ? native
              : [null, null, 0, "Daily", null];
            const amountXlm = Number(amount ?? 0) / 10_000_000;
            const planStr =
              typeof plan === "object" && plan !== null
                ? Object.keys(plan)[0]
                : String(plan ?? "Daily");
            payments.push({
              txHash: event.txHash ?? event.id ?? "",
              address: String(payer ?? ""),
              meterId: mId,
              amountXlm,
              plan: planStr,
              status: "Completed",
              confirmedAt: event.ledgerClosedAt ?? new Date().toISOString(),
              date: event.ledgerClosedAt ?? new Date().toISOString(),
              memo: memo ? String(memo) : undefined,
            });
          }
        }
      } catch {
        // ignore malformed event
      }
    }
    return payments;
  } catch (err: any) {
    logger.warn({ err: err?.message, meterId }, "Failed to fetch payments for meter in GraphQL");
    return [];
  }
}

export function formatMeter(id: string, m: any, balance = "0") {
  return {
    id: id || String(m.id ?? m.meter_id ?? ""),
    owner: String(m.owner ?? ""),
    active: Boolean(m.active),
    unitsUsed: Number(m.units_used ?? m.unitsUsed ?? 0),
    plan:
      typeof m.plan === "object" && m.plan !== null
        ? Object.keys(m.plan)[0]
        : String(m.plan ?? "Daily"),
    lastPayment: String(m.last_payment ?? m.lastPayment ?? ""),
    expiresAt: String(m.expires_at ?? m.expiresAt ?? ""),
    dailyLimit: Number(m.daily_limit ?? m.dailyLimit ?? 0),
    daySpent: Number(m.day_spent ?? m.daySpent ?? 0),
    balance: String(balance),
    payments: async () => fetchPaymentsForMeter(id || String(m.id ?? m.meter_id ?? "")),
    usageHistory: ({
      page = 1,
      pageSize = 20,
    }: {
      page?: number;
      pageSize?: number;
    }) => {
      const meterId = id || String(m.id ?? m.meter_id ?? "");
      return rootValue.usageHistory({ meterId, page, pageSize });
    },
  };
}

export const rootValue = {
  health: () => "ok",
  meter: async ({ id }: { id: string }) => {
    const meterData = await fetchMeter(id);
    if (!meterData) return null;
    const balance = await fetchMeterBalance(id);
    return formatMeter(id, meterData, balance);
  },
  metersByOwner: async ({ address }: { address: string }) => {
    const list = await fetchMetersByOwner(address);
    const results = await Promise.all(
      list.map(async (item: any) => {
        const id =
          typeof item === "string" ? item : String(item.id ?? item.meter_id ?? "");
        const meterData =
          typeof item === "object" && item !== null ? item : await fetchMeter(id);
        const balance = await fetchMeterBalance(id);
        return formatMeter(id, meterData ?? {}, balance);
      }),
    );
    return results;
  },
  payments: async ({ meterId }: { meterId: string }) => {
    return fetchPaymentsForMeter(meterId);
  },
  usageHistory: ({
    meterId,
    page = 1,
    pageSize = 20,
  }: {
    meterId: string;
    page?: number;
    pageSize?: number;
  }) => {
    const safePage = Math.max(1, Math.trunc(page));
    const safePageSize = Math.min(100, Math.max(1, Math.trunc(pageSize)));
    const history = getUsageHistory(meterId, safePage, safePageSize);
    return {
      ...history,
      events: history.events.map((event) => ({
        id: event.id,
        meterId: event.meter_id,
        units: event.units,
        cost: event.cost,
        receivedAt: event.received_at,
        transactionHash: event.on_chain_tx_hash,
      })),
    };
  },
};

function renderGraphQLPlayground(): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SolarGrid GraphQL Playground</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/graphql-playground-react/build/static/css/index.css" />
    <link rel="shortcut icon" href="https://cdn.jsdelivr.net/npm/graphql-playground-react/build/favicon.png" />
    <script src="https://cdn.jsdelivr.net/npm/graphql-playground-react/build/static/js/middleware.js"></script>
  </head>
  <body>
    <div id="root"></div>
    <script>
      window.addEventListener('load', function (event) {
        GraphQLPlayground.init(document.getElementById('root'), {
          endpoint: '/graphql',
          subscriptionEndpoint: '/api/graphql'
        });
      });
    </script>
  </body>
</html>`;
}

export const graphqlRouter = Router();

graphqlRouter.get("/", (req, res) => {
  const isDev = process.env.NODE_ENV !== "production";
  const acceptsHtml = req.accepts("html");
  if (isDev || acceptsHtml) {
    return res.status(200).type("html").send(renderGraphQLPlayground());
  }
  return res.status(405).json({
    error: "GET not supported for GraphQL endpoint in production. Use POST.",
  });
});

graphqlRouter.post("/", async (req, res) => {
  const request = (req.body ?? {}) as GraphQLRequest;
  try {
    const query = persistedQueries.resolve(request);
    const result = await graphql({
      schema,
      source: query,
      rootValue,
      variableValues: request.variables,
      operationName: request.operationName,
    });
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof PersistedQueryError) {
      return res.status(200).json({
        errors: [{ message: error.message, extensions: { code: error.code } }],
      });
    }
    const message = error instanceof Error ? error.message : "Invalid GraphQL request";
    return res.status(400).json({ errors: [{ message }] });
  }
});

export function clearPersistedQueriesForTests(): void {
  persistedQueries.clear();
}
