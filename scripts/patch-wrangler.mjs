/**
 * Nitro regenerates .output/server/wrangler.json on every build, so the Worker
 * name and the custom domain get stamped back in here rather than by hand.
 */
import { readFileSync, writeFileSync } from "node:fs";

const path = ".output/server/wrangler.json";
const config = JSON.parse(readFileSync(path, "utf8"));

config.name = "date-genie";
config.routes = [{ pattern: "date-genie.agent9.dev", custom_domain: true }];
// Keep the workers.dev URL alive too, so the submission has a second working link.
config.workers_dev = true;
// Workers AI: language understanding at the edge, no API key, free tier.
config.ai = { binding: "AI" };

writeFileSync(path, JSON.stringify(config, null, 2));
console.log(`patched ${path}: name=${config.name}, domain=${config.routes[0].pattern}`);
