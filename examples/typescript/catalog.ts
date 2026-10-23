import { open } from "../schema/catalog.schema";

const db = open(":memory:");
db.exec(`INSERT INTO "User" (email, role) VALUES ('sai@example.com', 'Admin')`);
const id = db.insertCatalog({ name: "Tools", owner: 1 });
const catalog = db.catalogs({});
console.log(id, catalog.length, catalog[0]?.name);
