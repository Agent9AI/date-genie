/**
 * `cloudflare:workers` is provided by the Workers runtime, not by node_modules,
 * so TypeScript needs to be told it exists. Declared narrowly: this project only
 * uses it to reach bindings that Nitro's service wrapper does not forward.
 */
declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
}
