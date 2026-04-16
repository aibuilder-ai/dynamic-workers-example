import { Hono } from "hono";
import type { HonoEnv } from "../types";

const app = new Hono<HonoEnv>();

app.post("/", async (c) => {
  try {
    const formData = await c.req.formData();
    const audioFile = formData.get("audio");
    if (!audioFile || !(audioFile instanceof Blob)) {
      return c.json({ ok: false, error: "No audio file provided" }, 400);
    }
    const buffer = await audioFile.arrayBuffer();
    const audio = [...new Uint8Array(buffer)];
    const result = await c.env.AI.run("@cf/openai/whisper", { audio });
    return c.json({ ok: true, text: result.text });
  } catch (err) {
    console.error("[transcribe] error:", err);
    return c.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      500
    );
  }
});

export default app;
