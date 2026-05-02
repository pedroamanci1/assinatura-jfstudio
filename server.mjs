import "dotenv/config";
import fs from "node:fs/promises";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import Stripe from "stripe";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT || "", 10) || 3000;

let secretKey = (process.env.STRIPE_SECRET_KEY || "").trim();
secretKey = secretKey.replace(/^\uFEFF/, "");
if ((secretKey.startsWith('"') && secretKey.endsWith('"')) || (secretKey.startsWith("'") && secretKey.endsWith("'"))) {
  secretKey = secretKey.slice(1, -1).trim();
}

if (!secretKey) {
  console.error(`
Stripe: falta STRIPE_SECRET_KEY.

  Opção A — ficheiro .env na pasta do projeto (recomendado):
    STRIPE_SECRET_KEY=sk_live_...ou_sk_test_...

  Opção B — no terminal, antes de npm start:
    export STRIPE_SECRET_KEY="sk_..."
`);
  process.exit(1);
}

if (!/^sk_(live|test)_/.test(secretKey) && !/^rk_(live|test)_/.test(secretKey)) {
  console.warn(
    "Aviso: a chave não começa por sk_live_, sk_test_, rk_live_ nem rk_test_. Confirme no Stripe → Developers → API keys."
  );
}

const requestOptions = {};
const acct = (process.env.STRIPE_ACCOUNT || "").trim().replace(/^\uFEFF/, "");
if (acct) {
  requestOptions.stripeAccount = acct;
}

/** stripe-node v17: o 2.º argumento tem de ser um «options hash» (p.ex. stripeAccount). `{}` provoca "Unknown arguments". */
const stripeRequestOpts = Object.keys(requestOptions).length > 0 ? requestOptions : undefined;

const stripe = new Stripe(secretKey);

/** Evita expand profundo em listagens (a Stripe costuma rejeitar ou falhar). */
const STATUS_LIST = (process.env.STRIPE_SUBSCRIPTION_STATUSES || "active,trialing,past_due")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const keyMode = secretKey.includes("_live_") ? "live" : "test";

app.use(express.json({ limit: "24kb" }));

const TICKETS_PATH = path.join(__dirname, "data", "tickets.json");

