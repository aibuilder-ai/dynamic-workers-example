import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { processQuery } from "../agent";

const app = new Hono<HonoEnv>();

app.post("/", async (c) => {
  let body: { query?: string; history?: { role: string; content: string }[] };
  try { body = await c.req.json(); }
  catch { return c.json({ ok: false, error: "Invalid JSON body" }, 400); }

  const query = body.query?.trim();
  if (!query) return c.json({ ok: false, error: "No query provided" }, 400);

  try {
    const result = await processQuery(c.env, c.executionCtx, query, body.history);
    switch (result.type) {
      case "error":
        return c.json({ ok: false, error: result.error }, 400);
      case "order":
        return c.json({ ok: true, type: "order", order: result.order, intent: result.intent });
      case "menu":
        return c.json({ ok: true, type: "menu", menu: result.menu });
      case "orders":
        return c.json({ ok: true, type: "orders", orders: result.orders });
      case "answer":
        return c.json({ ok: true, type: "answer", answer: result.answer });
    }
  } catch (err) {
    console.error("[agent] error:", err);
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

export default app;
