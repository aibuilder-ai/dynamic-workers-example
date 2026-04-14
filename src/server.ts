export { Merchant } from "./merchant";

import { generateText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

const SYSTEM_PROMPT = `You are a coffee shop ordering assistant. Given a menu and a customer's request, return a JSON object.

For orders, return:
{"items":[{"product":"product name","quantity":1,"modifiers":{"ModifierGroupName":"ChoiceName"},"note":"any special instructions"}]}

For greetings, chitchat, or anything that is not an order/menu/order-history request, return:
{"message":"a short friendly reply"}

For menu inquiries ("show menu", "what do you have", "what's available"), return:
{"show_menu":true}

For "show ALL my orders" (no filter, no limit), return:
{"show_orders":true}

For ANY specific, filtered, or analytical question about past orders, return a SQL query:
{"query_orders":"A SELECT SQL query against the orders schema"}

Use query_orders for: last N orders, most expensive, cheapest, how many, how much spent, orders containing a specific product, orders from a date, etc.

Orders schema:
- orders (id TEXT PK, total INTEGER [cents], currency TEXT, status TEXT, created_at TEXT)
- order_items (id INTEGER PK, order_id TEXT FK, product_retailer_id TEXT, product_name TEXT, quantity INTEGER, unit_price INTEGER [cents], currency TEXT, modifiers TEXT [JSON], note TEXT)

Examples:
- "last 2 orders" → {"query_orders":"SELECT o.id, o.total, o.currency, o.status, o.created_at, oi.product_name, oi.quantity, oi.unit_price, oi.modifiers, oi.note FROM orders o JOIN order_items oi ON oi.order_id = o.id ORDER BY o.created_at DESC LIMIT 10"}
- "most expensive thing I ordered" → {"query_orders":"SELECT oi.product_name, oi.unit_price, o.created_at FROM order_items oi JOIN orders o ON o.id = oi.order_id ORDER BY oi.unit_price DESC LIMIT 1"}
- "how much have I spent total" → {"query_orders":"SELECT SUM(total) as total_spent FROM orders"}
- "how many lattes" → {"query_orders":"SELECT SUM(quantity) as count FROM order_items WHERE LOWER(product_name) LIKE '%latte%'"}
- "did I order anything today" → {"query_orders":"SELECT o.id, o.total, o.created_at, oi.product_name, oi.quantity FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE date(o.created_at) = date('now') ORDER BY o.created_at DESC"}

Rules:
- Match product names flexibly (e.g. "oat latte" → product "Latte" with Milk modifier "Oat")
- Only include modifiers the customer explicitly mentioned. Omit unmentioned ones — defaults are applied automatically.
- If quantity is not specified, assume 1.
- Modifier group names and choice names must match the menu exactly (case-insensitive matching is fine).
- If some items in a batch have different notes or modifiers, split them into separate line items. E.g. "10 oat latte 2 with one sugar" → two items: 8x oat latte (no note) + 2x oat latte (note: "one sugar"). "5 flat whites, 1 extra hot" → 4x flat white + 1x flat white (note: "extra hot").
- Sugar is a known modifier with values "None", "1", "2", "3", "4", "5". If the customer says "2 sugars", set "Sugar":"2". If they say "no sugar", set "Sugar":"None".
- If the customer mentions anything that is NOT a known modifier (e.g. "extra hot", "double shot", "iced", "decaf", "extra foam"), put it in the "note" field. Omit "note" if there are no special instructions.
- "2 flat white with 2 sugars and an oat cappuccino" → {"items":[{"product":"flat white","quantity":2,"modifiers":{"Sugar":"2"}},{"product":"cappuccino","quantity":1,"modifiers":{"Milk":"Oat"}}]}
- Return ONLY valid JSON. No markdown, no code fences, no explanation.`;

function formatMenuForAI(menu: Record<string, unknown>[]): string {
  return (menu as any[])
    .map(
      (p) =>
        `${p.title} ($${(p.price / 100).toFixed(2)}) [${p.category}]` +
        (p.modifier_groups.length
          ? " — " +
            p.modifier_groups
              .map(
                (g: any) =>
                  `${g.name}: ${g.modifiers
                    .map(
                      (m: any) =>
                        m.name +
                        (m.is_default ? "*" : "") +
                        (m.price_delta ? ` +$${(m.price_delta / 100).toFixed(2)}` : "")
                    )
                    .join(", ")}`
              )
              .join("; ")
          : "")
    )
    .join("\n");
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1) return text.slice(start, end + 1);
  return text.trim();
}

