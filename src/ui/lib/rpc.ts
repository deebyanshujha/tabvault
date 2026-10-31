import type { Handlers, Method, RpcResponse } from '../../background/router';

type Params<M extends Method> = Parameters<Handlers[M]['run']>[0];
type Result<M extends Method> = Awaited<ReturnType<Handlers[M]['run']>>;

/** Typed call into the worker. Rejects with a user-readable message. */
export async function rpc<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
  const response = (await chrome.runtime.sendMessage({ kind: 'rpc', method, params })) as RpcResponse | undefined;
  if (!response) throw new Error('TabVault’s background worker did not respond. Try again.');
  if (!response.ok) throw new Error(response.error);
  return response.data as Result<M>;
}
