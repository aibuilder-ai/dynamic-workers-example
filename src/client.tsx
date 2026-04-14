import "./styles.css";
import { useCallback, useRef, useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
  Button, Surface, Text, Badge, Empty, PoweredByCloudflare,
} from "@cloudflare/kumo";
import {
  PaperPlaneRightIcon, TrashIcon, CoffeeIcon, SpinnerGapIcon,
  MoonIcon, SunIcon, UserIcon, RobotIcon,
} from "@phosphor-icons/react";

type OrderModifier = { group: string; choice: string; price_delta: number };
type OrderItem = {
  product_id: string; product_name: string; base_price: number;
  quantity: number; modifiers: OrderModifier[]; item_total: number; currency: string; error?: string;
};
type Order = { items: OrderItem[]; total: number; currency: string };
type MenuItem = {
  id: number; retailer_id: string; title: string; description: string;
  price: number; currency: string; category: string;
  modifier_groups: { name: string; type: string; modifiers: { name: string; price_delta: number; is_default: boolean }[] }[];
};

type Message =
  | { role: "user"; text: string }
  | { role: "agent"; type: "order"; order: Order }
  | { role: "agent"; type: "menu"; menu: MenuItem[] }
  | { role: "error"; text: string };

const cents = (n: number) => `$${(n / 100).toFixed(2)}`;

const SUGGESTIONS = [
  "Large oat latte",
  "Two flat whites with almond milk",
  "Banana bread, toasted with butter",
  "Avocado toast with poached egg",
  "Almond croissant and a mocha",
  "Show me the menu",
];

