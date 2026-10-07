import { Hono } from 'hono';
import type { Db } from './db/client';
import { notFound, onError } from './errors';
import { cartsRoutes } from './modules/carts/routes';
import { ordersRoutes } from './modules/orders/routes';
import { productsRoutes } from './modules/products/routes';

export function createApp({ db }: { db: Db }) {
  return new Hono()
    .route('/', productsRoutes({ db }))
    .route('/', cartsRoutes({ db }))
    .route('/', ordersRoutes({ db }))
    .notFound(notFound)
    .onError(onError);
}
