import { open } from "../schema/blog.schema";

const db = open(":memory:");
db.exec(`INSERT INTO "User" (email, role) VALUES ('sai@example.com', 'Admin')`);

const user = db.userByEmail({ email: "sai@example.com" });
console.log(user?.email ?? "missing", db.draftCount({}), db.publishedPosts({ limit: 5 }).length);
