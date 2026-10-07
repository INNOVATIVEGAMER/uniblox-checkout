import { Hono } from 'hono';
import type { Config } from './config';
import type { Db } from './db/client';
import { notFound, onError } from './errors';
import { cartsRoutes } from './modules/carts/routes';
import { checkoutRoutes } from './modules/checkout/routes';
import { couponsRoutes } from './modules/coupons/routes';
import { ordersRoutes } from './modules/orders/routes';
import type { PaymentGateway } from './modules/payments/gateway';
import { paymentsRoutes } from './modules/payments/routes';
import { productsRoutes } from './modules/products/routes';
import { reportRoutes } from './modules/report/routes';

export function createApp({ config, gateway, db }: { config: Config; gateway: PaymentGateway; db: Db }) {
  return new Hono()
    .route('/', productsRoutes({ db }))
    .route('/', cartsRoutes({ db, gateway, config }))
    .route('/', checkoutRoutes({ db, gateway, config }))
    .route('/', ordersRoutes({ db }))
    .route('/', couponsRoutes({ db, config }))
    .route('/', paymentsRoutes({ db, gateway, config }))
    .route('/', reportRoutes({ db, config }))
    .notFound(notFound)
    .onError(onError);
}
