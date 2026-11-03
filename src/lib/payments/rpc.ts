// All database access for payments goes through Postgres functions (supabase/migrations).
// This tiny interface lets production use Supabase and tests use a real local Postgres with
// the same function names.

export type Rpc = <T = unknown>(fn: string, args?: Record<string, unknown>) => Promise<T>;

interface RpcClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
}

export class RpcError extends Error {
  constructor(public fn: string, public code: string | undefined, message: string) {
    super(`rpc ${fn} failed: ${message}`);
  }
}

/** Never includes arguments in errors: they can hold names and emails. */
export function supabaseRpc(client: RpcClient): Rpc {
  return async <T>(fn: string, args: Record<string, unknown> = {}) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new RpcError(fn, error.code, error.message);
    return data as T;
  };
}