function buildOrderWorker(menu: unknown[], intent: unknown): string {
  return `
const MENU = ${JSON.stringify(menu)};
const INTENT = ${JSON.stringify(intent)};

export default {
  async fetch() {
    const items = [];
    for (const item of INTENT.items) {
      const query = item.product.toLowerCase();
      const product = MENU.find(p =>
        p.title.toLowerCase().includes(query) ||
        p.retailer_id.toLowerCase() === query
      );
      if (!product) { items.push({ error: "Product not found: " + item.product }); continue; }

      const appliedMods = [];
      let modTotal = 0;
      for (const [groupName, choiceName] of Object.entries(item.modifiers || {})) {
        const group = product.modifier_groups.find(g => g.name.toLowerCase() === groupName.toLowerCase());
        if (group) {
          const m = group.modifiers.find(mod => mod.name.toLowerCase() === choiceName.toLowerCase());
          if (m) { appliedMods.push({ group: group.name, choice: m.name, price_delta: m.price_delta }); modTotal += m.price_delta; }
        }
      }
      for (const group of product.modifier_groups) {
        if (!appliedMods.find(am => am.group === group.name)) {
          const def = group.modifiers.find(m => m.is_default);
          if (def) { appliedMods.push({ group: group.name, choice: def.name, price_delta: def.price_delta }); modTotal += def.price_delta; }
        }
      }
      const qty = item.quantity || 1;
      const entry = { product_id: product.retailer_id, product_name: product.title, base_price: product.price, quantity: qty, modifiers: appliedMods, item_total: (product.price + modTotal) * qty, currency: product.currency };
      if (item.note) entry.note = item.note;
      items.push(entry);
    }
    const total = items.reduce((s, i) => s + (i.item_total || 0), 0);
    return Response.json({ order: { items, total, currency: "AUD" } });
  }
};`;
}

const cents = (n: number) => `$${(n / 100).toFixed(2)}`;

// ── Shared agent logic ───────────────────────────────────────

type AgentResult =
  | { type: "order"; order: any }
  | { type: "menu"; menu: any[] }
  | { type: "orders"; orders: any[] }
  | { type: "answer"; answer: string }
  | { type: "error"; error: string };

async function processQuery(
  env: Env,
  query: string,
  history?: { role: string; content: string }[]
): Promise<AgentResult> {
  const merchant = env.MERCHANT.get(env.MERCHANT.idFromName("default"));
  const menu = await merchant.getMenu();
  const menuText = formatMenuForAI(menu as Record<string, unknown>[]);

  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: SYSTEM_PROMPT + "\n\nMenu:\n" + menuText },
  ];
  for (const h of (history ?? []).slice(-10)) {
    if (h.role === "user" || h.role === "assistant") {
      messages.push({ role: h.role, content: h.content });
    }
  }
  messages.push({ role: "user", content: query });

  const google = createGoogleGenerativeAI({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY });
  const model = google("gemini-3.1-flash-lite-preview");

  const aiResult = await generateText({
    model,
    system: messages[0].content,
    messages: messages.slice(1).map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
    maxOutputTokens: 512,
  });

  let intent: Record<string, unknown>;
  try {
    intent = JSON.parse(extractJson(aiResult.text));
  } catch {
    return { type: "answer", answer: aiResult.text };
  }

  if (typeof intent.message === "string") {
    return { type: "answer", answer: intent.message };
  }

  if (intent.show_menu) {
    return { type: "menu", menu: menu as any[] };
  }

  if (intent.show_orders) {
    const orders = await merchant.getOrders();
    return { type: "orders", orders: orders as any[] };
  }

  if (typeof intent.query_orders === "string") {
    const rows = await merchant.query(intent.query_orders);
    const answerResult = await generateText({
      model,
      system: "You are a helpful assistant. Given a user's question and SQL query results, write a short, friendly answer. Prices are in cents — convert to dollars (e.g. 670 → $6.70). Return ONLY the answer text, no JSON.",
      prompt: `Question: ${query}\n\nQuery results:\n${JSON.stringify(rows)}`,
      maxOutputTokens: 256,
    });
    return { type: "answer", answer: answerResult.text };
  }

  if (!Array.isArray(intent.items) || intent.items.length === 0) {
    return { type: "error", error: "Could not understand order" };
  }

  const workerCode = buildOrderWorker(menu as unknown[], intent);
  const worker = env.LOADER.load({
    compatibilityDate: "2026-01-28",
    mainModule: "worker.js",
    modules: { "worker.js": workerCode },
    globalOutbound: null,
  });

  const result = await worker.getEntrypoint().fetch(new Request("https://worker/"));
  const data = await result.json<{ order: any }>();
  return { type: "order", order: data.order };
}

// ── Format result as plain text (for Messenger) ──────────────

function formatResultAsText(result: AgentResult): string {
  if (result.type === "answer" || result.type === "error") {
    return result.type === "answer" ? result.answer : result.error;
  }
  if (result.type === "menu") {
    return result.menu
      .map((p: any) => `${p.title} — ${cents(p.price)}`)
      .join("\n");
  }
  if (result.type === "orders") {
    if (result.orders.length === 0) return "No orders yet.";
    return result.orders
      .map((o: any) =>
        `Order ${new Date(o.created_at).toLocaleDateString()}: ${o.items.map((it: any) => `${it.quantity > 1 ? it.quantity + "x " : ""}${it.product_name}`).join(", ")} — ${cents(o.total)}`
      )
      .join("\n");
  }
  if (result.type === "order") {
    const o = result.order;
    const lines = o.items.map((it: any) => {
      const mods = it.modifiers
        .filter((m: any) => m.price_delta > 0)
        .map((m: any) => m.choice)
        .join(", ");
      return `${it.product_name}${mods ? ` (${mods})` : ""} x${it.quantity} — ${cents(it.item_total)}${it.note ? ` [${it.note}]` : ""}`;
    });
    lines.push(`Total: ${cents(o.total)} ${o.currency}`);
    return lines.join("\n");
  }
  return "Something went wrong.";
}

