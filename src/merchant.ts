import { DurableObject } from "cloudflare:workers";

export class Merchant extends DurableObject {
  private sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        retailer_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        price INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'AUD',
        category TEXT,
        availability TEXT NOT NULL DEFAULT 'in stock'
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS product_modifier_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'option',
        min_select INTEGER NOT NULL DEFAULT 0,
        max_select INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS product_modifiers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL REFERENCES product_modifier_groups(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        price_delta INTEGER NOT NULL DEFAULT 0,
        is_default INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_mod_groups_product ON product_modifier_groups(product_id)`
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_mods_group ON product_modifiers(group_id)`
    );

    const row = [...this.sql.exec("SELECT COUNT(*) as c FROM products")][0] as Record<string, number>;
    if (row.c === 0) {
      this.seed();
    }
  }

  // ── Seed data ────────────────────────────────────────────────

  private seed() {
    const product = (rid: string, title: string, desc: string, price: number, cat: string) => {
      this.sql.exec(
        "INSERT INTO products (retailer_id,title,description,price,category) VALUES (?,?,?,?,?)",
        rid, title, desc, price, cat
      );
      return ([...this.sql.exec("SELECT last_insert_rowid() as id")][0] as Record<string, number>).id;
    };

    const grp = (pid: number, name: string, type: string, min: number, max: number) => {
      this.sql.exec(
        "INSERT INTO product_modifier_groups (product_id,name,type,min_select,max_select) VALUES (?,?,?,?,?)",
        pid, name, type, min, max
      );
      return ([...this.sql.exec("SELECT last_insert_rowid() as id")][0] as Record<string, number>).id;
    };

    const mod = (gid: number, name: string, delta: number, def: boolean) => {
      this.sql.exec(
        "INSERT INTO product_modifiers (group_id,name,price_delta,is_default) VALUES (?,?,?,?)",
        gid, name, delta, def ? 1 : 0
      );
    };

    // Shared helpers for common modifier patterns
    const addSizes = (pid: number) => {
      const g = grp(pid, "Size", "variation", 1, 1);
      mod(g, "Small", 0, true);
      mod(g, "Regular", 50, false);
      mod(g, "Large", 100, false);
    };

    const addMilk = (pid: number) => {
      const g = grp(pid, "Milk", "option", 1, 1);
      mod(g, "Full Cream", 0, true);
      mod(g, "Oat", 70, false);
      mod(g, "Almond", 70, false);
      mod(g, "Soy", 50, false);
    };

    // ── Coffee ─────────────────────────────────────────────────

    const espresso = product("espresso", "Espresso", "Rich double shot of espresso", 400, "Coffee");
    let g = grp(espresso, "Size", "variation", 1, 1);
    mod(g, "Single", 0, true);
    mod(g, "Double", 100, false);

    const latte = product("latte", "Latte", "Smooth espresso with steamed milk", 500, "Coffee");
    addSizes(latte);
    addMilk(latte);

    const capp = product("cappuccino", "Cappuccino", "Espresso with rich foamed milk", 500, "Coffee");
    addSizes(capp);
    addMilk(capp);

    const flatWhite = product("flat-white", "Flat White", "Double shot with velvety microfoam", 500, "Coffee");
    addSizes(flatWhite);
    addMilk(flatWhite);

    const mocha = product("mocha", "Mocha", "Espresso with chocolate and steamed milk", 550, "Coffee");
    addSizes(mocha);
    addMilk(mocha);

    const longBlack = product("long-black", "Long Black", "Double espresso over hot water", 450, "Coffee");
    g = grp(longBlack, "Size", "variation", 1, 1);
    mod(g, "Regular", 0, true);
    mod(g, "Large", 50, false);

    // ── Food ───────────────────────────────────────────────────

    const banana = product("banana-bread", "Banana Bread", "House-baked banana bread slice", 650, "Food");
    g = grp(banana, "Warmed", "option", 1, 1);
    mod(g, "No", 0, true);
    mod(g, "Yes", 0, false);
    g = grp(banana, "Extra", "option", 0, 1);
    mod(g, "None", 0, true);
    mod(g, "Butter", 50, false);

    const avo = product("avo-toast", "Avocado Toast", "Smashed avo on sourdough", 1400, "Food");
    g = grp(avo, "Extra", "option", 0, 2);
    mod(g, "None", 0, true);
    mod(g, "Poached Egg", 300, false);
    mod(g, "Feta", 200, false);

    const muffin = product("blueberry-muffin", "Blueberry Muffin", "Fresh baked blueberry muffin", 550, "Food");
    g = grp(muffin, "Warmed", "option", 1, 1);
    mod(g, "No", 0, true);
    mod(g, "Yes", 0, false);

    const croissant = product("croissant", "Croissant", "Buttery French croissant", 500, "Food");
    g = grp(croissant, "Style", "variation", 1, 1);
    mod(g, "Plain", 0, true);
    mod(g, "Almond", 150, false);
    mod(g, "Chocolate", 100, false);
  }

  // ── Public RPC ───────────────────────────────────────────────

  async getMenu() {
    const products = [...this.sql.exec(
      "SELECT * FROM products WHERE availability = 'in stock' ORDER BY category, title"
    )] as Record<string, unknown>[];

    return products.map((p) => {
      const groups = [...this.sql.exec(
        "SELECT * FROM product_modifier_groups WHERE product_id = ? ORDER BY sort_order, id",
        p.id as number
      )] as Record<string, unknown>[];

      return {
        id: p.id,
        retailer_id: p.retailer_id,
        title: p.title,
        description: p.description,
        price: p.price,
        currency: p.currency,
        category: p.category,
        modifier_groups: groups.map((g) => {
          const mods = [...this.sql.exec(
            "SELECT * FROM product_modifiers WHERE group_id = ? ORDER BY sort_order, id",
            g.id as number
          )] as Record<string, unknown>[];

          return {
            id: g.id,
            name: g.name,
            type: g.type,
            min_select: g.min_select,
            max_select: g.max_select,
            modifiers: mods.map((m) => ({
              id: m.id,
              name: m.name,
              price_delta: m.price_delta,
              is_default: Boolean(m.is_default),
            })),
          };
        }),
      };
    });
  }
}
