import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { cachePut, intentCacheKey } from "../cache";

const app = new Hono<HonoEnv>();

app.post("/order", async (c) => {
  try {
    const body = await c.req.json<{ order: any; query?: string; intent?: Record<string, unknown> }>();
    const merchant = c.env.MERCHANT.get(c.env.MERCHANT.idFromName("default"));
    const result = await merchant.placeOrder({
      items: body.order.items.map((it: any) => ({
        product_id: it.product_id, product_name: it.product_name,
        quantity: it.quantity, unit_price: it.item_total / it.quantity,
        currency: it.currency || "AUD", modifiers: it.modifiers, note: it.note,
      })),
      total: body.order.total, currency: body.order.currency || "AUD",
    });
    if (body.query && body.intent) {
      const key = await intentCacheKey(body.query);
      cachePut(c.executionCtx, key, body.intent);
      console.log(`[cache] WRITE ${key} (on order placement) query="${body.query}"`);
    }
    return c.json({ ok: true, ...result });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.get("/orders", async (c) => {
  const merchant = c.env.MERCHANT.get(c.env.MERCHANT.idFromName("default"));
  const orders = await merchant.getOrders();
  return c.json({ ok: true, orders });
});

export default app;