// ── Messenger helpers ────────────────────────────────────────

async function verifySignature(request: Request, appSecret: string): Promise<boolean> {
  const signature = request.headers.get("x-hub-signature-256");
  if (!signature) return false;
  const [, hash] = signature.split("=");
  if (!hash) return false;
  const body = await request.clone().arrayBuffer();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, body);
  const expected = [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hash === expected;
}

async function sendMessengerReply(pageToken: string, recipientId: string, text: string) {
  await fetch(`https://graph.facebook.com/v22.0/me/messages?access_token=${pageToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text: text.slice(0, 2000) },
    }),
  });
}

// ── Main handler ─────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ── Webhook verification (GET) ───────────────────────────
    if (url.pathname === "/webhook" && request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");

      if (mode === "subscribe" && token === env.FB_VERIFY_TOKEN) {
        return new Response(challenge, { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }

    // ── Webhook events (POST) ────────────────────────────────
    if (url.pathname === "/webhook" && request.method === "POST") {
      // Validate signature
      if (env.FB_APP_SECRET) {
        const valid = await verifySignature(request, env.FB_APP_SECRET);
        if (!valid) return new Response("Invalid signature", { status: 403 });
      }

      const body = await request.json<{
        object: string;
        entry?: { messaging?: { sender: { id: string }; message?: { text?: string } }[] }[];
      }>();

      if (body.object !== "page") {
        return new Response("Not found", { status: 404 });
      }

      // Process messages asynchronously
      const messagesToProcess: { senderId: string; text: string }[] = [];
      for (const entry of body.entry ?? []) {
        for (const event of entry.messaging ?? []) {
          if (event.message?.text) {
            messagesToProcess.push({ senderId: event.sender.id, text: event.message.text });
          }
        }
      }

      if (messagesToProcess.length > 0) {
        ctx.waitUntil(
          Promise.all(
            messagesToProcess.map(async ({ senderId, text }) => {
              try {
                const result = await processQuery(env, text);
                const reply = formatResultAsText(result);
                await sendMessengerReply(env.FB_PAGE_ACCESS_TOKEN, senderId, reply);
              } catch (err) {
                console.error("[webhook] error processing message:", err);
                await sendMessengerReply(
                  env.FB_PAGE_ACCESS_TOKEN,
                  senderId,
                  "Sorry, something went wrong. Please try again."
                );
              }
            })
          )
        );
      }

      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    // ── API routes ───────────────────────────────────────────

    if (url.pathname === "/api/menu") {
      const merchant = env.MERCHANT.get(env.MERCHANT.idFromName("default"));
      const menu = await merchant.getMenu();
      return Response.json({ menu });
    }

    if (url.pathname === "/api/order" && request.method === "POST") {
      try {
        const body = await request.json<{ order: any }>();
        const merchant = env.MERCHANT.get(env.MERCHANT.idFromName("default"));
        const result = await merchant.placeOrder({
          items: body.order.items.map((it: any) => ({
            product_id: it.product_id, product_name: it.product_name,
            quantity: it.quantity, unit_price: it.item_total / it.quantity,
            currency: it.currency || "AUD", modifiers: it.modifiers, note: it.note,
          })),
          total: body.order.total, currency: body.order.currency || "AUD",
        });
        return Response.json({ ok: true, ...result });
      } catch (err) {
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (url.pathname === "/api/orders") {
      const merchant = env.MERCHANT.get(env.MERCHANT.idFromName("default"));
      const orders = await merchant.getOrders();
      return Response.json({ ok: true, orders });
    }

    if (url.pathname === "/api/query" && request.method === "POST") {
      let body: { query?: string; history?: { role: string; content: string }[] };
      try { body = await request.json(); }
      catch { return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 }); }

      const query = body.query?.trim();
      if (!query) return Response.json({ ok: false, error: "No query provided" }, { status: 400 });

      try {
        const result = await processQuery(env, query, body.history);
        if (result.type === "error") {
          return Response.json({ ok: false, error: result.error }, { status: 400 });
        }
        if (result.type === "order") {
          return Response.json({ ok: true, type: "order", order: result.order });
        }
        if (result.type === "menu") {
          return Response.json({ ok: true, type: "menu", menu: result.menu });
        }
        if (result.type === "orders") {
          return Response.json({ ok: true, type: "orders", orders: result.orders });
        }
        if (result.type === "answer") {
          return Response.json({ ok: true, type: "answer", answer: result.answer });
        }
        return Response.json({ ok: false, error: "Unknown result type" }, { status: 500 });
      } catch (err) {
        console.error("[agent] error:", err);
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
