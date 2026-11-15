import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";

// The playground is a static Astro build served as Cloudflare Worker assets.
// Cloudflare allows 25 MiB per asset; the largest file (typescript.js) is ~9 MB.
export default Alchemy.Stack(
  "parlance-playground",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const site = yield* Cloudflare.Website.StaticSite("Playground", {
      command: "pnpm build",
      outdir: "dist",
    });
    return { url: site.url };
  }),
);
