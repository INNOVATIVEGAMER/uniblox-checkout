import { Hono } from 'hono';
import type { Db } from './db/client';
import { notFound, onError } from './errors';
import { productsRoutes } from './modules/products/routes';

export function createApp({ db }: { db: Db }) {
  return new Hono().route('/', productsRoutes({ db })).notFound(notFound).onError(onError);
}
