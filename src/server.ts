import { Hono } from "hono";
import type { HonoEnv } from "./types";
import menu from "./routes/menu";
import orders from "./routes/orders";
import transcribe from "./routes/transcribe";
import query from "./routes/query";

export { Merchant } from "./merchant";

const app = new Hono<HonoEnv>();

app.route("/api/menu", menu);
app.route("/api/transcribe", transcribe);
app.route("/api/query", query);
app.route("/api", orders);

export default app;
