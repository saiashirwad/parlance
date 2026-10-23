import { open } from "../schema/blog.schema";

const db = open(":memory:");

const userId = db.insertUser({ email: "sai@example.com", role: "Admin" });
const postId = db.insertPost({ title: "First post", status: "Published", authorId: userId });
const updated = db.updatePost({ where: { id: postId }, set: { status: "Draft" } });
const drafts = db.draftCount({});
const deleted = db.deletePost({ id: postId });
const remaining = db.draftCount({});
const user = db.userByEmail({ email: "sai@example.com" });

console.log(
  user?.email ?? "missing",
  drafts,
  deleted,
  remaining,
  userId,
  postId,
  updated,
  db.publishedPosts({ limit: 5 }).length,
);
