import { Hono } from "hono";
import type { HonoEnv } from "../types";

const app = new Hono<HonoEnv>();

app.get("/", async (c) => {
  const merchant = c.env.MERCHANT.get(c.env.MERCHANT.idFromName("default"));
  const menu = await merchant.getMenu();
  return c.json({ menu });
});

export default app;
