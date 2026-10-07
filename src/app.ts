import { Hono } from 'hono';
import type { Config } from './config';
import type { Db } from './db/client';
import { notFound, onError } from './errors';
import { cartsRoutes } from './modules/carts/routes';
import { checkoutRoutes } from './modules/checkout/routes';
import { ordersRoutes } from './modules/orders/routes';
import type { PaymentGateway } from './modules/payments/gateway';
import { productsRoutes } from './modules/products/routes';

export function createApp({ config, gateway, db }: { config: Config; gateway: PaymentGateway; db: Db }) {
  return new Hono()
    .route('/', productsRoutes({ db }))
    .route('/', cartsRoutes({ db }))
    .route('/', checkoutRoutes({ db, gateway, config }))
    .route('/', ordersRoutes({ db }))
    .notFound(notFound)
    .onError(onError);
}
