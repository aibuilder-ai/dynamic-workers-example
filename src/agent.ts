import { generateText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { cacheGet, cachePut, intentCacheKey } from "./cache";

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

export type AgentResult =
  | { type: "order"; order: any; intent: Record<string, unknown> }
  | { type: "menu"; menu: any[] }
  | { type: "orders"; orders: any[] }
  | { type: "answer"; answer: string }
  | { type: "error"; error: string };

export async function processQuery(
  env: Env,
  ctx: ExecutionContext,
  query: string,
  history?: { role: string; content: string }[]
): Promise<AgentResult> {
  const merchant = env.MERCHANT.get(env.MERCHANT.idFromName("default"));
  // Lazy-memoized: skip the DO round-trip on cache hits that don't need the menu, and dedupe when multiple branches do.
  let menuPromise: Promise<unknown[]> | null = null;
  const getMenu = () => (menuPromise ??= merchant.getMenu() as Promise<unknown[]>);

  const google = createGoogleGenerativeAI({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY });
  const model = google("gemini-3.1-flash-lite-preview");

  const cacheKey = await intentCacheKey(query);
  const cachedIntent = await cacheGet<Record<string, unknown>>(cacheKey);
  let intent: Record<string, unknown>;
  if (cachedIntent) {
    console.log(`[cache] HIT ${cacheKey} query="${query}"`);
    intent = cachedIntent;
  } else {
    console.log(`[cache] MISS ${cacheKey} query="${query}"`);
    const menu = await getMenu();
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

    const aiResult = await generateText({
      model,
      system: messages[0].content,
      messages: messages.slice(1).map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
      maxOutputTokens: 512,
    });
    try {
      intent = JSON.parse(extractJson(aiResult.text));
    } catch {
      return { type: "answer", answer: aiResult.text };
    }
    if (!Array.isArray(intent.items)) {
      cachePut(ctx, cacheKey, intent);
    }
  }

  if (typeof intent.message === "string") {
    return { type: "answer", answer: intent.message };
  }

  if (intent.show_menu) {
    return { type: "menu", menu: (await getMenu()) as any[] };
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

  const workerCode = buildOrderWorker(await getMenu(), intent);
  const worker = env.LOADER.load({
    compatibilityDate: "2026-01-28",
    mainModule: "worker.js",
    modules: { "worker.js": workerCode },
    globalOutbound: null,
  });

  const result = await worker.getEntrypoint().fetch(new Request("https://worker/"));
  const data = await result.json<{ order: any }>();
  return { type: "order", order: data.order, intent };
}