async function readTicketsStore() {
  try {
    const raw = await fs.readFile(TICKETS_PATH, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return { version: 1, entries: {} };
    if (!data.entries) data.entries = {};
    return data;
  } catch {
    return { version: 1, entries: {} };
  }
}

async function writeTicketsStore(store) {
  await fs.mkdir(path.dirname(TICKETS_PATH), { recursive: true });
  await fs.writeFile(TICKETS_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

/** Valor guardado em `data/tickets.json` para o ano e a assinatura, ou `null` se ainda não existir. */
function getSavedCountdownFromStore(store, year, subscriptionId) {
  const node = store.entries?.[year]?.[subscriptionId];
  if (node == null || typeof node !== "object") return null;
  if (!Object.prototype.hasOwnProperty.call(node, "countdown")) return null;
  const n = node.countdown;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.floor(n), 1_000_000);
}

function assertSubscriptionId(id) {
  if (!id || typeof id !== "string" || !/^sub_[a-zA-Z0-9]+$/.test(id)) {
    const err = new Error("ID de assinatura inválido.");
    err.statusCode = 400;
    throw err;
  }
}

app.get("/api/tickets/:subscriptionId", async (req, res) => {
  try {
    const subscriptionId = req.params.subscriptionId;
    assertSubscriptionId(subscriptionId);
    const year = new Date().getFullYear();
    await stripe.subscriptions.retrieve(subscriptionId, stripeRequestOpts);
    const store = await readTicketsStore();
    const countdown = getSavedCountdownFromStore(store, year, subscriptionId);
    res.json({
      subscriptionId,
      year,
      countdown,
    });
  } catch (err) {
    const statusCode = err?.statusCode ?? err?.raw?.statusCode;
    const code = err?.code ?? err?.raw?.code;
    const status =
      statusCode === 404 || code === "resource_missing"
        ? 404
        : statusCode === 400
          ? 400
          : 500;
    const message =
      typeof err?.message === "string" ? err.message : "Erro ao carregar tickets.";
    if (status === 500) console.error("GET /api/tickets:", err);
    res.status(status).json({ error: message });
  }
});

app.put("/api/tickets/:subscriptionId", async (req, res) => {
  try {
    const subscriptionId = req.params.subscriptionId;
    assertSubscriptionId(subscriptionId);
    const raw = req.body?.countdown;
    const countdown = parseInt(String(raw), 10);
    if (Number.isNaN(countdown) || countdown < 0 || countdown > 1_000_000) {
      res.status(400).json({ error: "O contador tem de ser um número inteiro entre 0 e 1 000 000." });
      return;
    }
    await stripe.subscriptions.retrieve(subscriptionId, stripeRequestOpts);
    const year = new Date().getFullYear();
    const store = await readTicketsStore();
    store.version = 1;
    if (!store.entries) store.entries = {};
    if (!store.entries[year]) store.entries[year] = {};
    if (!store.entries[year][subscriptionId]) store.entries[year][subscriptionId] = {};
    store.entries[year][subscriptionId].countdown = countdown;
    await writeTicketsStore(store);
    res.json({ ok: true, subscriptionId, year, countdown });
  } catch (err) {
    const statusCode = err?.statusCode ?? err?.raw?.statusCode;
    const code = err?.code ?? err?.raw?.code;
    const status =
      statusCode === 404 || code === "resource_missing"
        ? 404
        : statusCode === 400
          ? 400
          : 500;
    const message =
      typeof err?.message === "string" ? err.message : "Erro ao guardar.";
    if (status === 500) console.error("PUT /api/tickets:", err);
    res.status(status).json({ error: message });
  }
});

async function listAllSubscriptions(status) {
  const out = [];
  let startingAfter;

  for (;;) {
    const page = await stripe.subscriptions.list(
      {
        status,
        limit: 100,
        starting_after: startingAfter,
        expand: ["data.customer"],
      },
      stripeRequestOpts
    );

    out.push(...page.data);
    if (!page.has_more) break;
    startingAfter = page.data[page.data.length - 1].id;
  }

  return out;
}

async function retrievePriceLabel(priceId) {
  const price = await stripe.prices.retrieve(
    priceId,
    { expand: ["product"] },
    stripeRequestOpts
  );
  const product = price.product;
  if (typeof product === "object" && product && "name" in product && product.name) {
    return product.name;
  }
  if (price.nickname) return price.nickname;
  return "Assinatura";
}

app.get("/api/subscriptions", async (_req, res) => {
  try {
    const byId = new Map();

    for (const status of STATUS_LIST) {
      const batch = await listAllSubscriptions(status);
      for (const sub of batch) {
        byId.set(sub.id, sub);
      }
    }

    const subs = [...byId.values()];
    const priceIds = new Set();

    for (const sub of subs) {
      for (const item of sub.items?.data ?? []) {
        const ref = item.price;
        const id = typeof ref === "string" ? ref : ref?.id;
        if (id) priceIds.add(id);
      }
    }

    const priceLabels = new Map();
    const ids = [...priceIds];
    const chunkSize = 25;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const slice = ids.slice(i, i + chunkSize);
      const labels = await Promise.all(slice.map((id) => retrievePriceLabel(id)));
      slice.forEach((id, j) => priceLabels.set(id, labels[j]));
    }

    const year = new Date().getFullYear();
    const ticketsStore = await readTicketsStore();

    const rows = [];

    for (const sub of subs) {
      const customer = sub.customer;
      let customerName = "Cliente";

      if (customer && typeof customer === "object") {
        if ("deleted" in customer && customer.deleted) {
          customerName = customer.id ? `Cliente removido (${customer.id})` : "Cliente removido";
        } else {
          customerName =
            customer.name || customer.email || customer.description || customer.id;
        }
      } else if (typeof customer === "string") {
        try {
          const c = await stripe.customers.retrieve(customer, stripeRequestOpts);
          if (c && !c.deleted) {
            customerName = c.name || c.email || c.description || customer;
          } else {
            customerName = `Cliente (${customer})`;
          }
        } catch {
          customerName = `Cliente (${customer})`;
        }
      }

      const productNames = [];
      for (const item of sub.items?.data ?? []) {
        const ref = item.price;
        const pid = typeof ref === "string" ? ref : ref?.id;
        productNames.push(pid ? priceLabels.get(pid) || "Assinatura" : "Assinatura");
      }

      const countdown = getSavedCountdownFromStore(ticketsStore, year, sub.id);

      const startTs =
        typeof sub.start_date === "number" && Number.isFinite(sub.start_date)
          ? sub.start_date
          : typeof sub.created === "number" && Number.isFinite(sub.created)
            ? sub.created
            : null;

      rows.push({
        id: sub.id,
        customerName,
        products: [...new Set(productNames)],
        status: sub.status,
        countdown,
        subscriptionStart: startTs,
      });
    }

    rows.sort((a, b) => a.customerName.localeCompare(b.customerName, "pt"));

    res.json({
      subscriptions: rows,
      meta: {
        keyMode,
        statusesQueried: STATUS_LIST,
        count: rows.length,
        ticketsYear: year,
      },
    });
  } catch (err) {
    const raw = err?.raw ?? err;
    const message =
      raw instanceof Error
        ? raw.message
        : typeof raw?.message === "string"
          ? raw.message
          : String(err);
    console.error("GET /api/subscriptions:", message);
    res.status(500).json({ error: message });
  }
});

app.use(express.static(path.join(__dirname, "public")));

const MAX_PORT_TRIES = 15;

function startListening(port, attempt) {
  const server = app.listen(port, () => {
    console.log(`Servidor: http://localhost:${port}`);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && attempt < MAX_PORT_TRIES) {
      const next = port + 1;
      console.warn(`Porta ${port} em uso. A usar ${next}…`);
      startListening(next, attempt + 1);
      return;
    }
    if (err.code === "EADDRINUSE") {
      console.error(
        `Nenhuma porta livre entre ${PORT} e ${PORT + MAX_PORT_TRIES}. Feche o outro programa ou defina PORT, por exemplo: PORT=4000 npm start`
      );
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}

startListening(PORT, 0);
