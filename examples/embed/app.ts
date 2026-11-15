import { calc, schema } from "./parlance.embeds";

// A schema snippet, keyed "Blog". Hover and completion inside it come from the parlance LSP.
const Blog = schema("Blog")`
schema Blog

enum Role { Member Admin }

model User {
  id: Int @primary @auto
  email: String @unique
  role: Role @default(Member)
}

query userByEmail(email: String): User? =
  User |> where email == email |> first;

insert User { email: $email, role: $role }
`;

const Pricing = calc("Pricing")`
let subtotal = 85 + 40;
let freeShipping = subtotal == 125;
`;

const db = Blog.open(":memory:");
db.insertUser({ email: "sai@example.com", role: "Admin" });
const user = db.userByEmail({ email: "sai@example.com" });
const total: number = Pricing.subtotal;
const free: boolean = Pricing.freeShipping;

console.log(user?.email ?? "missing", user?.role, total, free);
