export { Merchant } from "./merchant";

const SYSTEM_PROMPT = `You are a coffee shop ordering assistant. Given a menu and a customer's request, return a JSON object.

For orders, return:
{"items":[{"product":"product name","quantity":1,"modifiers":{"ModifierGroupName":"ChoiceName"},"note":"any special instructions"}]}

For menu inquiries ("show menu", "what do you have", "what's available"), return:
{"show_menu":true}

Rules:
- Match product names flexibly (e.g. "oat latte" → product "Latte" with Milk modifier "Oat")
- Only include modifiers the customer explicitly mentioned. Omit unmentioned ones — defaults are applied automatically.
- If quantity is not specified, assume 1.
- Modifier group names and choice names must match the menu exactly (case-insensitive matching is fine).
- If the customer mentions anything that is NOT a known modifier (e.g. "extra hot", "no sugar", "double shot", "iced", "decaf", "extra foam"), put it in the "note" field. Omit "note" if there are no special instructions.
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/menu") {
      const merchant = env.MERCHANT.get(env.MERCHANT.idFromName("default"));
      const menu = await merchant.getMenu();
      return Response.json({ menu });
    }

    if (url.pathname === "/api/query" && request.method === "POST") {
      let body: { query?: string };
      try { body = await request.json(); }
      catch { return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 }); }

      const query = body.query?.trim();
      if (!query) return Response.json({ ok: false, error: "No query provided" }, { status: 400 });

      try {
        const merchant = env.MERCHANT.get(env.MERCHANT.idFromName("default"));
        const menu = await merchant.getMenu();
        const menuText = formatMenuForAI(menu as Record<string, unknown>[]);

        const aiResponse = await env.AI.run(
          "@cf/meta/llama-4-scout-17b-16e-instruct" as BaseAiTextGenerationModels,
          { messages: [
              { role: "system", content: SYSTEM_PROMPT + "\n\nMenu:\n" + menuText },
              { role: "user", content: query },
            ], max_tokens: 512 }
        );

        let intent: Record<string, unknown>;
        const resp = aiResponse as Record<string, unknown>;
        if (resp.items || resp.show_menu) { intent = resp; }
        else if (typeof resp.response === "string") { intent = JSON.parse(extractJson(resp.response)); }
        else if (resp.response && typeof resp.response === "object") {
          const inner = resp.response as Record<string, unknown>;
          if (inner.items || inner.show_menu) intent = inner;
          else return Response.json({ ok: false, error: "Unexpected AI response", raw: JSON.stringify(aiResponse) }, { status: 500 });
        } else {
          return Response.json({ ok: false, error: "Unexpected AI response", raw: JSON.stringify(aiResponse) }, { status: 500 });
        }

        if (intent.show_menu) return Response.json({ ok: true, type: "menu", menu });

        if (!Array.isArray(intent.items) || intent.items.length === 0) {
          return Response.json({ ok: false, error: "Could not understand order", raw: JSON.stringify(intent) }, { status: 400 });
        }

        const workerCode = buildOrderWorker(menu as unknown[], intent);
        const worker = env.LOADER.load({
          compatibilityDate: "2026-01-28",
          mainModule: "worker.js",
          modules: { "worker.js": workerCode },
          globalOutbound: null,
        });

        const result = await worker.getEntrypoint().fetch(new Request("https://worker/"));
        const data = await result.json();
        return Response.json({ ok: true, type: "order", ...data as object });
      } catch (err) {
        console.error("[agent] error:", err);
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