function ModeToggle() {
  const [mode, setMode] = useState(() => localStorage.getItem("theme") || "light");
  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);
  return (
    <Button variant="ghost" shape="square" aria-label="Toggle theme"
      onClick={() => setMode((m) => (m === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />} />
  );
}

function OrderView({ order }: { order: Order }) {
  return (
    <div className="space-y-3">
      {order.items.map((item, i) =>
        item.error ? (
          <Surface key={i} className="px-4 py-3 rounded-xl ring ring-red-500/20">
            <Text size="sm" className="text-red-500">{item.error}</Text>
          </Surface>
        ) : (
          <Surface key={i} className="rounded-xl ring ring-kumo-line overflow-hidden">
            <div className="px-4 py-2 border-b border-kumo-line bg-kumo-base flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CoffeeIcon size={14} className="text-kumo-accent" />
                <Text size="sm" bold>{item.product_name}</Text>
                {item.quantity > 1 && <Badge variant="secondary">x{item.quantity}</Badge>}
              </div>
              <Text size="sm" bold className="text-kumo-accent">{cents(item.item_total)}</Text>
            </div>
            <div className="px-4 py-3 space-y-1">
              <div className="flex justify-between">
                <Text size="xs" variant="secondary">Base price</Text>
                <Text size="xs" variant="secondary">{cents(item.base_price)}</Text>
              </div>
              {item.modifiers.map((m, j) => (
                <div key={j} className="flex justify-between">
                  <Text size="xs" variant="secondary">{m.group}: {m.choice}</Text>
                  <Text size="xs" variant="secondary" className={m.price_delta > 0 ? "text-kumo-accent" : ""}>
                    {m.price_delta > 0 ? `+${cents(m.price_delta)}` : "—"}
                  </Text>
                </div>
              ))}
            </div>
          </Surface>
        )
      )}
      <Surface className="px-4 py-3 rounded-xl ring ring-kumo-accent/30 bg-kumo-accent/5">
        <div className="flex justify-between items-center">
          <Text size="sm" bold>Total</Text>
          <Text size="sm" bold className="text-kumo-accent">{cents(order.total)} {order.currency}</Text>
        </div>
      </Surface>
    </div>
  );
}

function MenuView({ menu }: { menu: MenuItem[] }) {
  const categories = [...new Set(menu.map((p) => p.category))];
  return (
    <div className="space-y-4">
      {categories.map((cat) => (
        <div key={cat}>
          <Text size="xs" bold variant="secondary" className="mb-2 block">{cat}</Text>
          <div className="space-y-2">
            {menu.filter((p) => p.category === cat).map((p) => (
              <Surface key={p.id} className="px-4 py-3 rounded-xl ring ring-kumo-line">
                <div className="flex justify-between items-start">
                  <div>
                    <Text size="sm" bold>{p.title}</Text>
                    <Text size="xs" variant="secondary" className="block">{p.description}</Text>
                  </div>
                  <Text size="sm" bold className="text-kumo-accent shrink-0 ml-3">{cents(p.price)}</Text>
                </div>
                {p.modifier_groups.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                    {p.modifier_groups.map((g) => (
                      <Text key={g.name} size="xs" variant="secondary">
                        <span className="font-medium">{g.name}:</span>{" "}
                        {g.modifiers.map((m) => m.name + (m.is_default ? "*" : "") + (m.price_delta ? ` (+${cents(m.price_delta)})` : "")).join(", ")}
                      </Text>
                    ))}
                  </div>
                )}
              </Surface>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, loading]);

  const send = useCallback(async (query: string) => {
    if (!query.trim() || loading) return;
    setMessages((prev) => [...prev, { role: "user", text: query.trim() }]);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch("/api/query", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query.trim() }),
      });
      const data = await res.json<Record<string, unknown>>();
      if (data.ok && data.type === "order" && data.order) {
        setMessages((prev) => [...prev, { role: "agent", type: "order", order: data.order as Order }]);
      } else if (data.ok && data.type === "menu" && data.menu) {
        setMessages((prev) => [...prev, { role: "agent", type: "menu", menu: data.menu as MenuItem[] }]);
      } else {
        setMessages((prev) => [...prev, { role: "error", text: (data.error as string) ?? "Unknown error" }]);
      }
    } catch (err) {
      setMessages((prev) => [...prev, { role: "error", text: err instanceof Error ? err.message : String(err) }]);
    } finally { setLoading(false); }
  }, [loading]);

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-kumo-default">Coffee Shop</h1>
            <Badge variant="secondary"><CoffeeIcon size={12} weight="bold" className="mr-1" />Agent</Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" shape="square" aria-label="Clear chat" onClick={() => setMessages([])} icon={<TrashIcon size={16} />} />
            <ModeToggle />
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-4">
          {messages.length === 0 && !loading && (
            <div className="space-y-5">
              <Empty icon={<CoffeeIcon size={32} />} title="Place an order"
                description="Tell me what you'd like from the menu. I'll build your order with pricing and modifiers." />
              <div className="flex flex-wrap gap-2 justify-center">
                {SUGGESTIONS.map((s) => (
                  <Button key={s} variant="secondary" size="sm" onClick={() => send(s)}>{s}</Button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, i) => {
            if (msg.role === "user") return (
              <div key={i} className="flex justify-end">
                <div className="flex items-start gap-2 max-w-[80%]">
                  <Surface className="px-4 py-3 rounded-2xl rounded-tr-sm bg-kumo-accent/10 ring ring-kumo-accent/20">
                    <Text size="sm">{msg.text}</Text>
                  </Surface>
                  <div className="shrink-0 w-7 h-7 rounded-full bg-kumo-accent/20 flex items-center justify-center mt-0.5">
                    <UserIcon size={14} className="text-kumo-accent" />
                  </div>
                </div>
              </div>
            );
            if (msg.role === "error") return (
              <div key={i} className="flex justify-start">
                <div className="flex items-start gap-2 max-w-[80%]">
                  <div className="shrink-0 w-7 h-7 rounded-full bg-red-500/20 flex items-center justify-center mt-0.5">
                    <RobotIcon size={14} className="text-red-500" />
                  </div>
                  <Surface className="px-4 py-3 rounded-2xl rounded-tl-sm ring ring-red-500/20">
                    <Text size="sm" className="text-red-500">{msg.text}</Text>
                  </Surface>
                </div>
              </div>
            );
            return (
              <div key={i} className="flex justify-start">
                <div className="flex items-start gap-2 max-w-[90%] w-full">
                  <div className="shrink-0 w-7 h-7 rounded-full bg-kumo-accent/20 flex items-center justify-center mt-0.5">
                    <RobotIcon size={14} className="text-kumo-accent" />
                  </div>
                  <div className="flex-1 min-w-0">
                    {msg.type === "order" ? <OrderView order={msg.order} /> : <MenuView menu={msg.menu} />}
                  </div>
                </div>
              </div>
            );
          })}

          {loading && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2">
                <div className="shrink-0 w-7 h-7 rounded-full bg-kumo-accent/20 flex items-center justify-center">
                  <RobotIcon size={14} className="text-kumo-accent" />
                </div>
                <Surface className="px-4 py-3 rounded-2xl rounded-tl-sm ring ring-kumo-line">
                  <div className="flex items-center gap-2">
                    <SpinnerGapIcon size={14} className="text-kumo-accent animate-spin" />
                    <Text size="sm" variant="secondary">Preparing your order...</Text>
                  </div>
                </Surface>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="border-t border-kumo-line bg-kumo-base px-5 py-4">
        <form onSubmit={(e) => { e.preventDefault(); send(input); }}
          className="max-w-3xl mx-auto flex items-center gap-3">
          <input type="text" value={input} onChange={(e) => setInput(e.target.value)}
            placeholder="Order something... e.g. 'Large oat latte'"
            className="flex-1 px-4 py-2.5 rounded-xl bg-kumo-elevated text-kumo-default text-sm border border-kumo-line outline-none focus:ring-2 focus:ring-kumo-accent/40 placeholder:text-kumo-inactive"
            disabled={loading} />
          <Button type="submit" variant="primary" shape="square" disabled={loading || !input.trim()}
            icon={<PaperPlaneRightIcon size={16} weight="fill" />} aria-label="Send" />
        </form>
      </div>

      <footer className="border-t border-kumo-line bg-kumo-base">
        <div className="flex justify-center py-3">
          <PoweredByCloudflare href="https://developers.cloudflare.com/dynamic-workers/" />
        </div>
      </footer>
    </div>
  );
}

const root = document.getElementById("root");
if (root) { createRoot(root).render(<App />); }
